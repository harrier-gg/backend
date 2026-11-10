import { z } from 'zod';

/** NATS-Subjects. Format: `<service>.<aktion>`. Nur hier definieren, nie als String-Literal im Code. */
export const Subjects = {
  serversHealth: 'servers.health',
} as const;

export const ServiceHealthSchema = z.object({
  service: z.string(),
  status: z.literal('ok'),
  version: z.string(),
});
export type ServiceHealth = z.infer<typeof ServiceHealthSchema>;
