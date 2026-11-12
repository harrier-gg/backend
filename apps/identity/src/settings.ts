// Integration settings (ADR 0019): environment variables win; otherwise the database, where
// secrets are encrypted with HARRIER_APP_KEY (AES-256-GCM).
import { SETTING_KEYS, type SettingEntry, type SettingKey } from '@harrier-gg/contracts';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Db } from './db';

/** Injection tokens; here and not in a controller, so controllers can import them without cycles. */
export const SETTINGS = Symbol('SETTINGS');
export const NATS = Symbol('NATS');

interface Definition {
  env: string;
  secret: boolean;
  /** What a valid value looks like; refused otherwise. */
  pattern: RegExp;
}

const SNOWFLAKE = /^[0-9]{5,25}$/;
const TOKEN = /^[A-Za-z0-9._\-$]{10,200}$/;

export const DEFINITIONS: Record<SettingKey, Definition> = {
  'discord.clientId': { env: 'HARRIER_DISCORD_CLIENT_ID', secret: false, pattern: SNOWFLAKE },
  'discord.clientSecret': { env: 'HARRIER_DISCORD_CLIENT_SECRET', secret: true, pattern: TOKEN },
  'discord.botToken': { env: 'HARRIER_DISCORD_BOT_TOKEN', secret: true, pattern: TOKEN },
  'discord.channelId': { env: 'HARRIER_DISCORD_CHANNEL_ID', secret: false, pattern: SNOWFLAKE },
};

/** `v1:` + base64(IV ‖ tag ‖ ciphertext). The key name is authenticated too, so a ciphertext cannot be moved to another key. */
export function encrypt(appKey: Buffer, key: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', appKey, iv);
  cipher.setAAD(Buffer.from(key));
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
}

export function decrypt(appKey: Buffer, key: string, stored: string): string {
  const raw = Buffer.from(stored.replace(/^v1:/, ''), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', appKey, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(key));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

export class Settings {
  private readonly appKey: Buffer | null;

  constructor(
    private readonly db: Db,
    appKey: string | undefined,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    this.appKey = appKey ? Buffer.from(appKey, 'base64') : null;
  }

  get canStoreSecrets(): boolean {
    return this.appKey !== null;
  }

  private fromEnv(key: SettingKey): string | null {
    return this.env[DEFINITIONS[key].env] || null;
  }

  /** The values to use, for this service and for others over NATS. */
  async get(keys: readonly SettingKey[]): Promise<Partial<Record<SettingKey, string>>> {
    const rows = await this.db.setting.findMany({ where: { key: { in: [...keys] } } });
    const values: Partial<Record<SettingKey, string>> = {};
    for (const key of keys) {
      const env = this.fromEnv(key);
      const row = rows.find((r) => r.key === key);
      if (env) values[key] = env;
      else if (row && !row.secret) values[key] = row.value;
      else if (row && this.appKey) {
        try {
          values[key] = decrypt(this.appKey, key, row.value);
        } catch {
          // Another HARRIER_APP_KEY than the one that stored it: treated as not set.
        }
      }
    }
    return values;
  }

  async getOne(key: SettingKey): Promise<string | null> {
    return (await this.get([key]))[key] ?? null;
  }

  /** What the panel shows: never a secret's value. */
  async list(): Promise<SettingEntry[]> {
    const values = await this.get(SETTING_KEYS);
    return SETTING_KEYS.map((key) => {
      const { secret } = DEFINITIONS[key];
      return { key, secret, set: values[key] !== undefined, value: secret ? null : (values[key] ?? null), fromEnv: this.fromEnv(key) !== null };
    });
  }

  /** Sets or (with null or "") removes values. Returns an error message, or null. */
  async set(changes: Partial<Record<SettingKey, string | null>>): Promise<string | null> {
    for (const [key, value] of Object.entries(changes) as [SettingKey, string | null][]) {
      const definition = DEFINITIONS[key];
      if (this.fromEnv(key)) return `${key} is set in the environment (${definition.env}) and cannot be changed here`;
      if (value && !definition.pattern.test(value)) return `${key} does not look right`;
      if (value && definition.secret && !this.appKey) return 'Secrets can only be stored with HARRIER_APP_KEY set';
    }
    for (const [key, value] of Object.entries(changes) as [SettingKey, string | null][]) {
      if (!value) {
        await this.db.setting.deleteMany({ where: { key } });
        continue;
      }
      const { secret } = DEFINITIONS[key];
      const stored = secret ? encrypt(this.appKey!, key, value) : value;
      await this.db.setting.upsert({ where: { key }, create: { key, value: stored, secret }, update: { value: stored, secret } });
    }
    return null;
  }
}
