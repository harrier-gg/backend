import { z } from 'zod';

// Configuration via HARRIER_* variables only. Invalid values stop the start with a clear message.
const ConfigSchema = z.object({
  HARRIER_PORT: z.coerce.number().int().positive().default(8080),
  // Defaults to localhost: until login (M2) and agent tokens (M1) exist, the gateway must not be reachable from the network.
  HARRIER_HOST: z.string().default('127.0.0.1'),
  HARRIER_NATS_URL: z.string().url().default('nats://localhost:4222'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
