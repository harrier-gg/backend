import { Controller, Inject, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ClientProxy, EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
import {
  BackupRefSchema,
  BackupResultEventSchema,
  BackupScheduleSchema,
  ServerIdSchema,
  Subjects,
  type AgentsRequestReply,
  type AgentsSendReply,
  type BackupsSummary,
  type Reply,
} from '@harrier-gg/contracts';
import type { PanelMessage } from '@harrier-gg/protocol';
import { randomUUID } from 'node:crypto';
import { firstValueFrom, timeout } from 'rxjs';
import type { Db } from './db';
import { DB } from './nodes.controller';
import { NATS, TEMPLATES } from './servers.controller';
import type { TemplateCatalog } from './templates';

const fail = (status: number, detail: string) => ({ error: { status, detail } });
const HOUR_MS = 60 * 60 * 1000;
/** How often the schedule is checked; backups start at most this late. */
const CHECK_MS = 5 * 60 * 1000;

interface Schedule {
  backupEveryHours: number;
  lastBackupAt: Date | null;
  activeSinceBackup: boolean;
}

/** Due when scheduled, ran since its last backup, and the last one is old enough (ADR 0016). */
export function isDue(server: Schedule, now: Date): boolean {
  if (server.backupEveryHours === 0 || !server.activeSinceBackup) return false;
  return !server.lastBackupAt || now.getTime() - server.lastBackupAt.getTime() >= server.backupEveryHours * HOUR_MS;
}

/**
 * Backups (ADR 0016): the agent makes and keeps them on the node; this keeps the schedule,
 * starts due backups and remembers how the last one ended.
 */
@Controller()
export class BackupsController implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(BackupsController.name);
  // ponytail: in memory of this instance; lost on restart (the agent still finishes the backup)
  private readonly inProgress = new Map<string, 'create' | 'restore'>();
  private readonly lastError = new Map<string, string>();
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(NATS) private readonly nats: ClientProxy,
    @Inject(TEMPLATES) private readonly templates: TemplateCatalog,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.startDue(), CHECK_MS);
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  @MessagePattern(Subjects.serversBackups)
  async summary(@Payload() payload: unknown): Promise<Reply<BackupsSummary>> {
    const server = await this.find(payload);
    if (!server) return fail(404, 'Server not found');
    const reply = await this.request(server.nodeId, { type: 'listBackups', requestId: randomUUID(), serverId: server.id });
    return {
      data: {
        everyHours: server.backupEveryHours,
        keep: server.backupKeep,
        lastBackupAt: server.lastBackupAt?.toISOString() ?? null,
        inProgress: this.inProgress.get(server.id) ?? null,
        lastError: this.lastError.get(server.id) ?? null,
        backups: reply.result?.entries ?? null,
      },
    };
  }

  @MessagePattern(Subjects.serversBackupSchedule)
  async schedule(@Payload() payload: unknown): Promise<Reply<{ ok: true }>> {
    const request = BackupScheduleSchema.safeParse(payload);
    if (!request.success) return fail(400, 'Every 0–168 hours, keep 1–100 backups');
    const { id, everyHours, keep } = request.data;
    const updated = await this.db.server.updateMany({ where: { id }, data: { backupEveryHours: everyHours, backupKeep: keep } });
    return updated.count ? { data: { ok: true } } : fail(404, 'Server not found');
  }

  /** Starts a backup now; it reports back with `agents.backup`. */
  @MessagePattern(Subjects.serversBackupCreate)
  async create(@Payload() payload: unknown): Promise<Reply<{ ok: true }>> {
    const server = await this.find(payload);
    if (!server) return fail(404, 'Server not found');
    return this.start(server);
  }

  @MessagePattern(Subjects.serversBackupDelete)
  async remove(@Payload() payload: unknown): Promise<Reply<{ ok: true }>> {
    const request = BackupRefSchema.safeParse(payload);
    if (!request.success) return fail(400, 'Invalid backup');
    const server = await this.find({ id: request.data.id });
    if (!server) return fail(404, 'Server not found');
    const reply = await this.request(server.nodeId, { type: 'deleteBackup', requestId: randomUUID(), serverId: server.id, name: request.data.name });
    if (!reply.delivered) return fail(409, 'The node is offline. Start its agent and try again.');
    if (reply.result?.error) return fail(422, reply.result.error);
    return { data: { ok: true } };
  }

  /** Restores a stopped server; the agent backs up the current state first. */
  @MessagePattern(Subjects.serversBackupRestore)
  async restore(@Payload() payload: unknown): Promise<Reply<{ ok: true }>> {
    const request = BackupRefSchema.safeParse(payload);
    if (!request.success) return fail(400, 'Invalid backup');
    const server = await this.find({ id: request.data.id });
    if (!server) return fail(404, 'Server not found');
    if (server.status !== 'stopped' && server.status !== 'crashed') return fail(409, 'Stop the server before restoring a backup');
    if (this.inProgress.has(server.id)) return fail(409, 'A backup or restore of this server is in progress');
    const exclude = this.templates.get(server.templateId)?.capabilities.backup?.exclude ?? [];
    const delivered = await this.send(server.nodeId, { type: 'restoreBackup', requestId: randomUUID(), serverId: server.id, name: request.data.name, exclude });
    if (!delivered) return fail(409, 'The node is offline. Start its agent and try again.');
    this.inProgress.set(server.id, 'restore');
    this.lastError.delete(server.id);
    return { data: { ok: true } };
  }

  /** The agent finished. Only servers of the reporting node are updated. */
  @EventPattern(Subjects.agentsBackup)
  async onResult(@Payload() payload: unknown) {
    const event = BackupResultEventSchema.safeParse(payload);
    if (!event.success) return;
    const { nodeId, message } = event.data;
    const server = await this.db.server.findFirst({ where: { id: message.serverId, nodeId } });
    if (!server) return;
    this.inProgress.delete(server.id);
    if (message.error) {
      this.lastError.set(server.id, message.error);
      this.logger.warn(`${message.action} of ${server.name} failed: ${message.error}`);
      return;
    }
    this.lastError.delete(server.id);
    if (message.action === 'create') {
      // Still running: the next backup is due on schedule; otherwise only after it runs again.
      await this.db.server.update({ where: { id: server.id }, data: { lastBackupAt: new Date(), activeSinceBackup: server.status === 'running' } });
    }
  }

  /** Starts every due backup (ADR 0016). Servers on offline nodes are tried at the next check. */
  async startDue(now = new Date()) {
    const servers = await this.db.server.findMany({ where: { backupEveryHours: { gt: 0 }, activeSinceBackup: true } });
    for (const server of servers.filter((s) => isDue(s, now) && !this.inProgress.has(s.id))) {
      const started = await this.start(server);
      if ('data' in started) this.logger.log(`Scheduled backup of ${server.name}`);
    }
  }

  private async start(server: { id: string; nodeId: string; templateId: string; backupKeep: number }): Promise<Reply<{ ok: true }>> {
    if (this.inProgress.has(server.id)) return fail(409, 'A backup or restore of this server is in progress');
    const save = this.templates.get(server.templateId)?.capabilities.backup;
    const delivered = await this.send(server.nodeId, {
      type: 'createBackup',
      serverId: server.id,
      keep: server.backupKeep,
      quiesce: save && save.before.length ? { before: save.before, ready: save.ready ?? null, after: save.after } : null,
      exclude: save?.exclude ?? [],
    });
    if (!delivered) return fail(409, 'The node is offline. Start its agent and try again.');
    this.inProgress.set(server.id, 'create');
    this.lastError.delete(server.id);
    return { data: { ok: true } };
  }

  private async find(payload: unknown) {
    const request = ServerIdSchema.safeParse(payload);
    return request.success ? this.db.server.findUnique({ where: { id: request.data.id } }) : null;
  }

  private async send(nodeId: string, message: PanelMessage): Promise<boolean> {
    const reply = await firstValueFrom(this.nats.send<AgentsSendReply>(Subjects.agentsSend, { nodeId, message }).pipe(timeout(3000))).catch(() => ({
      delivered: false,
    }));
    return reply.delivered;
  }

  private async request(nodeId: string, message: PanelMessage): Promise<AgentsRequestReply> {
    return firstValueFrom(this.nats.send<AgentsRequestReply>(Subjects.agentsRequest, { nodeId, message }).pipe(timeout(15_000))).catch(() => ({
      delivered: false,
      result: null,
    }));
  }
}
