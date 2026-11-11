// Slash commands and notifications (ADR 0014), without the Discord connection, so they can be
// tested with fakes. main.ts wires them to Discord and NATS.
import { can, type ServerStatus, type ServerSummary, type UserSummary } from '@harrier-gg/contracts';
import { texts } from './texts';

/** What the bot needs from the rest of Harrier. */
export interface Harrier {
  /** The Harrier account linked to a Discord user, or null. */
  userByDiscord(discordId: string): Promise<UserSummary | null>;
  servers(): Promise<ServerSummary[]>;
  /** Resolves to an error message if it failed. */
  start(serverId: string): Promise<string | null>;
  stop(serverId: string): Promise<string | null>;
}

export interface Reply {
  content: string;
  /** Only the caller sees it. */
  ephemeral: boolean;
}

/** German descriptions show up in Discord clients set to German. */
const serverOption = {
  type: 3, // string
  name: 'server',
  description: 'Which server',
  description_localizations: { de: 'Welcher Server' },
  required: true,
  autocomplete: true,
};

/** Registered as global commands when the bot starts. */
export const COMMANDS = [
  {
    name: 'status',
    description: 'Show the game servers and whether they run',
    description_localizations: { de: 'Zeigt die Spielserver und ob sie laufen' },
  },
  {
    name: 'start',
    description: 'Start or wake a game server',
    description_localizations: { de: 'Startet oder weckt einen Spielserver' },
    options: [serverOption],
  },
  {
    name: 'stop',
    description: 'Stop a game server',
    description_localizations: { de: 'Stoppt einen Spielserver' },
    options: [serverOption],
  },
];

const EMOJI: Record<ServerStatus, string> = {
  installing: '🔵',
  starting: '🟡',
  running: '🟢',
  stopping: '🟡',
  stopped: '⚪',
  crashed: '🔴',
  sleeping: '💤',
};

/** Answers a slash command for a Discord user. `server` is an ID (autocomplete) or a typed name. */
export async function command(
  harrier: Harrier,
  name: string,
  call: { discordId: string; locale?: string; server?: string },
): Promise<Reply> {
  const t = texts(call.locale);
  const user = await harrier.userByDiscord(call.discordId);
  if (!user) return { content: t.notLinked, ephemeral: true };

  if (name === 'status') {
    if (!can(user.role, 'viewServers')) return { content: t.notAllowed, ephemeral: true };
    const servers = await harrier.servers();
    if (servers.length === 0) return { content: t.noServers, ephemeral: true };
    const lines = servers.map((s) => `${EMOJI[s.status]} **${s.name}** · ${t.status[s.status]} · ${t.port(s.hostPort)}`);
    return { content: lines.join('\n'), ephemeral: true };
  }

  if (!can(user.role, 'startStopServers')) return { content: t.notAllowed, ephemeral: true };
  const typed = call.server ?? '';
  const server = (await harrier.servers()).find((s) => s.id === typed || s.name.toLowerCase() === typed.toLowerCase());
  if (!server) return { content: t.unknownServer(typed), ephemeral: true };

  if (name === 'start') {
    if (['running', 'starting', 'installing', 'stopping'].includes(server.status)) return { content: t.alreadyRunning(server.name), ephemeral: true };
    const error = await harrier.start(server.id);
    if (error) return { content: t.failed(error), ephemeral: true };
    const said = server.status === 'sleeping' ? t.waking : t.starting;
    return { content: said(user.name, server.name), ephemeral: false };
  }
  if (name === 'stop') {
    if (server.status === 'stopped') return { content: t.alreadyStopped(server.name), ephemeral: true };
    const error = await harrier.stop(server.id);
    if (error) return { content: t.failed(error), ephemeral: true };
    return { content: t.stopping(user.name, server.name), ephemeral: false };
  }
  return { content: t.failed(`/${name}`), ephemeral: true };
}

/** Server names for autocomplete; Discord shows at most 25. */
export async function suggest(harrier: Harrier, typed: string): Promise<{ name: string; value: string }[]> {
  const needle = typed.toLowerCase();
  return (await harrier.servers())
    .filter((s) => s.name.toLowerCase().includes(needle))
    .slice(0, 25)
    .map((s) => ({ name: s.name, value: s.id }));
}

/**
 * Turns status reports into notifications. Only changes it saw happen count, so the reports an
 * agent repeats after reconnecting (or the first ones after the bot started) stay quiet.
 */
export class Notifications {
  private readonly last = new Map<string, ServerStatus>();

  observe(serverId: string, status: ServerStatus, restartPending: boolean): 'online' | 'crashed' | null {
    const previous = this.last.get(serverId);
    this.last.set(serverId, status);
    if (status === 'running' && previous === 'starting') return 'online';
    // A pending restart (ADR 0010) is not the end yet; a crash after the last attempt is.
    if (status === 'crashed' && !restartPending && previous !== undefined && previous !== 'crashed') return 'crashed';
    return null;
  }
}
