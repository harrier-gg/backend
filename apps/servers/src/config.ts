import { z } from 'zod';

const ConfigSchema = z.object({
  HARRIER_NATS_URL: z.string().url().default('nats://localhost:4222'),
  // Default only for local development (compose.dev.yaml).
  HARRIER_DATABASE_URL: z.string().default('postgresql://harrier:harrier@localhost:5433/harrier'),
  // Index of the templates repository (ADR 0021); `file://…/index.json` for a local checkout.
  HARRIER_TEMPLATES_URL: z.string().url().default('https://raw.githubusercontent.com/harrier-gg/templates/main/index.json'),
});

export const config = (() => {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  return result.data;
})();
