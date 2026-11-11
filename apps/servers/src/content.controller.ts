import { Controller, Inject, Logger } from '@nestjs/common';
import { ClientProxy, MessagePattern, Payload } from '@nestjs/microservices';
import {
  ContentInstallSchema,
  ContentRemoveSchema,
  ContentSearchSchema,
  ServerIdSchema,
  Subjects,
  type AgentsRequestReply,
  type ContentProject,
  type ContentSide,
  type InstalledContent,
  type Reply,
} from '@harrier-gg/contracts';
import type { PanelMessage } from '@harrier-gg/protocol';
import { randomUUID } from 'node:crypto';
import { firstValueFrom, timeout } from 'rxjs';
import { checkedFileName, type ContentProvider, type ContentVersion, type Providers } from './content';
import type { Db } from './db';
import { DB } from './nodes.controller';
import { NATS, TEMPLATES, VERSIONS } from './servers.controller';
import { knownSettings, type Settings, type Template, type TemplateCatalog } from './templates';
import { resolveVersion, type VersionProviders } from './versions';

export const CONTENT = Symbol('CONTENT');
const fail = (status: number, detail: string) => ({ error: { status, detail } });
/** Mods are megabytes; a slow mirror still gets two minutes per file. */
const DOWNLOAD_MS = 120_000;
/** No mod needs more; a cycle or a huge pack stops here. */
const MAX_PROJECTS = 50;

type Row = Awaited<ReturnType<Db['installedContent']['findFirstOrThrow']>>;
const toInstalled = (r: Row): InstalledContent => ({
  id: r.id,
  kind: r.kind,
  provider: r.provider,
  projectId: r.projectId,
  name: r.name,
  version: r.version,
  path: r.path,
  side: r.side as ContentSide | null,
  dependency: r.dependency,
  installedAt: r.installedAt.toISOString(),
});

/** Mods, plugins and other content from the providers a template names (ADR 0017). */
@Controller()
export class ContentController {
  private readonly logger = new Logger(ContentController.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(NATS) private readonly nats: ClientProxy,
    @Inject(TEMPLATES) private readonly templates: TemplateCatalog,
    @Inject(VERSIONS) private readonly versions: VersionProviders,
    @Inject(CONTENT) private readonly providers: Providers,
  ) {}

  @MessagePattern(Subjects.serversContentList)
  async list(@Payload() payload: unknown): Promise<Reply<InstalledContent[]>> {
    const request = ServerIdSchema.safeParse(payload);
    if (!request.success) return fail(400, 'Invalid request');
    const rows = await this.db.installedContent.findMany({ where: { serverId: request.data.id }, orderBy: [{ kind: 'asc' }, { name: 'asc' }] });
    return { data: rows.map(toInstalled) };
  }

  @MessagePattern(Subjects.serversContentSearch)
  async search(@Payload() payload: unknown): Promise<Reply<ContentProject[]>> {
    const request = ContentSearchSchema.safeParse(payload);
    if (!request.success) return fail(400, 'Invalid search');
    const source = await this.source(request.data);
    if ('error' in source) return source;
    try {
      return { data: await source.provider.search(source.options, request.data.query, source.gameVersion) };
    } catch (error) {
      return fail(502, `${request.data.source} is not reachable right now (${(error as Error).message})`);
    }
  }

  /**
   * Installs a project and the projects it needs from the same source. Everything is resolved
   * first, so a missing dependency installs nothing; then the agent downloads each file.
   */
  @MessagePattern(Subjects.serversContentInstall)
  async install(@Payload() payload: unknown): Promise<Reply<InstalledContent[]>> {
    const request = ContentInstallSchema.safeParse(payload);
    if (!request.success) return fail(400, 'Invalid request');
    const source = await this.source(request.data);
    if ('error' in source) return source;
    const { server, kind, provider, options, gameVersion } = source;

    const installed = new Set(
      (await this.db.installedContent.findMany({ where: { serverId: server.id, provider: request.data.source }, select: { projectId: true } })).map((r) => r.projectId),
    );
    if (installed.has(request.data.projectId)) return fail(409, 'This is installed already');

    let plan: { projectId: string; dependency: boolean; version: ContentVersion }[];
    try {
      plan = await this.resolve(provider, options, request.data.projectId, gameVersion, installed);
    } catch (error) {
      return fail(422, (error as Error).message);
    }

    const done: InstalledContent[] = [];
    for (const item of plan) {
      const { artifact } = item.version;
      const path = `${kind.path}/${checkedFileName(artifact.fileName)}`;
      const reply = await this.request(server.nodeId, {
        type: 'downloadFile',
        requestId: randomUUID(),
        serverId: server.id,
        url: artifact.url!,
        path,
        size: artifact.size,
        sha512: artifact.sha512 ?? null,
        sha1: artifact.sha1 ?? null,
      });
      if (!reply.delivered) return fail(409, 'The node is offline. Start its agent and try again.');
      const error = reply.result?.error ?? (reply.result ? null : 'The agent did not answer in time');
      if (error) return fail(422, done.length ? `${error} (installed before: ${done.map((d) => d.name).join(', ')})` : error);
      const name = item.dependency ? (await provider.project(item.projectId).catch(() => null))?.name ?? item.projectId : await this.name(provider, item.projectId);
      const row = await this.db.installedContent.create({
        data: {
          serverId: server.id,
          kind: kind.kind,
          provider: request.data.source,
          projectId: item.projectId,
          versionId: item.version.id,
          name,
          version: item.version.name,
          path,
          sha512: artifact.sha512 ?? null,
          sha1: artifact.sha1 ?? null,
          side: item.version.side,
          dependency: item.dependency,
        },
      });
      done.push(toInstalled(row));
    }
    this.logger.log(`Installed ${done.map((d) => `${d.name} ${d.version}`).join(', ')} on ${server.name}`);
    return { data: done };
  }

