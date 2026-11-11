import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { AGENT_WS_PATH, AgentHub } from './agents/agent-hub';
import { CONSOLE_WS_PATH, ConsoleHub } from './console-hub';

/**
 * Routes WebSocket upgrades by path. Two `ws` servers attached to the same HTTP server with
 * different paths would reject each other's upgrades, so both use `noServer` and this router.
 */
@Injectable()
export class WsRouter implements OnApplicationBootstrap {
  constructor(
    private readonly http: HttpAdapterHost,
    private readonly agents: AgentHub,
    private readonly consoles: ConsoleHub,
  ) {}

  onApplicationBootstrap() {
    const server: Server = this.http.httpAdapter.getHttpServer();
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = new URL(req.url ?? '', 'http://x').pathname;
      if (path === AGENT_WS_PATH) {
        this.agents.wss.handleUpgrade(req, socket, head, (ws) => this.agents.wss.emit('connection', ws, req));
      } else if (CONSOLE_WS_PATH.test(path)) {
        if (!ConsoleHub.allowed(req)) return void socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        this.consoles.wss.handleUpgrade(req, socket, head, (ws) => this.consoles.wss.emit('connection', ws, req));
      } else {
        socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      }
    });
  }
}
