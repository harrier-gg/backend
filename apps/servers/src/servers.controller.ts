import { Controller, Inject, Logger } from '@nestjs/common';
import { ClientProxy, EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
import {
  AgentsEventSchema,
  CreateNodeSchema,
  NodeIdSchema,
  type NodeCreated,
  CreateServerRequestSchema,
  ServerCommandRequestSchema,
  ServerIdSchema,
  ServerStatusSchema,
  Subjects,
  type AgentsSendReply,
  type NodeSummary,
  type Reply,
  type ServerSummary,
  type TemplateSummary,
} from '@harrier-gg/contracts';
import type { PanelMessage } from '@harrier-gg/protocol';
import { firstValueFrom, timeout } from 'rxjs';
import type { Db } from './db';
import { DB } from './nodes.controller';
import { createNode } from './node-token';
import { buildSpec, validateSettings, type Settings, type TemplateCatalog } from './templates';

export const NATS = Symbol('NATS');
export const TEMPLATES = Symbol('TEMPLATES');

type ServerRow = Awaited<ReturnType<Db['server']['findFirstOrThrow']>>;

const fail = (status: number, detail: string) => ({ error: { status, detail } });

function toSummary(s: ServerRow): ServerSummary {
  return {
    id: s.id,
    name: s.name,
    nodeId: s.nodeId,
    templateId: s.templateId,
    settings: s.settings as Settings,
    hostPort: s.hostPort,
    status: ServerStatusSchema.catch('stopped').parse(s.status),
    statusMessage: s.statusMessage,
    createdAt: s.createdAt.toISOString(),
  };
}

@Controller()
export class ServersController {
  private readonly logger = new Logger(ServersController.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(NATS) private readonly nats: ClientProxy,
    @Inject(TEMPLATES) private readonly templates: TemplateCatalog,
  ) {}

  @MessagePattern(Subjects.templatesList)
  listTemplates(): Reply<TemplateSummary[]> {
    return { data: this.templates.list() };
  }

  @MessagePattern(Subjects.nodesList)
  async listNodes(): Promise<Reply<NodeSummary[]>> {
    const nodes = await this.db.node.findMany({ orderBy: { name: 'asc' } });
    return { data: nodes.map((n) => ({ id: n.id, name: n.name, lastSeenAt: n.lastSeenAt?.toISOString() ?? null })) };
  }

  @MessagePattern(Subjects.nodesCreate)
  async createNode(@Payload() payload: unknown): Promise<Reply<NodeCreated>> {
    const request = CreateNodeSchema.safeParse(payload);
    if (!request.success) return fail(400, 'Node names have 1–64 characters: letters, digits, ".", "_", "-"');
    try {
      const { node, token } = await createNode(this.db, request.data.name);
      return { data: { node: { id: node.id, name: node.name, lastSeenAt: null }, token } };
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') return fail(409, `A node named "${request.data.name}" already exists`);
      throw error;
    }
  }

  /** Removing a node revokes its token. Its servers must be removed first. */
  @MessagePattern(Subjects.nodesRemove)
  async removeNode(@Payload() payload: unknown): Promise<Reply<{ ok: true }>> {
    const request = NodeIdSchema.safeParse(payload);
    if (!request.success) return fail(400, 'Invalid node');
    if ((await this.db.server.count({ where: { nodeId: request.data.id } })) > 0) {
      return fail(409, 'The node still has servers. Remove them first.');
    }
    const deleted = await this.db.node.deleteMany({ where: { id: request.data.id } });
    return deleted.count ? { data: { ok: true } } : fail(404, 'Node not found');
  }

  @MessagePattern(Subjects.serversList)
  async list(): Promise<Reply<ServerSummary[]>> {
    const servers = await this.db.server.findMany({ orderBy: { createdAt: 'asc' } });
    return { data: servers.map(toSummary) };
  }

  @MessagePattern(Subjects.serversGet)
  async get(@Payload() payload: unknown): Promise<Reply<ServerSummary>> {
    const server = await this.find(payload);
    return server ? { data: toSummary(server) } : fail(404, 'Server not found');
  }

  @MessagePattern(Subjects.serversCreate)
  async create(@Payload() payload: unknown): Promise<Reply<ServerSummary>> {
    const request = CreateServerRequestSchema.safeParse(payload);
    if (!request.success) return fail(400, 'Invalid request: name, node and template are required');
    const { nodeId, name, templateId } = request.data;

    const template = this.templates.get(templateId);
    if (!template) return fail(400, `Unknown template "${templateId}"`);
    const validated = validateSettings(template, request.data.settings);
    if ('error' in validated) return fail(400, validated.error);
    if (!(await this.db.node.findUnique({ where: { id: nodeId } }))) return fail(400, 'Unknown node');

    // ponytail: first free port from the template's default upwards; port ranges per node later
    const used = new Set((await this.db.server.findMany({ where: { nodeId }, select: { hostPort: true } })).map((s) => s.hostPort));
    let hostPort = template.ports[0].container;
    while (used.has(hostPort)) hostPort++;

    try {
      const server = await this.db.server.create({
        data: { nodeId, name, templateId, settings: validated.settings, hostPort },
      });
      return { data: toSummary(server) };
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') return fail(409, `A server named "${name}" already exists on this node`);
      throw error;
    }
  }

  @MessagePattern(Subjects.serversStart)
  async start(@Payload() payload: unknown): Promise<Reply<ServerSummary>> {
    const server = await this.find(payload);
    if (!server) return fail(404, 'Server not found');
    const template = this.templates.get(server.templateId);
    if (!template) return fail(409, `The template "${server.templateId}" no longer exists`);
    const validated = validateSettings(template, server.settings as Settings);
    if ('error' in validated) return fail(409, `Stored settings no longer match the template: ${validated.error}`);

    const spec = buildSpec(template, validated.settings, server.hostPort);
    return this.send(server, { type: 'startServer', serverId: server.id, spec });
  }

  @MessagePattern(Subjects.serversStop)
  async stop(@Payload() payload: unknown): Promise<Reply<ServerSummary>> {
    const server = await this.find(payload);
    if (!server) return fail(404, 'Server not found');
    return this.send(server, { type: 'stopServer', serverId: server.id });
  }

  @MessagePattern(Subjects.serversCommand)
  async command(@Payload() payload: unknown): Promise<Reply<ServerSummary>> {
    const request = ServerCommandRequestSchema.safeParse(payload);
    if (!request.success) return fail(400, 'Invalid command');
    const server = await this.find({ id: request.data.id });
    if (!server) return fail(404, 'Server not found');
    return this.send(server, { type: 'sendCommand', serverId: server.id, command: request.data.command });
  }

  /** Status reports from agents. Only servers on the reporting node can be updated. */
  @EventPattern(Subjects.agentsEvent)
  async onAgentEvent(@Payload() payload: unknown) {
    const event = AgentsEventSchema.safeParse(payload);
    if (!event.success) return;
    const { nodeId, message } = event.data;
    const updated = await this.db.server.updateMany({
      where: { id: message.serverId, nodeId },
      data: { status: message.status, statusMessage: message.message ?? null },
    });
    if (updated.count === 0) this.logger.warn(`Ignoring status for unknown server ${message.serverId} from node ${nodeId}`);
  }

  private async find(payload: unknown) {
    const request = ServerIdSchema.safeParse(payload);
    return request.success ? this.db.server.findUnique({ where: { id: request.data.id } }) : null;
  }

  private async send(server: ServerRow, message: PanelMessage): Promise<Reply<ServerSummary>> {
    const reply = await firstValueFrom(
      this.nats.send<AgentsSendReply>(Subjects.agentsSend, { nodeId: server.nodeId, message }).pipe(timeout(3000)),
    ).catch(() => ({ delivered: false }));
    if (!reply.delivered) return fail(409, 'The node is offline. Start its agent and try again.');
    return { data: toSummary(server) };
  }
}
