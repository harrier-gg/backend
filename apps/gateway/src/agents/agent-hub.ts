import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ClientProxy } from '@nestjs/microservices';
import { Subjects, type AuthenticateNodeReply } from '@harrier-gg/contracts';
import type { Hello } from '@harrier-gg/protocol';
import type { IncomingMessage, Server } from 'node:http';
import { firstValueFrom, timeout } from 'rxjs';
import { WebSocket, WebSocketServer } from 'ws';
import { NATS } from '../nats';
import { answerHello } from './handshake';

export const AGENT_WS_PATH = '/agent/ws';
const HELLO_TIMEOUT_MS = 10_000;
const AUTH_TIMEOUT_MS = 3_000;
const MAX_MESSAGE_BYTES = 16 * 1024;
// ponytail: fixed cap against connection floods; per-credential limits once there are many nodes
const MAX_AGENTS = 256;

export interface ConnectedAgent extends Hello {
  /** Node ID from the agent token (ADR 0004), not chosen by the agent. */
  id: string;
  name: string;
  connectedAt: string;
}

type Node = NonNullable<AuthenticateNodeReply['node']>;

/** Extracts the token from an `Authorization: Bearer …` header. */
export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer ([^\s]{1,200})$/.exec(header ?? '');
  return match ? match[1] : null;
}

/**
 * Holds the agents' WebSocket connections. Agents always connect on their own (outbound),
 * so the agent's host needs neither open ports nor a certificate. Every connection is
 * authenticated with the node's agent token before the upgrade completes (ADR 0004).
 */
@Injectable()
export class AgentHub implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AgentHub.name);
  private readonly agents = new Map<string, { info: ConnectedAgent; socket: WebSocket }>();
  private readonly nodeOf = new WeakMap<IncomingMessage, Node>();
  private wss?: WebSocketServer;

  constructor(
    private readonly http: HttpAdapterHost,
    @Inject(NATS) private readonly nats: ClientProxy,
  ) {}

  list(): ConnectedAgent[] {
    return [...this.agents.values()].map((a) => a.info);
  }

  onApplicationBootstrap() {
    const server: Server = this.http.httpAdapter.getHttpServer();
    this.wss = new WebSocketServer({
      server,
      path: AGENT_WS_PATH,
      maxPayload: MAX_MESSAGE_BYTES,
      verifyClient: (info: { req: IncomingMessage }, done: (ok: boolean, code?: number, message?: string) => void) => {
        void this.verify(info.req).then((ok) => (ok ? done(true) : done(false, 401, 'Unauthorized')));
      },
    });
    this.wss.on('connection', (socket, req) => this.accept(socket, this.nodeOf.get(req)!));
  }

  onApplicationShutdown() {
    for (const { socket } of this.agents.values()) socket.close(1001, 'Panel shutting down');
    this.wss?.close();
  }

  private async verify(req: IncomingMessage): Promise<boolean> {
    // Browsers always send an Origin header, the agent never does. This way no foreign website
    // can pose as an agent through the user's browser (cross-site WebSocket hijacking).
    if (req.headers.origin !== undefined) return false;
    if (this.wss!.clients.size >= MAX_AGENTS) return false;

    const token = bearerToken(req.headers.authorization);
    if (!token) return false;

    try {
      const { node } = await firstValueFrom(
        this.nats.send<AuthenticateNodeReply>(Subjects.nodesAuthenticate, { token }).pipe(timeout(AUTH_TIMEOUT_MS)),
      );
      if (!node) {
        this.logger.warn(`Agent rejected: invalid token (from ${req.socket.remoteAddress})`);
        return false;
      }
      this.nodeOf.set(req, node);
      return true;
    } catch (error) {
      this.logger.error(`Agent authentication failed: servers service unreachable (${String(error)})`);
      return false;
    }
  }

  private accept(socket: WebSocket, node: Node) {
    const timer = setTimeout(() => socket.close(4000, 'No hello received'), HELLO_TIMEOUT_MS);

    socket.once('message', (data) => {
      clearTimeout(timer);
      const result = answerHello(data.toString(), node.id);
      socket.send(JSON.stringify(result.reply));

      if (!result.accepted) {
        this.logger.warn(`Agent "${node.name}" rejected: ${result.reply.type === 'reject' ? result.reply.reason : ''}`);
        socket.close(4001, 'Handshake rejected');
        return;
      }

      // One connection per node: a new connection replaces the old one (ADR 0004).
      const previous = this.agents.get(node.id);
      if (previous) previous.socket.close(4002, 'Replaced by a new connection');

      const info: ConnectedAgent = { ...result.hello, id: node.id, name: node.name, connectedAt: new Date().toISOString() };
      this.agents.set(node.id, { info, socket });
      this.logger.log(
        `Agent connected: ${node.name} on ${info.hostname} (${info.os}/${info.arch}, v${info.agentVersion}, protocol ${info.protocol})`,
      );

      socket.on('close', () => {
        // Only remove the entry if it still belongs to this socket (not to a replacing connection).
        if (this.agents.get(node.id)?.socket === socket) this.agents.delete(node.id);
        this.logger.log(`Agent disconnected: ${node.name}`);
      });
    });
  }
}