  /** Deletes the file and forgets the content. A file already gone is fine. */
  @MessagePattern(Subjects.serversContentRemove)
  async remove(@Payload() payload: unknown): Promise<Reply<{ ok: true }>> {
    const request = ContentRemoveSchema.safeParse(payload);
    if (!request.success) return fail(400, 'Invalid request');
    const row = await this.db.installedContent.findFirst({ where: { id: request.data.contentId, serverId: request.data.id }, include: { server: true } });
    if (!row) return fail(404, 'Not installed');
    const reply = await this.request(row.server.nodeId, { type: 'deletePath', requestId: randomUUID(), serverId: row.serverId, path: row.path });
    if (!reply.delivered) return fail(409, 'The node is offline. Start its agent and try again.');
    const error = reply.result?.error;
    if (error && !/no such file|not found/i.test(error)) return fail(422, error);
    await this.db.installedContent.delete({ where: { id: row.id } });
    return { data: { ok: true } };
  }

  /** The project and every required dependency not installed yet, each with the version to install. */
  private async resolve(provider: ContentProvider, options: unknown, projectId: string, gameVersion: string, installed: Set<string>) {
    const plan: { projectId: string; dependency: boolean; version: ContentVersion }[] = [];
    const queue = [{ projectId, dependency: false }];
    const seen = new Set<string>(installed);
    while (queue.length) {
      const next = queue.shift()!;
      if (seen.has(next.projectId)) continue;
      seen.add(next.projectId);
      if (plan.length >= MAX_PROJECTS) throw new Error(`More than ${MAX_PROJECTS} projects needed; install them one by one`);
      const version = await provider.latest(options, next.projectId, gameVersion);
      const name = next.dependency ? `A required dependency (${next.projectId})` : 'This project';
      if (!version) throw new Error(`${name} has no version for ${gameVersion || 'this server'}`);
      if (!version.artifact.url) throw new Error(`${name}'s author does not allow downloads by other apps; download it on the project page and upload it with the file manager`);
      plan.push({ ...next, version });
      for (const dependency of version.requires) queue.push({ projectId: dependency, dependency: true });
    }
    return plan;
  }

  private async name(provider: ContentProvider, projectId: string): Promise<string> {
    return (await provider.project(projectId).catch(() => null))?.name ?? projectId;
  }

  /** Server, content kind, provider and the game version the server runs (ADR 0012). */
  private async source(request: { id: string; kind: string; source: string }) {
    const server = await this.db.server.findUnique({ where: { id: request.id } });
    if (!server) return fail(404, 'Server not found');
    const template = this.templates.get(server.templateId);
    const kind = template?.content.find((c) => c.kind === request.kind);
    const options = kind?.sources.find((s) => s.provider === request.source);
    const provider = this.providers[request.source];
    if (!template || !kind || !options || !provider) return fail(404, `This server has no ${request.kind} source "${request.source}"`);
    return { server, template, kind, provider, options: provider.parse(options), gameVersion: await this.gameVersion(template, server.settings as Settings) };
  }

  private async gameVersion(template: Template, settings: Settings): Promise<string> {
    const field = template.config.find((f) => f.type === 'version');
    if (!field) return '';
    const resolved = await resolveVersion(this.versions, template, knownSettings(template, settings));
    return String(resolved.settings[field.key] ?? '');
  }

  private request(nodeId: string, message: PanelMessage): Promise<AgentsRequestReply> {
    const ms = message.type === 'downloadFile' ? DOWNLOAD_MS : 10_000;
    return firstValueFrom(
      this.nats.send<AgentsRequestReply>(Subjects.agentsRequest, { nodeId, message, timeoutMs: ms }).pipe(timeout(ms + 5000)),
    ).catch(() => ({ delivered: false, result: null }));
  }
}
