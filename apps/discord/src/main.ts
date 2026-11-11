import 'reflect-metadata';
import { Client, GatewayDispatchEvents, InteractionType, MessageFlags, type API } from '@discordjs/core';
import { REST } from '@discordjs/rest';
import { WebSocketManager } from '@discordjs/ws';
import { AgentsEventSchema, Subjects, type Reply, type ServerSummary, type UserSummary } from '@harrier-gg/contracts';
import { Controller, Inject, Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ClientProxy, ClientProxyFactory, EventPattern, Payload, Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { z } from 'zod';
import { command, COMMANDS, Notifications, suggest, type Harrier } from './bot';
import { config } from './config';
import { texts } from './texts';
import { VERSION } from './version';

const NATS = Symbol('NATS');
const BOT = Symbol('BOT');
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

/** The Discord connection; null while no bot token is configured. */
interface Bot {
  api: API;
  /** The language of the notification channel's Discord server. */
  locale?: string;
}

/** Connects to Discord's gateway (outbound, works behind NAT) and answers slash commands. */
async function connect(token: string, harrier: Harrier): Promise<Bot> {
  const rest = new REST({ version: '10' }).setToken(token);
  // No intents: slash commands arrive without any, and the bot reads no messages.
  const gateway = new WebSocketManager({ token, intents: 0, rest });
  const client = new Client({ rest, gateway });
  const bot: Bot = { api: client.api };

  client.once(GatewayDispatchEvents.Ready, async ({ data }) => {
    await client.api.applicationCommands.bulkOverwriteGlobalCommands(data.application.id, COMMANDS);
    log.log(`Logged in as ${data.user.username}; commands registered`);
    log.log(`Invite: https://discord.com/oauth2/authorize?client_id=${data.application.id}&scope=bot+applications.commands&permissions=3072`);
    if (config.HARRIER_DISCORD_CHANNEL_ID) {
      const channel = await client.api.channels.get(config.HARRIER_DISCORD_CHANNEL_ID).catch(() => null);
      const guildId = channel && 'guild_id' in channel ? channel.guild_id : undefined;
      if (!guildId) log.warn('HARRIER_DISCORD_CHANNEL_ID is not a channel the bot can see; no notifications');
      else bot.locale = (await client.api.guilds.get(guildId)).preferred_locale;
    }
  });

  client.on(GatewayDispatchEvents.InteractionCreate, async ({ data: interaction, api }) => {
    try {
      const discordId = interaction.member?.user.id ?? interaction.user?.id;
      if (!discordId) return;
      if (interaction.type === InteractionType.ApplicationCommandAutocomplete) {
        const focused = interaction.data.options.find((o) => 'focused' in o && o.focused);
        const typed = focused && 'value' in focused ? String(focused.value) : '';
        // Only linked accounts see server names.
        const choices = (await harrier.userByDiscord(discordId)) ? await suggest(harrier, typed) : [];
        await api.interactions.createAutocompleteResponse(interaction.id, interaction.token, { choices });
        return;
      }
      if (interaction.type !== InteractionType.ApplicationCommand || !('options' in interaction.data)) return;
      const server = interaction.data.options?.find((o) => o.name === 'server');
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
  return bot;
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
    @Inject(BOT) private readonly bot: Bot | null,
  ) {}

  @EventPattern(Subjects.agentsEvent)
  async onAgentEvent(@Payload() payload: unknown) {
    const event = StateEventSchema.safeParse(payload);
    if (!event.success) return;
    const { serverId, status, message, restart } = event.data.message;
    const kind = this.notifications.observe(serverId, status, !!restart);
    const channel = config.HARRIER_DISCORD_CHANNEL_ID;
    if (!kind || !this.bot || !channel) return;

    const reply = await firstValueFrom(this.nats.send<Reply<ServerSummary>>(Subjects.serversGet, { id: serverId }).pipe(timeout(5000))).catch(() => null);
    if (!reply || !('data' in reply)) return;
    const t = texts(this.bot.locale);
    const content = kind === 'online' ? t.online(reply.data.name, reply.data.hostPort) : t.crashed(reply.data.name, message ?? t.status.crashed);
    await this.bot.api.channels.createMessage(channel, { content, ...NO_MENTIONS }).catch((e: Error) => log.warn(`Notification failed: ${e.message}`));
  }
}

async function bootstrap() {
  const nats = ClientProxyFactory.create({ transport: Transport.NATS, options: { servers: [config.HARRIER_NATS_URL] } });
  const token = config.HARRIER_DISCORD_BOT_TOKEN;
  if (!token) {
    log.log(`Harrier Discord v${VERSION}: no HARRIER_DISCORD_BOT_TOKEN, the bot stays off`);
    return;
  }
  const bot = await connect(token, harrier(nats));

  @Module({
    controllers: [NotificationsController],
    providers: [
      { provide: NATS, useValue: nats },
      { provide: BOT, useValue: bot },
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
}

void bootstrap();
