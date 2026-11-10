import { z } from 'zod';

// Konfiguration nur über HARRIER_*-Variablen. Falsche Werte → Start bricht mit klarer Meldung ab.
const ConfigSchema = z.object({
  HARRIER_PORT: z.coerce.number().int().positive().default(8080),
  HARRIER_NATS_URL: z.string().url().default('nats://localhost:4222'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Ungültige Konfiguration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
