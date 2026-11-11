import { z } from 'zod';

/** NATS subjects. Format: `<service>.<action>`. Define them only here, never as string literals in code. */
export const Subjects = {
  serversHealth: 'servers.health',
  /** Gateway → servers: is this agent token valid? (ADR 0004) */
  nodesAuthenticate: 'nodes.authenticate',
  nodesList: 'nodes.list',
  templatesList: 'templates.list',
  serversList: 'servers.list',
  serversGet: 'servers.get',
  serversCreate: 'servers.create',
  serversStart: 'servers.start',
  serversStop: 'servers.stop',
  serversCommand: 'servers.command',
  /** Servers → gateway: deliver a panel message to a connected agent. */
  agentsSend: 'agents.send',
  /** Gateway → servers (event): an agent reported something the servers service persists. */
  agentsEvent: 'agents.event',
} as const;

/**
 * Replies of request/reply subjects are either data or an error with an HTTP-like status, so the
 * gateway can map them 1:1 to problem details (RFC 9457) without guessing.
 */
export type Reply<T> = { data: T } | { error: { status: number; detail: string } };

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

export interface NodeSummary {
  id: string;
  name: string;
  lastSeenAt: string | null;
}

/** Text in English and German (ADR 0003); `en` is always present. */
export interface LocalizedText {
  en: string;
  de?: string;
}

export interface TemplateConfigField {
  key: string;
  label: LocalizedText;
  type: 'string' | 'integer';
  default: string | number;
  min?: number;
  max?: number;
  pattern?: string;
}

export interface TemplateSummary {
  id: string;
  game: { id: string; name: string };
  variant: { id: string; name: string; description?: LocalizedText };
  config: TemplateConfigField[];
}

export const ServerStatusSchema = z.enum(['installing', 'starting', 'running', 'stopping', 'stopped', 'crashed']);
export type ServerStatus = z.infer<typeof ServerStatusSchema>;

export interface ServerSummary {
  id: string;
  name: string;
  nodeId: string;
  templateId: string;
  settings: Record<string, string | number>;
  /** Address players connect to: the node's host plus this port. */
  hostPort: number;
  status: ServerStatus;
  statusMessage: string | null;
  createdAt: string;
}

export const CreateServerRequestSchema = z.object({
  nodeId: z.string().uuid(),
  name: z.string().regex(/^[A-Za-z0-9 ._-]{1,64}$/),
  templateId: z.string().max(100),
  settings: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
});
export type CreateServerRequest = z.infer<typeof CreateServerRequestSchema>;

export const ServerIdSchema = z.object({ id: z.string().uuid() });

export const ServerCommandRequestSchema = z.object({
  id: z.string().uuid(),
  command: z.string().min(1).max(1000),
});

/** Payload of `agents.send`. `message` is a PanelMessage from @harrier-gg/protocol. */
export interface AgentsSendRequest {
  nodeId: string;
  message: unknown;
}
export interface AgentsSendReply {
  delivered: boolean;
}

/** Payload of `agents.event`. Only messages the servers service persists (serverState). */
export const AgentsEventSchema = z.object({
  nodeId: z.string(),
  message: z.object({
    type: z.literal('serverState'),
    serverId: z.string(),
    status: ServerStatusSchema,
    message: z.string().max(2000).nullable().optional(),
  }),
});
export type AgentsEvent = z.infer<typeof AgentsEventSchema>;
