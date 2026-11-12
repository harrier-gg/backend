import 'reflect-metadata';
import { Client, GatewayDispatchEvents, InteractionType, MessageFlags, type API } from '@discordjs/core';
import { REST } from '@discordjs/rest';
import { WebSocketManager } from '@discordjs/ws';
import { AgentsEventSchema, Subjects, type DiscordBotStatus, type Reply, type ServerSummary, type SettingKey, type UserSummary } from '@harrier-gg/contracts';
import { Controller, Inject, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClientProxy, ClientProxyFactory, EventPattern, MessagePattern, Payload, Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { z } from 'zod';
import { command, COMMANDS, Notifications, suggest, type Harrier } from './bot';
import { config } from './config';
import { texts } from './texts';
import { VERSION } from './version';

const NATS = Symbol('NATS');
const MANAGER = Symbol('MANAGER');
const log = new Logger('Discord');

/** Never ping anyone: names come from users and servers and could contain @everyone. */
const NO_MENTIONS = { allowed_mentions: { parse: [] } };

/** Asks identity and servers over NATS. */
function harrier(nats: ClientProxy): Harrier {
  const ask = async <T>(subject: string, payload: unknown): Promise<Reply<T>> =>
    firstValueFrom(nats.send<Reply<T>>(subject, payload).pipe(timeout(5000))).catch(() => ({
      error: { status: 503, detail: 'Harrier is not reachable' },
    }));
  return {
    userByDiscord: async (discordId) => {
      const reply = await ask<UserSummary>(Subjects.discordUser, { discordId });
      return 'data' in reply ? reply.data : null;
    },
    servers: async () => {
      const reply = await ask<ServerSummary[]>(Subjects.serversList, {});
      return 'data' in reply ? reply.data : [];
    },
    start: async (id) => {
      const reply = await ask<ServerSummary>(Subjects.serversStart, { id });
      return 'error' in reply ? reply.error.detail : null;
    },
    stop: async (id) => {
      const reply = await ask<ServerSummary>(Subjects.serversStop, { id });
      return 'error' in reply ? reply.error.detail : null;
    },
  };
}

/** A running Discord connection. */
interface Bot {
  api: API;
  /** Where "online" and "crashed" messages go; none without it. */
  channelId: string | null;
  /** The language of the notification channel's Discord server, once known. */
  locale?: string;
  /** The language of whoever used a command last; notifications prefer it. */
  recentLocale?: string;
}

/**
 * The language for notifications: that of whoever used a command last, since Discord only lets
 * community servers choose a preferred language (others always say en-US). Before anyone used a
 * command, the server's preferred language, asked when the first message is due, so a bot invited
 * after it started still finds it.
 */
async function channelLocale(bot: Bot, channelId: string): Promise<string | undefined> {
  if (bot.recentLocale) return bot.recentLocale;
  if (bot.locale) return bot.locale;
  const channel = await bot.api.channels.get(channelId).catch(() => null);
  const guildId = channel && 'guild_id' in channel ? channel.guild_id : undefined;
  if (!guildId) return undefined;
  bot.locale = (await bot.api.guilds.get(guildId).catch(() => null))?.preferred_locale;
  return bot.locale;
}

/**
 * Connects to Discord's gateway (outbound, works behind NAT) and answers slash commands.
 * `ready` is called once logged in, with the bot's name and invite link.
 */
async function connect(
  token: string,
  channelId: string | null,
  harrier: Harrier,
  ready: (user: string, inviteUrl: string) => void,
): Promise<{ bot: Bot; gateway: WebSocketManager }> {
  const rest = new REST({ version: '10' }).setToken(token);
  // No intents: slash commands arrive without any, and the bot reads no messages.
  const gateway = new WebSocketManager({ token, intents: 0, rest });
  const client = new Client({ rest, gateway });
  const bot: Bot = { api: client.api, channelId };

  client.once(GatewayDispatchEvents.Ready, async ({ data }) => {
    await client.api.applicationCommands.bulkOverwriteGlobalCommands(data.application.id, COMMANDS);
    // View Channel + Send Messages, for the notifications.
    const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${data.application.id}&scope=bot+applications.commands&permissions=3072`;
    log.log(`Logged in as ${data.user.username}; commands registered. Invite: ${inviteUrl}`);
    ready(data.user.username, inviteUrl);
    if (bot.channelId && !(await channelLocale(bot, bot.channelId))) {
      log.warn('The bot cannot see its notification channel yet; invite it to that Discord server');
    }
  });

  client.on(GatewayDispatchEvents.InteractionCreate, async ({ data: interaction, api }) => {
    try {
      const discordId = interaction.member?.user.id ?? interaction.user?.id;
      if (!discordId) return;
      if (interaction.type === InteractionType.ApplicationCommandAutocomplete) {
        log.debug(`Autocomplete for /${interaction.data.name} from ${discordId}`);
        const focused = interaction.data.options.find((o) => 'focused' in o && o.focused);
        const typed = focused && 'value' in focused ? String(focused.value) : '';
        // Only linked accounts see server names.
        const choices = (await harrier.userByDiscord(discordId)) ? await suggest(harrier, typed) : [];
        await api.interactions.createAutocompleteResponse(interaction.id, interaction.token, { choices });
        return;
      }
      if (interaction.type !== InteractionType.ApplicationCommand) return;
      log.debug(`/${interaction.data.name} from ${discordId}`);
      bot.recentLocale = interaction.locale;
      // Commands without options (like /status) have no `options` at all.
      const options = 'options' in interaction.data ? interaction.data.options : undefined;
      const server = options?.find((o) => o.name === 'server');
      const call = { discordId, locale: interaction.locale, server: server && 'value' in server ? String(server.value) : undefined };
      // Commands may wait for the agent; deferring gives them 15 minutes instead of 3 seconds.
      // Public by default; an error is then shown to everyone, which is fine for a group of friends.
      const ephemeral = interaction.data.name === 'status';
      await api.interactions.defer(interaction.id, interaction.token, ephemeral ? { flags: MessageFlags.Ephemeral } : {});
      const reply = await command(harrier, interaction.data.name, call);
      await api.interactions.editReply(interaction.application_id, interaction.token, { content: reply.content, ...NO_MENTIONS });
    } catch (error) {
      log.warn(`Interaction failed: ${(error as Error).message}`);
    }
  });

  await gateway.connect();
  return { bot, gateway };
}

/**
 * Starts, stops and reconnects the bot when its settings change (ADR 0019). The service's own
 * environment variables win; otherwise the values set in the panel, asked from identity.
 */
class BotManager {
  bot: Bot | null = null;
  status: DiscordBotStatus = { state: 'off', user: null, inviteUrl: null, error: null };
  private gateway: WebSocketManager | null = null;
  private token: string | null = null;
  /** Reloads run one after another. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly nats: ClientProxy) {}

  reload(): Promise<void> {
    this.queue = this.queue.then(() => this.apply()).catch((e: Error) => log.warn(`Reloading the bot failed: ${e.message}`));
    return this.queue;
  }

  /** Values from identity; null while it cannot be asked (then tried again shortly). */
  private async settings(): Promise<Partial<Record<SettingKey, string>> | null> {
    const keys: SettingKey[] = ['discord.botToken', 'discord.channelId'];
    const reply = await firstValueFrom(this.nats.send<Reply<Partial<Record<SettingKey, string>>>>(Subjects.settingsGet, { keys }).pipe(timeout(5000))).catch(() => null);
    return reply && 'data' in reply ? reply.data : null;
  }

  private async apply() {
    const stored = await this.settings();
    if (!stored && !config.HARRIER_DISCORD_BOT_TOKEN) {
      setTimeout(() => void this.reload(), 10_000); // identity not up yet
      return;
    }
    const token = config.HARRIER_DISCORD_BOT_TOKEN ?? stored?.['discord.botToken'] ?? null;
    const channelId = config.HARRIER_DISCORD_CHANNEL_ID ?? stored?.['discord.channelId'] ?? null;
    if (token === this.token && this.bot) {
      this.bot.channelId = channelId; // same bot, maybe another channel
      this.bot.locale = undefined;
      return;
    }
    await this.gateway?.destroy();
    this.gateway = null;
    this.bot = null;
    this.token = token;
    if (!token) {
      this.status = { state: 'off', user: null, inviteUrl: null, error: null };
      log.log('No bot token; the bot is off');
      return;
    }
    this.status = { state: 'connecting', user: null, inviteUrl: null, error: null };
    try {
      const connected = await connect(token, channelId, harrier(this.nats), (user, inviteUrl) => {
        this.status = { state: 'online', user, inviteUrl, error: null };
      });
      this.bot = connected.bot;
      this.gateway = connected.gateway;
    } catch (error) {
      this.status = { state: 'error', user: null, inviteUrl: null, error: (error as Error).message };
      log.warn(`The bot could not connect: ${(error as Error).message}`);
    }
  }
}

// The full agent message carries `restart` (ADR 0010), which the shared schema leaves out.
const StateEventSchema = AgentsEventSchema.extend({
  message: AgentsEventSchema.shape.message.extend({ restart: z.unknown().optional() }),
});

/** Status reports from agents → "online" and "crashed" messages in the configured channel. */
@Controller()
class NotificationsController {
  private readonly notifications = new Notifications();

  constructor(
    @Inject(NATS) private readonly nats: ClientProxy,
    @Inject(MANAGER) private readonly manager: BotManager,
  ) {}

  @EventPattern(Subjects.agentsEvent)
  async onAgentEvent(@Payload() payload: unknown) {
    const event = StateEventSchema.safeParse(payload);
    if (!event.success) return;
    const { serverId, status, message, restart } = event.data.message;
    const kind = this.notifications.observe(serverId, status, !!restart);
    const bot = this.manager.bot;
    const channel = bot?.channelId;
    if (!kind || !bot || !channel) return;

    const reply = await firstValueFrom(this.nats.send<Reply<ServerSummary>>(Subjects.serversGet, { id: serverId }).pipe(timeout(5000))).catch(() => null);
    if (!reply || !('data' in reply)) return;
    const t = texts(await channelLocale(bot, channel));
    const content = kind === 'online' ? t.online(reply.data.name, reply.data.hostPort) : t.crashed(reply.data.name, message ?? t.status.crashed);
    await bot.api.channels.createMessage(channel, { content, ...NO_MENTIONS }).catch((e: Error) => log.warn(`Notification failed: ${e.message}`));
  }
}

/** The bot's state for the integrations page, and reloading when its settings change. */
@Controller()
class BotController {
  constructor(@Inject(MANAGER) private readonly manager: BotManager) {}

  @MessagePattern(Subjects.discordStatus)
  status(): Reply<DiscordBotStatus> {
    return { data: this.manager.status };
  }

  @EventPattern(Subjects.settingsChanged)
  onSettingsChanged(@Payload() payload: { keys?: string[] }) {
    if (payload?.keys?.some((k) => k.startsWith('discord.bot') || k === 'discord.channelId')) void this.manager.reload();
  }
}

async function bootstrap() {
  const nats = ClientProxyFactory.create({ transport: Transport.NATS, options: { servers: [config.HARRIER_NATS_URL] } });
  const manager = new BotManager(nats);

  @Module({
    controllers: [NotificationsController, BotController],
    providers: [
      { provide: NATS, useValue: nats },
      { provide: MANAGER, useValue: manager },
    ],
  })
  class AppModule {}

  // Its own queue group: identity and servers get the same events in theirs.
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.NATS,
    options: { servers: [config.HARRIER_NATS_URL], queue: 'discord' },
  });
  app.enableShutdownHooks();
  await app.listen();
  log.log(`Harrier Discord v${VERSION} listening on NATS ${config.HARRIER_NATS_URL}`);
  await manager.reload();
}

void bootstrap();
