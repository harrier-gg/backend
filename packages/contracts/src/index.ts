import { z } from 'zod';

/** NATS subjects. Format: `<service>.<action>`. Define them only here, never as string literals in code. */
export const Subjects = {
  serversHealth: 'servers.health',
} as const;

export const ServiceHealthSchema = z.object({
  service: z.string(),
  status: z.literal('ok'),
  version: z.string(),
});
export type ServiceHealth = z.infer<typeof ServiceHealthSchema>;
