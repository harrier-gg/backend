import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Subjects, type Reply, type ServerStatus, type ServerSummary } from '@harrier-gg/contracts';
import type { ServerStats } from '@harrier-gg/protocol';
import type { IncomingMessage } from 'node:http';
import { firstValueFrom, timeout } from 'rxjs';
import { WebSocket, WebSocketServer } from 'ws';
import { NATS } from './nats';

/** Browser WebSocket for one server's live console: `/api/v1/servers/<id>/console`. */
export const CONSOLE_WS_PATH = /^\/api\/v1\/servers\/([0-9a-f-]{36})\/console$/;
// ponytail: 64 KB of recent output per server, in memory of this gateway; persistent logs later
const BUFFER_BYTES = 64 * 1024;

interface Channel {
  output: string;
  status?: { status: ServerStatus; message: string | null };
  stats?: Omit<ServerStats, 'serverId'>;
  browsers: Set<WebSocket>;
}

/** Messages to the browser. */
export type ConsoleEvent =
  | { type: 'snapshot'; output: string; status: ServerStatus; message: string | null; stats: Channel['stats'] | null }
  | { type: 'output'; data: string }
  | { type: 'status'; status: ServerStatus; message: string | null }
  | { type: 'stats'; cpuPercent: number; memoryBytes: number; memoryLimitBytes: number };

/**
 * Collects console output, status and stats that agents report, and fans them out to browsers.
 * Channels are keyed by node and server, so an agent can only ever feed its own servers' consoles.
 */
@Injectable()
export class ConsoleHub {
  private readonly logger = new Logger(ConsoleHub.name);
  private readonly channels = new Map<string, Channel>();
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });

  constructor(@Inject(NATS) private readonly nats: ClientProxy) {
    this.wss.on('connection', (socket, req) => void this.accept(socket, req));
  }

  private channel(nodeId: string, serverId: string): Channel {
    const key = `${nodeId}:${serverId}`;
    let channel = this.channels.get(key);
    if (!channel) this.channels.set(key, (channel = { output: '', browsers: new Set() }));
    return channel;
  }

  private broadcast(channel: Channel, event: ConsoleEvent) {
    const data = JSON.stringify(event);
    for (const browser of channel.browsers) browser.send(data);
  }

  output(nodeId: string, serverId: string, data: string) {
    const channel = this.channel(nodeId, serverId);
    channel.output = (channel.output + data).slice(-BUFFER_BYTES);
    this.broadcast(channel, { type: 'output', data });
  }

  status(nodeId: string, serverId: string, status: ServerStatus, message: string | null) {
    const channel = this.channel(nodeId, serverId);
    channel.status = { status, message };
    if (status !== 'running') channel.stats = undefined;
    this.broadcast(channel, { type: 'status', status, message });
  }

  stats(nodeId: string, serverId: string, stats: Omit<ServerStats, 'serverId'>) {
    const channel = this.channel(nodeId, serverId);
    channel.stats = stats;
    this.broadcast(channel, { type: 'stats', ...stats });
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

  private async accept(socket: WebSocket, req: IncomingMessage) {
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
    channel.browsers.add(socket);
    socket.send(
      JSON.stringify({
        type: 'snapshot',
        output: channel.output,
        status: channel.status?.status ?? server.status,
        message: channel.status?.message ?? server.statusMessage,
        stats: channel.stats ?? null,
      } satisfies ConsoleEvent),
    );

    socket.on('message', (raw) => {
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
