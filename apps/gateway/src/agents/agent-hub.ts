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
// ponytail: feste Obergrenze gegen Verbindungsfluten; ab M1 zählen nur noch Agents mit gültigem Token
const MAX_AGENTS = 256;

export interface ConnectedAgent extends Hello {
  id: string;
  connectedAt: string;
}

/**
 * Hält die WebSocket-Verbindungen der Agents. Agents verbinden sich immer von sich aus (ausgehend),
 * deshalb braucht der Host des Agents weder offene Ports noch ein Zertifikat.
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
    // TODO(M1): Agent-Token prüfen (ADR folgt). Bis dahin lauscht das Gateway nur auf localhost (HARRIER_HOST).
    this.wss = new WebSocketServer({
      server,
      path: AGENT_WS_PATH,
      maxPayload: MAX_MESSAGE_BYTES,
      // Browser senden immer einen Origin-Header, der Agent nie. So kann keine fremde Webseite
      // über den Browser des Nutzers einen Agent vortäuschen (Cross-Site WebSocket Hijacking).
      verifyClient: ({ req }: { req: IncomingMessage }) => req.headers.origin === undefined,
    });
    this.wss.on('connection', (socket) => this.accept(socket));
  }

  onApplicationShutdown() {
    for (const { socket } of this.agents.values()) socket.close(1001, 'Panel fährt herunter');
    this.wss?.close();
  }

  private accept(socket: WebSocket) {
    if (this.wss!.clients.size > MAX_AGENTS) {
      socket.close(1013, 'Zu viele Verbindungen');
      return;
    }
    const id = randomUUID();
    const timeout = setTimeout(() => socket.close(4000, 'Kein hello erhalten'), HELLO_TIMEOUT_MS);

    socket.once('message', (data) => {
      clearTimeout(timeout);
      const result = answerHello(data.toString(), id);
      socket.send(JSON.stringify(result.reply));

      if (!result.accepted) {
        this.logger.warn(`Agent abgelehnt: ${result.reply.type === 'reject' ? result.reply.reason : ''}`);
        socket.close(4001, 'Handshake abgelehnt');
        return;
      }

      const info: ConnectedAgent = { id, ...result.hello, connectedAt: new Date().toISOString() };
      this.agents.set(id, { info, socket });
      this.logger.log(`Agent verbunden: ${info.hostname} (${info.os}/${info.arch}, v${info.agentVersion}, Protokoll ${info.protocol})`);

      socket.on('close', () => {
        this.agents.delete(id);
        this.logger.log(`Agent getrennt: ${info.hostname}`);
      });
    });
  }
}
