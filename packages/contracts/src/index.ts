import { z } from 'zod';

/** NATS subjects. Format: `<service>.<action>`. Define them only here, never as string literals in code. */
export const Subjects = {
  serversHealth: 'servers.health',
  identityHealth: 'identity.health',
  /** Gateway → servers: is this agent token valid? (ADR 0004) */
  nodesAuthenticate: 'nodes.authenticate',
  nodesList: 'nodes.list',
  nodesCreate: 'nodes.create',
  nodesRemove: 'nodes.remove',
  templatesList: 'templates.list',
  templatesVersions: 'templates.versions',
  serversList: 'servers.list',
  serversGet: 'servers.get',
  serversCreate: 'servers.create',
  serversStart: 'servers.start',
  serversStop: 'servers.stop',
  serversCommand: 'servers.command',
  serversUpdateSettings: 'servers.settings',
  serversReadFile: 'servers.files.read',
  serversWriteFile: 'servers.files.write',
  /** Graph data of one server (ADR 0009). */
  serversMetrics: 'servers.metrics',
  /** Gateway → servers (event): per-minute values of a node's servers. */
  metricsRecord: 'servers.metrics.record',
  /** Servers → gateway: deliver a panel message to a connected agent. */
  agentsSend: 'agents.send',
  /** Servers → gateway: send a request to an agent and wait for its reply (ADR 0011). */
  agentsRequest: 'agents.request',
  /** Gateway → servers (event): an agent reported something the servers service persists. */
  agentsEvent: 'agents.event',
  /** Identity (ADR 0006). */
  identitySetupStatus: 'identity.setupStatus',
  identitySetup: 'identity.setup',
  identityLogin: 'identity.login',
  identityLogout: 'identity.logout',
  identitySession: 'identity.session',
  invitesCreate: 'identity.invites.create',
  invitesList: 'identity.invites.list',
  invitesRevoke: 'identity.invites.revoke',
  invitesCheck: 'identity.invites.check',
  invitesAccept: 'identity.invites.accept',
  usersList: 'identity.users.list',
  usersUpdateRole: 'identity.users.updateRole',
  usersRemove: 'identity.users.remove',
  discordEnabled: 'identity.discord.enabled',
  discordStart: 'identity.discord.start',
  discordCallback: 'identity.discord.callback',
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

export const NodeNameSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
export const CreateNodeSchema = z.object({ name: NodeNameSchema });
export const NodeIdSchema = z.object({ id: z.string().uuid() });

/** Returned once when a node is registered: the agent token is never shown again (ADR 0004). */
export interface NodeCreated {
  node: NodeSummary;
  token: string;
}

/** Text in English and German (ADR 0003); `en` is always present. */
export interface LocalizedText {
  en: string;
  de?: string;
}

export interface TemplateConfigField {
  key: string;
  label: LocalizedText;
  /** `version`: pick from `GET /templates/versions` (ADR 0012). */
  type: 'string' | 'integer' | 'version';
  default: string | number;
  min?: number;
  max?: number;
  pattern?: string;
}

/** Versions of a template's game from its version provider (ADR 0012), newest first. */
export interface GameVersion {
  id: string;
  type: 'release' | 'snapshot';
}
export interface VersionList {
  /** The newest release; what "latest" starts. */
  latest: string;
  versions: GameVersion[];
}
export const TemplateVersionsRequestSchema = z.object({ template: z.string().min(1).max(100) });

export interface TemplateSummary {
  id: string;
  game: { id: string; name: string };
  variant: { id: string; name: string; description?: LocalizedText };
  config: TemplateConfigField[];
  /** Files owners and admins can edit, relative to the server's data directory (ADR 0011). */
  files: { path: string; description?: LocalizedText }[];
}

/** `sleeping`: stopped because nobody was online; joining or starting wakes it (ADR 0013). */
export const ServerStatusSchema = z.enum(['installing', 'starting', 'running', 'stopping', 'stopped', 'crashed', 'sleeping']);
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

/** Values for a template's config fields; the servers service checks them against the template. */
const SettingsSchema = z.record(z.string(), z.union([z.string().max(1000), z.number()]));

export const CreateServerRequestSchema = z.object({
  nodeId: z.string().uuid(),
  name: z.string().regex(/^[A-Za-z0-9 ._-]{1,64}$/),
  templateId: z.string().max(100),
  settings: SettingsSchema.default({}),
});
export type CreateServerRequest = z.infer<typeof CreateServerRequestSchema>;

export const ServerIdSchema = z.object({ id: z.string().uuid() });

/** Config files (ADR 0011): at most 128 KiB, so the text fits one agent message. */
export const FILE_MAX_BYTES = 128 * 1024;
export const ReadFileRequestSchema = ServerIdSchema.extend({ path: z.string().min(1).max(256) });
export const WriteFileRequestSchema = ReadFileRequestSchema.extend({
  content: z.string().refine((s) => Buffer.byteLength(s) <= FILE_MAX_BYTES, 'The file is larger than 128 KiB'),
});
export interface ConfigFile {
  path: string;
  /** null while the file does not exist, e.g. before the first start. */
  content: string | null;
}

/** Changed settings; keys left out keep their value. They apply on the next start. */
export const UpdateSettingsRequestSchema = ServerIdSchema.extend({ settings: SettingsSchema });

export const ServerCommandRequestSchema = z.object({
  id: z.string().uuid(),
  command: z.string().min(1).max(1000),
});

/** Payload of `agents.send`. `message` is a PanelMessage from @harrier-gg/protocol. */
export interface AgentsSendRequest {
  nodeId: string;
  message: unknown;
}
/** Reply to `agents.request`: the agent's `fileResult`, or null if it is offline or did not answer. */
export interface AgentsRequestReply {
  delivered: boolean;
  result: { content: string | null; error: string | null } | null;
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

// ---- History (ADR 0009) ----

export const MetricsRangeSchema = z.enum(['1h', '24h', '7d']);
export type MetricsRange = z.infer<typeof MetricsRangeSchema>;
export const MetricsRequestSchema = z.object({ id: z.string().uuid(), range: MetricsRangeSchema });

/** One minute of a server: average CPU, peak memory, peak players (null without a query). */
const MetricSampleSchema = z.object({
  serverId: z.string().uuid(),
  at: z.iso.datetime(),
  cpuPercent: z.number().min(0).max(100_000),
  memoryBytes: z.number().int().min(0),
  players: z.number().int().min(0).nullable(),
});
export const MetricsRecordSchema = z.object({ nodeId: z.string().uuid(), samples: z.array(MetricSampleSchema).max(256) });
export type MetricsRecord = z.infer<typeof MetricsRecordSchema>;

export interface MetricPoint {
  at: string;
  cpuPercent: number;
  memoryBytes: number;
  players: number | null;
}

// ---- Identity (ADR 0006) ----

export const RoleSchema = z.enum(['owner', 'admin', 'member']);
export type Role = z.infer<typeof RoleSchema>;

export interface UserSummary {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** Display name of the linked Discord account (ADR 0008), or null. */
  discord: string | null;
}

/** Returned on setup and login. The token goes into the session cookie and nowhere else. */
export interface SessionCreated {
  sessionToken: string;
  expiresAt: string;
  user: UserSummary;
}

/** Returned for a valid session. `expiresAt` moves forward when the session was extended. */
export interface SessionInfo {
  user: UserSummary;
  expiresAt: string;
  renewed: boolean;
}

const Email = z.string().trim().toLowerCase().email().max(254);
const Password = z.string().min(10).max(256);

export const SetupRequestSchema = z.object({
  token: z.string().max(100),
  name: z.string().trim().min(1).max(64),
  email: Email,
  password: Password,
});

export const LoginRequestSchema = z.object({
  email: Email,
  password: z.string().max(256),
});

export const SessionTokenSchema = z.object({ sessionToken: z.string().max(100) });

// ---- Roles and invitations (ADR 0007) ----

/** Who acts. The identity service loads the role itself instead of trusting it. */
export const ActorSchema = z.object({ actorId: z.string().uuid() });

export interface InviteSummary {
  id: string;
  role: Role;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

/** Only returned once, right after creating: the link contains the token. */
export interface InviteCreated {
  invite: InviteSummary;
  url: string;
}

export interface UserListEntry extends UserSummary {
  createdAt: string;
}

export const CreateInviteSchema = ActorSchema.extend({ role: z.enum(['admin', 'member']) });
export const InviteIdSchema = ActorSchema.extend({ id: z.string().uuid() });
export const InviteTokenSchema = z.object({ token: z.string().max(100) });
export const AcceptInviteSchema = z.object({
  token: z.string().max(100),
  name: z.string().trim().min(1).max(64),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10).max(256),
});
export const UpdateRoleSchema = ActorSchema.extend({ userId: z.string().uuid(), role: z.enum(['admin', 'member']) });
export const RemoveUserSchema = ActorSchema.extend({ userId: z.string().uuid() });

/**
 * What a role may do (ADR 0007). Shared by gateway and identity service, so both check the same rules.
 */
export const Permissions = {
  viewServers: ['member', 'admin', 'owner'],
  startStopServers: ['member', 'admin', 'owner'],
  sendCommands: ['admin', 'owner'],
  manageServers: ['admin', 'owner'],
  manageMembers: ['admin', 'owner'],
  manageAdmins: ['owner'],
} as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof Permissions;

export function can(role: Role, permission: Permission): boolean {
  return (Permissions[permission] as readonly Role[]).includes(role);
}

// ---- Discord login (ADR 0008) ----

export const DiscordStartSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('login') }),
  z.object({ mode: z.literal('link'), actorId: z.string().uuid() }),
  z.object({ mode: z.literal('invite'), inviteToken: z.string().max(100) }),
]);
export type DiscordStart = z.infer<typeof DiscordStartSchema>;

export const DiscordCallbackSchema = z.object({ state: z.string().max(100), code: z.string().max(500) });

/** Errors the web shows after returning from Discord (`/?auth_error=<code>`). */
export type DiscordError = 'state' | 'not_linked' | 'taken' | 'invite' | 'email' | 'failed';

export type DiscordResult =
  | { session: SessionCreated }
  | { linked: true }
  | { error: DiscordError };
