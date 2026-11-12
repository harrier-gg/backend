import { z } from 'zod';

const ConfigSchema = z.object({
  HARRIER_NATS_URL: z.string().url().default('nats://localhost:4222'),
  // Default only for local development (compose.dev.yaml).
  HARRIER_DATABASE_URL: z.string().default('postgresql://harrier:harrier@localhost:5433/harrier'),
  /** Address users open in the browser; used for the setup link. */
  HARRIER_PUBLIC_URL: z.string().url().default('http://localhost:5173'),
  /** Discord login (ADR 0008); off unless both are set. */
  HARRIER_DISCORD_CLIENT_ID: z.string().optional(),
  HARRIER_DISCORD_CLIENT_SECRET: z.string().optional(),
  /** Encrypts stored secrets (ADR 0019): 32 random bytes, base64 (`openssl rand -base64 32`). */
  HARRIER_APP_KEY: z
    .string()
    .refine((k) => Buffer.from(k, 'base64').length === 32, '32 bytes, base64-encoded (openssl rand -base64 32)')
    .optional(),
  /** Integrations set in the environment win over the panel (ADR 0019). */
  HARRIER_DISCORD_BOT_TOKEN: z.string().optional(),
  HARRIER_DISCORD_CHANNEL_ID: z.string().optional(),
  /** Only changed for tests against a local mock. */
  HARRIER_DISCORD_API_URL: z.string().url().default('https://discord.com/api'),
  HARRIER_DISCORD_AUTHORIZE_URL: z.string().url().default('https://discord.com/oauth2/authorize'),
});

export const config = (() => {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  return result.data;
})();
