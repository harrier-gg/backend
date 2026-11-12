import { Body, Controller, Get, Inject, Put } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiBody, ApiOkResponse, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { SETTING_KEYS, Subjects, type DiscordBotStatus, type IntegrationSettings, type Reply, type SettingEntry, type SettingKey } from '@harrier-gg/contracts';
import { firstValueFrom, timeout } from 'rxjs';
import { Allow } from './auth/auth.guard';
import { NATS } from './nats';
import { call } from './servers.controllers';

class SettingEntryDto implements SettingEntry {
  @ApiProperty({ enum: SETTING_KEYS }) key!: SettingKey;
  @ApiProperty() secret!: boolean;
  @ApiProperty() set!: boolean;
  @ApiProperty({ type: String, nullable: true, description: 'Never a secret' }) value!: string | null;
  @ApiProperty({ description: 'Set by an environment variable; cannot be changed here' }) fromEnv!: boolean;
}

class BotStatusDto implements DiscordBotStatus {
  @ApiProperty({ enum: ['off', 'connecting', 'online', 'error'] }) state!: DiscordBotStatus['state'];
  @ApiProperty({ type: String, nullable: true }) user!: string | null;
  @ApiProperty({ type: String, nullable: true }) inviteUrl!: string | null;
  @ApiProperty({ type: String, nullable: true }) error!: string | null;
}

class IntegrationSettingsDto implements IntegrationSettings {
  @ApiProperty({ type: [SettingEntryDto] }) settings!: SettingEntryDto[];
  @ApiProperty({ description: 'Whether HARRIER_APP_KEY is set' }) canStoreSecrets!: boolean;
  @ApiProperty() discordRedirectUrl!: string;
  @ApiProperty({ type: BotStatusDto }) bot!: BotStatusDto;
}

class SettingsChangeDto {
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string', nullable: true },
    description: 'A value per setting key; null or "" removes it',
    example: { 'discord.channelId': '1234567890' },
  })
  values!: Partial<Record<SettingKey, string | null>>;
}

/** Integration settings (ADR 0019): owner only. Secrets are only ever written, never read. */
@ApiTags('settings')
@Controller('settings/integrations')
export class SettingsController {
  constructor(@Inject(NATS) private readonly nats: ClientProxy) {}

  @Get()
  @Allow('manageInstance')
  @ApiOkResponse({ type: IntegrationSettingsDto })
  async get(): Promise<IntegrationSettingsDto> {
    return { ...(await call<Omit<IntegrationSettings, 'bot'>>(this.nats, Subjects.settingsList, {})), bot: await this.bot() };
  }

  @Put()
  @Allow('manageInstance')
  @ApiBody({ type: SettingsChangeDto })
  @ApiOkResponse({ type: IntegrationSettingsDto })
  async set(@Body() body: SettingsChangeDto): Promise<IntegrationSettingsDto> {
    const saved = await call<Omit<IntegrationSettings, 'bot'>>(this.nats, Subjects.settingsSet, { values: body?.values ?? {} });
    return { ...saved, bot: await this.bot() };
  }

  private async bot(): Promise<DiscordBotStatus> {
    const reply = await firstValueFrom(this.nats.send<Reply<DiscordBotStatus>>(Subjects.discordStatus, {}).pipe(timeout(2000))).catch(() => null);
    return reply && 'data' in reply ? reply.data : { state: 'off', user: null, inviteUrl: null, error: 'The Discord service is not running' };
  }
}
