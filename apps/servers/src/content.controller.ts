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
  type ContentUpdate,
  type InstalledContent,
  type Reply,
} from '@harrier-gg/contracts';
import type { PanelMessage } from '@harrier-gg/protocol';
import { randomUUID } from 'node:crypto';
import { firstValueFrom, timeout } from 'rxjs';
import { checkedFileName, orphans, type ContentProvider, type ContentVersion, type Providers } from './content';
import type { Db } from './db';
import { DB } from './nodes.controller';
import { NATS, TEMPLATES, VERSIONS } from './servers.controller';
import { knownSettings, type Settings, type Template, type TemplateCatalog } from './templates';
import { gameVersionOf, type VersionProviders } from './versions';

export const CONTENT = Symbol('CONTENT');
const fail = (status: number, detail: string) => ({ error: { status, detail } });
/** Mods are megabytes; a slow mirror still gets two minutes per file. */
const DOWNLOAD_MS = 120_000;
/** No mod needs more; a cycle or a huge pack stops here. */
const MAX_PROJECTS = 50;

type Row = Awaited<ReturnType<Db['installedContent']['findFirstOrThrow']>>;
type Planned = { projectId: string; dependency: boolean; version: ContentVersion };
interface Source {
  server: Awaited<ReturnType<Db['server']['findFirstOrThrow']>>;
  template: Template;
  kind: Template['content'][number];
  provider: ContentProvider;
  options: unknown;
  gameVersion: string;
}
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
    const { server, provider, options, gameVersion } = source;

    const installed = new Set(
      (await this.db.installedContent.findMany({ where: { serverId: server.id, provider: request.data.source }, select: { projectId: true } })).map((r) => r.projectId),
    );
    if (installed.has(request.data.projectId)) return fail(409, 'This is installed already');

    let plan: Planned[];
    try {
      plan = await this.resolve(provider, options, [{ projectId: request.data.projectId, dependency: false }], gameVersion, installed);
    } catch (error) {
      return fail(422, (error as Error).message);
    }

    const done: InstalledContent[] = [];
    for (const item of plan) {
      const put = await this.put(source, request.data.source, item);
      if ('error' in put) return done.length ? fail(put.error.status, `${put.error.detail} (installed before: ${done.map((d) => d.name).join(', ')})`) : put;
      done.push(toInstalled(put.data));
    }
    this.logger.log(`Installed ${done.map((d) => `${d.name} ${d.version}`).join(', ')} on ${server.name}`);
    return { data: done };
  }

  /** Installed content with a newer fitting version, or none that fits the game version any more. */
  @MessagePattern(Subjects.serversContentUpdates)
  async updates(@Payload() payload: unknown): Promise<Reply<ContentUpdate[]>> {
    const request = ServerIdSchema.safeParse(payload);
    if (!request.success) return fail(400, 'Invalid request');
    const rows = await this.db.installedContent.findMany({ where: { serverId: request.data.id } });
    const updates: ContentUpdate[] = [];
    // One question per kind and source, so providers with bulk requests ask once.
    for (const group of new Set(rows.map((r) => `${r.kind} ${r.provider}`))) {
      const [kind, provider] = group.split(' ');
      const source = await this.source({ id: request.data.id, kind, source: provider });
      if ('error' in source) continue; // the template dropped this kind or source
      const mine = rows.filter((r) => r.kind === kind && r.provider === provider);
      let found: Map<string, ContentVersion | null>;
      try {
        found = await source.provider.updates(source.options, mine, source.gameVersion);
      } catch (error) {
        return fail(502, `${provider} is not reachable right now (${(error as Error).message})`);
      }
      for (const row of mine) {
        if (!found.has(row.projectId)) continue;
        const version = found.get(row.projectId);
        if (!version) updates.push({ contentId: row.id, version: null, incompatible: true });
        else if (version.id !== row.versionId) updates.push({ contentId: row.id, version: version.name, incompatible: false });
      }
    }
    return { data: updates };
  }

  /**
   * Updates one installed project to its newest fitting version, and installs dependencies the
   * new version needs. The new file is in place before the old one is deleted.
   */
  @MessagePattern(Subjects.serversContentUpdate)
  async update(@Payload() payload: unknown): Promise<Reply<InstalledContent[]>> {
    const request = ContentRemoveSchema.safeParse(payload);
    if (!request.success) return fail(400, 'Invalid request');
    const row = await this.db.installedContent.findFirst({ where: { id: request.data.contentId, serverId: request.data.id } });
    if (!row) return fail(404, 'Not installed');
    const source = await this.source({ id: row.serverId, kind: row.kind, source: row.provider });
    if ('error' in source) return source;
    const { provider, options, gameVersion } = source;

    const version = await provider.latest(options, row.projectId, gameVersion).catch(() => undefined);
    if (version === undefined) return fail(502, `${row.provider} is not reachable right now`);
    if (!version) return fail(422, `${row.name} has no version for ${gameVersion || 'this server'}`);
    if (version.id === row.versionId) return fail(409, `${row.name} is up to date`);
    if (!version.artifact.url) return fail(422, `${row.name}'s author does not allow downloads by other apps`);

    const installed = new Set((await this.db.installedContent.findMany({ where: { serverId: row.serverId, provider: row.provider } })).map((r) => r.projectId));
    let plan: Planned[];
    try {
      plan = await this.resolve(provider, options, version.requires.map((projectId) => ({ projectId, dependency: true })), gameVersion, installed);
    } catch (error) {
      return fail(422, (error as Error).message);
    }

    const done: InstalledContent[] = [];
    for (const item of plan) {
      const put = await this.put(source, row.provider, item);
      if ('error' in put) return put;
      done.push(toInstalled(put.data));
    }
    const put = await this.put(source, row.provider, { projectId: row.projectId, dependency: row.dependency, version }, row);
    if ('error' in put) return put;
    done.unshift(toInstalled(put.data));
    this.logger.log(`Updated ${row.name} ${row.version} → ${version.name} on ${source.server.name}`);
    return { data: done };
  }

  /**
   * Deletes the file and forgets the content, and the dependencies nobody needs any more. A
   * dependency another project still needs is refused. Returns everything removed.
   */
  @MessagePattern(Subjects.serversContentRemove)
  async remove(@Payload() payload: unknown): Promise<Reply<InstalledContent[]>> {
    const request = ContentRemoveSchema.safeParse(payload);
    if (!request.success) return fail(400, 'Invalid request');
    const all = await this.db.installedContent.findMany({ where: { serverId: request.data.id }, include: { server: true } });
    const row = all.find((r) => r.id === request.data.contentId);
    if (!row) return fail(404, 'Not installed');
    const needs = all.filter((r) => r.id !== row.id && r.provider === row.provider && r.requires.includes(row.projectId));
    if (needs.length) return fail(409, `${row.name} is needed by ${needs.map((n) => n.name).join(', ')}`);

    const removed: InstalledContent[] = [];
    for (const target of [row, ...orphans(all, [row])]) {
      const reply = await this.request(row.server.nodeId, { type: 'deletePath', requestId: randomUUID(), serverId: row.serverId, path: target.path });
      if (!reply.delivered) return fail(409, 'The node is offline. Start its agent and try again.');
      const error = reply.result?.error;
      // A file already gone is fine; the record goes either way.
      if (error && !/no such file|not found/i.test(error)) return fail(422, error);
      await this.db.installedContent.delete({ where: { id: target.id } });
      removed.push(toInstalled(target));
    }
    return { data: removed };
  }

  /**
   * Has the agent download one version and records it. With `replaces`, that record is updated
   * and its old file deleted once the new one is in place.
   */
  private async put(source: Source, provider: string, item: Planned, replaces?: Row): Promise<Reply<Row>> {
    const { server, kind } = source;
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
    if (error) return fail(422, error);
    const data = {
      versionId: item.version.id,
      version: item.version.name,
      path,
      sha512: artifact.sha512 ?? null,
      sha1: artifact.sha1 ?? null,
      url: artifact.url,
      size: artifact.size,
      side: item.version.side,
      requires: item.version.requires,
    };
    if (replaces) {
      if (replaces.path !== path) {
        await this.request(server.nodeId, { type: 'deletePath', requestId: randomUUID(), serverId: server.id, path: replaces.path });
      }
      return { data: await this.db.installedContent.update({ where: { id: replaces.id }, data }) };
    }
    const name = await this.name(source.provider, item.projectId);
    return {
      data: await this.db.installedContent.create({
        data: { ...data, serverId: server.id, kind: kind.kind, provider, projectId: item.projectId, name, dependency: item.dependency },
      }),
    };
  }

  /** The projects and every required dependency not installed yet, each with the version to install. */
  private async resolve(provider: ContentProvider, options: unknown, start: { projectId: string; dependency: boolean }[], gameVersion: string, installed: Set<string>) {
    const plan: Planned[] = [];
    const queue = [...start];
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
  private async source(request: { id: string; kind: string; source: string }): Promise<Source | { error: { status: number; detail: string } }> {
    const server = await this.db.server.findUnique({ where: { id: request.id } });
    if (!server) return fail(404, 'Server not found');
    const template = this.templates.get(server.templateId);
    const kind = template?.content.find((c) => c.kind === request.kind);
    const options = kind?.sources.find((s) => s.provider === request.source);
    const provider = this.providers[request.source];
    if (!template || !kind || !options || !provider) return fail(404, `This server has no ${request.kind} source "${request.source}"`);
    return { server, template, kind, provider, options: provider.parse(options), gameVersion: await this.gameVersion(template, server.settings as Settings) };
  }

  private gameVersion(template: Template, settings: Settings): Promise<string> {
    return gameVersionOf(this.versions, template, knownSettings(template, settings));
  }

  private request(nodeId: string, message: PanelMessage): Promise<AgentsRequestReply> {
    const ms = message.type === 'downloadFile' ? DOWNLOAD_MS : 10_000;
    return firstValueFrom(
      this.nats.send<AgentsRequestReply>(Subjects.agentsRequest, { nodeId, message, timeoutMs: ms }).pipe(timeout(ms + 5000)),
    ).catch(() => ({ delivered: false, result: null }));
  }
}
