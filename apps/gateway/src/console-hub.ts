import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { can, Subjects, type MetricsRecord, type Reply, type ServerStatus, type ServerSummary, type UserSummary } from '@harrier-gg/contracts';
import type { ServerPlayers, ServerStats } from '@harrier-gg/protocol';
import type { IncomingMessage } from 'node:http';
import { firstValueFrom, timeout } from 'rxjs';
import { WebSocket, WebSocketServer } from 'ws';
import { NATS } from './nats';

/** Browser WebSocket for one server's live console: `/api/v1/servers/<id>/console`. */
export const CONSOLE_WS_PATH = /^\/api\/v1\/servers\/([0-9a-f-]{36})\/console$/;
// ponytail: 64 KB of recent output per server, in memory of this gateway; persistent logs later
const BUFFER_BYTES = 64 * 1024;
// An agent can only feed channels of its own node, but could invent server IDs. Capping channels
// per node bounds the memory a misbehaving agent can use.
// ponytail: fixed cap; verify server IDs against the servers service if nodes get this many servers
const MAX_CHANNELS_PER_NODE = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Players = Omit<ServerPlayers, 'serverId'>;

interface Channel {
  nodeId: string;
  serverId: string;
  output: string;
  status?: { status: ServerStatus; message: string | null };
  stats?: Omit<ServerStats, 'serverId'>;
  players?: Players;
  /** Values of the current minute for the history (ADR 0009). */
  minute?: { cpuSum: number; samples: number; memoryMax: number; playersMax: number | null };
  browsers: Set<WebSocket>;
}

/** Messages to the browser. */
export type ConsoleEvent =
  | { type: 'snapshot'; output: string; status: ServerStatus; message: string | null; stats: Channel['stats'] | null; players: Players | null }
  | { type: 'output'; data: string }
  | { type: 'status'; status: ServerStatus; message: string | null }
  | { type: 'stats'; cpuPercent: number; memoryBytes: number; memoryLimitBytes: number }
  | ({ type: 'players' } & Players);

/**
 * Collects console output, status, stats and players that agents report, and fans them out to
 * browsers. Once a minute it hands condensed values to the servers service for the graphs.
 * Channels are keyed by node and server, so an agent can only ever feed its own servers' consoles.
 */
