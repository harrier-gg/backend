import { z } from 'zod';

const Snowflake = z.string().regex(/^[0-9]{5,25}$/, 'a Discord ID (numbers only)');

const ConfigSchema = z.object({
  HARRIER_NATS_URL: z.string().url().default('nats://localhost:4222'),
  /** Bot token of the Discord application (ADR 0014); the bot is off without it. */
  HARRIER_DISCORD_BOT_TOKEN: z.string().min(1).optional(),
  /** Channel for "online" and "crashed" messages; none without it. */
  HARRIER_DISCORD_CHANNEL_ID: Snowflake.optional(),
});

export const config = (() => {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  return result.data;
})();
