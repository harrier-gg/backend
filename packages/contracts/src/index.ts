import { z } from 'zod';

/** NATS subjects. Format: `<service>.<action>`. Define them only here, never as string literals in code. */
export const Subjects = {
  serversHealth: 'servers.health',
  /** Gateway → servers: is this agent token valid? (ADR 0004) */
  nodesAuthenticate: 'nodes.authenticate',
} as const;

export const ServiceHealthSchema = z.object({
  service: z.string(),
  status: z.literal('ok'),
  version: z.string(),
});
export type ServiceHealth = z.infer<typeof ServiceHealthSchema>;

export const AuthenticateNodeRequestSchema = z.object({ token: z.string().max(200) });
export type AuthenticateNodeRequest = z.infer<typeof AuthenticateNodeRequestSchema>;

/** `node` is null when the token is invalid or the node does not exist (anymore). */
export const AuthenticateNodeReplySchema = z.object({
  node: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type AuthenticateNodeReply = z.infer<typeof AuthenticateNodeReplySchema>;
