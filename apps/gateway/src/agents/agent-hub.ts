import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Hello } from '@harrier-gg/protocol';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { answerHello } from './handshake';

export const AGENT_WS_PATH = '/agent/ws';
const HELLO_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_BYTES = 16 * 1024;
// ponytail: fixed cap against connection floods; from M1 only agents with a valid token count
const MAX_AGENTS = 256;

export interface ConnectedAgent extends Hello {
  id: string;
  connectedAt: string;
}

/**
 * Holds the agents' WebSocket connections. Agents always connect on their own (outbound),
 * so the agent's host needs neither open ports nor a certificate.
 */
@Injectable()
export class AgentHub implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AgentHub.name);
  private readonly agents = new Map<string, { info: ConnectedAgent; socket: WebSocket }>();
  private wss?: WebSocketServer;

  constructor(private readonly http: HttpAdapterHost) {}

  list(): ConnectedAgent[] {
    return [...this.agents.values()].map((a) => a.info);
  }

  onApplicationBootstrap() {
    const server: Server = this.http.httpAdapter.getHttpServer();
    // TODO(M1): verify the agent token (ADR to follow). Until then the gateway only listens on localhost (HARRIER_HOST).
    this.wss = new WebSocketServer({
      server,
      path: AGENT_WS_PATH,
      maxPayload: MAX_MESSAGE_BYTES,
      // Browsers always send an Origin header, the agent never does. This way no foreign website
      // can pose as an agent through the user's browser (cross-site WebSocket hijacking).
      verifyClient: ({ req }: { req: IncomingMessage }) => req.headers.origin === undefined,
    });
    this.wss.on('connection', (socket) => this.accept(socket));
  }

  onApplicationShutdown() {
    for (const { socket } of this.agents.values()) socket.close(1001, 'Panel shutting down');
    this.wss?.close();
  }

  private accept(socket: WebSocket) {
    if (this.wss!.clients.size > MAX_AGENTS) {
      socket.close(1013, 'Too many connections');
      return;
    }
    const id = randomUUID();
    const timeout = setTimeout(() => socket.close(4000, 'No hello received'), HELLO_TIMEOUT_MS);

    socket.once('message', (data) => {
      clearTimeout(timeout);
      const result = answerHello(data.toString(), id);
      socket.send(JSON.stringify(result.reply));

      if (!result.accepted) {
        this.logger.warn(`Agent rejected: ${result.reply.type === 'reject' ? result.reply.reason : ''}`);
        socket.close(4001, 'Handshake rejected');
        return;
      }

      const info: ConnectedAgent = { id, ...result.hello, connectedAt: new Date().toISOString() };
      this.agents.set(id, { info, socket });
      this.logger.log(`Agent connected: ${info.hostname} (${info.os}/${info.arch}, v${info.agentVersion}, protocol ${info.protocol})`);

      socket.on('close', () => {
        this.agents.delete(id);
        this.logger.log(`Agent disconnected: ${info.hostname}`);
      });
    });
  }
}