@Injectable()
export class ConsoleHub implements OnApplicationShutdown {
  private readonly logger = new Logger(ConsoleHub.name);
  private readonly channels = new Map<string, Channel>();
  private readonly perNode = new Map<string, number>();
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });

  private readonly flushTimer = setInterval(() => this.flushMinute(), 60_000);

  constructor(@Inject(NATS) private readonly nats: ClientProxy) {
    this.wss.on('connection', (socket: WebSocket, req: IncomingMessage, user: UserSummary) => void this.accept(socket, req, user));
  }

  onApplicationShutdown() {
    clearInterval(this.flushTimer);
  }

  /** Sends one sample per server that reported stats this minute, grouped by node. */
  flushMinute(now = new Date()) {
    const at = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
    const byNode = new Map<string, MetricsRecord['samples']>();
    for (const channel of this.channels.values()) {
      const minute = channel.minute;
      channel.minute = undefined;
      if (!minute) continue;
      const samples = byNode.get(channel.nodeId) ?? [];
      samples.push({
        serverId: channel.serverId,
        at,
        cpuPercent: Math.round((minute.cpuSum / minute.samples) * 10) / 10,
        memoryBytes: minute.memoryMax,
        players: minute.playersMax,
      });
      byNode.set(channel.nodeId, samples);
    }
    for (const [nodeId, samples] of byNode) this.nats.emit(Subjects.metricsRecord, { nodeId, samples } satisfies MetricsRecord);
  }

  private channel(nodeId: string, serverId: string): Channel | null {
    const key = `${nodeId}:${serverId}`;
    let channel = this.channels.get(key);
    if (!channel) {
      const count = this.perNode.get(nodeId) ?? 0;
      if (!UUID.test(serverId) || count >= MAX_CHANNELS_PER_NODE) return null;
      this.perNode.set(nodeId, count + 1);
      this.channels.set(key, (channel = { nodeId, serverId, output: '', browsers: new Set() }));
    }
    return channel;
  }

  private broadcast(channel: Channel, event: ConsoleEvent) {
    const data = JSON.stringify(event);
    for (const browser of channel.browsers) browser.send(data);
  }

  output(nodeId: string, serverId: string, data: string) {
    const channel = this.channel(nodeId, serverId);
    if (!channel) return;
    channel.output = (channel.output + data).slice(-BUFFER_BYTES);
    this.broadcast(channel, { type: 'output', data });
  }

  status(nodeId: string, serverId: string, status: ServerStatus, message: string | null) {
    const channel = this.channel(nodeId, serverId);
    if (!channel) return;
    channel.status = { status, message };
    if (status !== 'running') {
      channel.stats = undefined;
      channel.players = undefined;
    }
    this.broadcast(channel, { type: 'status', status, message });
  }

  stats(nodeId: string, serverId: string, stats: Omit<ServerStats, 'serverId'>) {
    const channel = this.channel(nodeId, serverId);
    if (!channel) return;
    channel.stats = stats;
    const minute = (channel.minute ??= { cpuSum: 0, samples: 0, memoryMax: 0, playersMax: channel.players?.online ?? null });
    minute.cpuSum += stats.cpuPercent;
    minute.samples++;
    minute.memoryMax = Math.max(minute.memoryMax, stats.memoryBytes);
    this.broadcast(channel, { type: 'stats', ...stats });
  }

  players(nodeId: string, serverId: string, players: Players) {
    const channel = this.channel(nodeId, serverId);
    if (!channel) return;
    channel.players = players;
    if (channel.minute) channel.minute.playersMax = Math.max(channel.minute.playersMax ?? 0, players.online);
    this.broadcast(channel, { type: 'players', ...players });
  }

  /**
   * Same-origin only: the browser must have loaded the panel from the host it connects to.
   * This stops other websites from opening the console with the user's browser (CSWSH).
   */
  static allowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return false;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  private async accept(socket: WebSocket, req: IncomingMessage, user: UserSummary) {
    const serverId = CONSOLE_WS_PATH.exec(new URL(req.url ?? '', 'http://x').pathname)?.[1];
    const reply = await firstValueFrom(
      this.nats.send<Reply<ServerSummary>>(Subjects.serversGet, { id: serverId }).pipe(timeout(3000)),
    ).catch(() => null);
    if (!reply || !('data' in reply)) {
      socket.close(4004, 'Server not found');
      return;
    }
    const server = reply.data;
    const channel = this.channel(server.nodeId, server.id);
    if (!channel) {
      socket.close(1013, 'Too many consoles on this node');
      return;
    }
    channel.browsers.add(socket);
    socket.send(
      JSON.stringify({
        type: 'snapshot',
        output: channel.output,
        status: channel.status?.status ?? server.status,
        message: channel.status?.message ?? server.statusMessage,
        stats: channel.stats ?? null,
        players: channel.players ?? null,
      } satisfies ConsoleEvent),
    );

    socket.on('message', (raw) => {
      // Everyone may watch; only roles with "sendCommands" may type (ADR 0007).
      if (!can(user.role, 'sendCommands')) return;
      let command: unknown;
      try {
        command = (JSON.parse(raw.toString()) as { type?: string; command?: unknown }).command;
      } catch {
        return;
      }
      if (typeof command !== 'string') return;
      void firstValueFrom(this.nats.send(Subjects.serversCommand, { id: server.id, command }).pipe(timeout(3000))).catch(
        (error: unknown) => this.logger.warn(`Console command for ${server.id} failed: ${String(error)}`),
      );
    });
    socket.on('close', () => channel.browsers.delete(socket));
  }
}
