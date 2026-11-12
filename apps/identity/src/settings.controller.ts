import { Controller, Inject, Logger } from '@nestjs/common';
import { ClientProxy, MessagePattern, Payload } from '@nestjs/microservices';
import { SettingsGetSchema, SettingsSetSchema, Subjects, type IntegrationSettings, type Reply, type SettingKey } from '@harrier-gg/contracts';
import { fail } from './identity.controller';
import { redirectUri } from './discord.controller';
import { NATS, SETTINGS, type Settings } from './settings';

/**
 * Integration settings (ADR 0019). The gateway lets only the owner list and set them; `get` is
 * for other services inside the backend and the only way a secret's value leaves identity.
 */
@Controller()
export class SettingsController {
  private readonly logger = new Logger(SettingsController.name);

  constructor(
    @Inject(SETTINGS) private readonly settings: Settings,
    @Inject(NATS) private readonly nats: ClientProxy,
  ) {}

  /** Everything but the bot's state, which the gateway asks the Discord service for. */
  @MessagePattern(Subjects.settingsList)
  async list(): Promise<Reply<Omit<IntegrationSettings, 'bot'>>> {
    return { data: { settings: await this.settings.list(), canStoreSecrets: this.settings.canStoreSecrets, discordRedirectUrl: redirectUri() } };
  }

  @MessagePattern(Subjects.settingsSet)
  async set(@Payload() payload: unknown): Promise<Reply<Omit<IntegrationSettings, 'bot'>>> {
    const request = SettingsSetSchema.safeParse(payload);
    if (!request.success) return fail(400, 'Unknown setting');
    const error = await this.settings.set(request.data.values);
    if (error) return fail(400, error);
    const keys = Object.keys(request.data.values) as SettingKey[];
    this.logger.log(`Settings changed: ${keys.join(', ')}`);
    // Services that use them reload, e.g. the Discord bot reconnects.
    this.nats.emit(Subjects.settingsChanged, { keys });
    return this.list();
  }

  @MessagePattern(Subjects.settingsGet)
  async get(@Payload() payload: unknown): Promise<Reply<Partial<Record<SettingKey, string>>>> {
    const request = SettingsGetSchema.safeParse(payload);
    if (!request.success) return fail(400, 'Unknown setting');
    return { data: await this.settings.get(request.data.keys) };
  }
}
