import { Controller, Inject } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  AuthenticateNodeRequestSchema,
  Subjects,
  type AuthenticateNodeReply,
} from '@harrier-gg/contracts';
import type { Db } from './db';
import { parseToken, secretMatches } from './node-token';

export const DB = Symbol('DB');

@Controller()
export class NodesController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @MessagePattern(Subjects.nodesAuthenticate)
  async authenticate(@Payload() payload: unknown): Promise<AuthenticateNodeReply> {
    const request = AuthenticateNodeRequestSchema.safeParse(payload);
    const parsed = request.success ? parseToken(request.data.token) : null;
    if (!parsed) return { node: null };

    const node = await this.db.node.findUnique({ where: { id: parsed.nodeId } });
    if (!node || !secretMatches(parsed.secret, node.tokenHash)) return { node: null };

    await this.db.node.update({ where: { id: node.id }, data: { lastSeenAt: new Date() } });
    return { node: { id: node.id, name: node.name } };
  }
}
