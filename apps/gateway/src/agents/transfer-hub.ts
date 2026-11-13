import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { AgentHub } from './agent-hub';

/** Transfer channels of agents (ADR 0015): `/agent/transfer/<id>`. */
export const TRANSFER_WS_PATH = /^\/agent\/transfer\/([0-9a-f-]{36})$/;
/** How long a transfer ID waits for its agent. */
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * Pairs a browser upload or download with the channel the agent opens for it. Each ID works
 * once, within 30 s, and only for the node it was created for; the agent authenticates with its
 * token like on its main connection.
 */
@Injectable()
export class TransferHub {
  // Frames are at most 64 KiB (agent) or what the browser's upload stream yields.
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private readonly waiting = new Map<string, { nodeId: string; resolve: (channel: WebSocket | null) => void }>();

  constructor(private readonly agents: AgentHub) {}

  /** A new transfer for a node: its ID, and the agent's channel once it connects (null after 30 s). */
  open(nodeId: string): { id: string; channel: Promise<WebSocket | null> } {
    const id = randomUUID();
    const channel = new Promise<WebSocket | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(null);
      }, CONNECT_TIMEOUT_MS);
      this.waiting.set(id, {
        nodeId,
        resolve: (ws) => {
          clearTimeout(timer);
          resolve(ws);
        },
      });
    });
    return { id, channel };
  }

  /** Accepts an agent's transfer channel, if the ID is waiting for exactly this node. */
  async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, id: string) {
    const node = await this.agents.authenticate(req).catch(() => null);
    const waiting = this.waiting.get(id);
    if (!node || !waiting || waiting.nodeId !== node.id) return void socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    this.waiting.delete(id);
    this.wss.handleUpgrade(req, socket, head, (ws) => waiting.resolve(ws));
  }
}
