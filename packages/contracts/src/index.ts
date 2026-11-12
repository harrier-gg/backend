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
  serversListDir: 'servers.files.list',
  serversContentList: 'servers.content.list',
  serversContentSearch: 'servers.content.search',
  serversContentInstall: 'servers.content.install',
  serversContentRemove: 'servers.content.remove',
  serversContentUpdates: 'servers.content.updates',
  serversContentUpdate: 'servers.content.update',
  serversBackups: 'servers.backups',
  serversBackupCreate: 'servers.backups.create',
  serversBackupDelete: 'servers.backups.delete',
  serversBackupRestore: 'servers.backups.restore',
  serversBackupSchedule: 'servers.backups.schedule',
  serversDeletePath: 'servers.files.delete',
  serversMakeDir: 'servers.files.mkdir',
  serversMovePath: 'servers.files.move',
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
  /** Gateway → servers (event): an agent finished a backup or restore (ADR 0016). */
  agentsBackup: 'agents.backup',
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
  /** Discord bot → identity: the account linked to a Discord user (ADR 0014). */
  discordUser: 'identity.discord.user',
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
  /** Kinds of content that can be installed, with the providers to search (ADR 0017). */
  content: { kind: string; label: LocalizedText; path: string; sources: string[] }[];
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
/** A path inside a server's data directory, like `world/level.dat`. The agent checks it again. */
export const FilePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => p.split('/').every((part) => part !== '' && part !== '.' && part !== '..'), 'Invalid path');
export const ReadFileRequestSchema = ServerIdSchema.extend({ path: FilePathSchema });
/** `path` "" is the data directory itself. */
export const ListDirRequestSchema = ServerIdSchema.extend({ path: z.union([z.literal(''), FilePathSchema]) });
export const MovePathRequestSchema = ServerIdSchema.extend({ from: FilePathSchema, to: FilePathSchema });

// ---- Content: mods, plugins, … (ADR 0017) ----

/** Where content is needed: on the server, by the players, or both. */
export type ContentSide = 'server' | 'client' | 'both';

export interface ContentProject {
  id: string;
  name: string;
  summary: string;
  author: string;
  downloads: number;
  iconUrl: string | null;
  pageUrl: string;
  side: ContentSide | null;
}

export interface InstalledContent {
  id: string;
  kind: string;
  provider: string;
  projectId: string;
  name: string;
  version: string;
  /** Relative to the server's data directory. */
  path: string;
  side: ContentSide | null;
  /** Installed because another project needs it. */
  dependency: boolean;
  installedAt: string;
}

const ContentRef = ServerIdSchema.extend({ kind: z.string().regex(/^[a-z][a-z-]{0,39}$/), source: z.string().regex(/^[a-z][a-z-]{0,39}$/) });
export const ContentSearchSchema = ContentRef.extend({ query: z.string().max(100).default('') });
export const ContentInstallSchema = ContentRef.extend({ projectId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });
export const ContentRemoveSchema = ServerIdSchema.extend({ contentId: z.string().uuid() });

/** Installed content with a newer fitting version, or none that fits the server any more. */
export interface ContentUpdate {
  contentId: string;
  /** The newer version; null if nothing fits the server's game version (`incompatible`). */
  version: string | null;
  incompatible: boolean;
}

// ---- Backups (ADR 0016) ----

/** Names the agent gives backups: `<unix seconds>[-before-restore].tar.gz`. */
export const BackupNameSchema = z.string().regex(/^[0-9]{1,20}(-before-restore)?\.tar\.gz$/);
export const BackupRefSchema = ServerIdSchema.extend({ name: BackupNameSchema });
export const BackupScheduleSchema = ServerIdSchema.extend({
  /** 0 = only by hand; at most once a week. */
  everyHours: z.number().int().min(0).max(168),
  keep: z.number().int().min(1).max(100),
});
export const BackupResultEventSchema = z.object({
  nodeId: z.string().uuid(),
  message: z.object({
    type: z.literal('backupResult'),
    serverId: z.string().uuid(),
    action: z.enum(['create', 'restore']),
    name: z.string().max(100).nullable().optional(),
    error: z.string().max(500).nullable().optional(),
  }),
});

export interface BackupsSummary {
  everyHours: number;
  keep: number;
  lastBackupAt: string | null;
  /** A backup or restore the agent is working on right now. */
  inProgress: 'create' | 'restore' | null;
  /** How the last backup or restore since the panel started ended; null if none or fine. */
  lastError: string | null;
  /** Newest first; null while the node is offline. */
  backups: FileEntry[] | null;
}
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
  /** `agents.request` only: how long to wait for the reply (default 10 s, at most 5 min). */
  timeoutMs?: number;
}
/** Reply to `agents.request`: the agent's `fileResult`, or null if it is offline or did not answer. */
export interface AgentsRequestReply {
  delivered: boolean;
  result: { content: string | null; error: string | null; entries: FileEntry[] | null } | null;
}

/** One entry of a directory listing (ADR 0015). */
export interface FileEntry {
  name: string;
  kind: 'file' | 'dir' | 'other';
  size: number;
  /** Last change, seconds since 1970. */
  modified: number | null;
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
export const DiscordUserRequestSchema = z.object({ discordId: z.string().regex(/^[0-9]{5,25}$/) });

/** Errors the web shows after returning from Discord (`/?auth_error=<code>`). */
export type DiscordError = 'state' | 'not_linked' | 'taken' | 'invite' | 'email' | 'failed';

export type DiscordResult =
  | { session: SessionCreated }
  | { linked: true }
  | { error: DiscordError };
