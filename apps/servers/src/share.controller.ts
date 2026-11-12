import { Controller, Inject } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { ServerIdSchema, Subjects, type Reply, type SharePack, type ShareSummary } from '@harrier-gg/contracts';
import { createHash } from 'node:crypto';
import type { Db } from './db';
import { DB } from './nodes.controller';
import { TEMPLATES, VERSIONS } from './servers.controller';
import { forPlayers, loaderVersion, mrpackIndex, zipOne } from './share';
import { knownSettings, type Settings, type TemplateCatalog } from './templates';
import { gameVersionOf, type VersionProviders } from './versions';

const fail = (status: number, detail: string) => ({ error: { status, detail } });

/** Packs of the content players need, for every member (ADR 0018). */
@Controller()
export class ShareController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(TEMPLATES) private readonly templates: TemplateCatalog,
    @Inject(VERSIONS) private readonly versions: VersionProviders,
  ) {}

  @MessagePattern(Subjects.serversShare)
  async summary(@Payload() payload: unknown): Promise<Reply<ShareSummary>> {
    const files = await this.files(payload);
    if ('error' in files) return files;
    const { index, missing } = mrpackIndex({ ...files, loaderVersion: '' });
    const included = new Set(index.files.map((f) => f.path));
    return {
      data: {
        format: 'mrpack',
        fileName: files.fileName,
        mods: files.rows.filter((r) => included.has(r.path)).map((r) => ({ name: r.name, version: r.version })),
        missing,
      },
    };
  }

  @MessagePattern(Subjects.serversSharePack)
  async pack(@Payload() payload: unknown): Promise<Reply<SharePack>> {
    const files = await this.files(payload);
    if ('error' in files) return files;
    let loader: string;
    try {
      loader = await loaderVersion(files.loader, files.gameVersion);
    } catch (error) {
      return fail(502, `The loader version is not reachable right now (${(error as Error).message})`);
    }
    const { index } = mrpackIndex({ ...files, loaderVersion: loader });
    if (index.files.length === 0) return fail(404, 'There is nothing for players to download');
    const zip = zipOne('modrinth.index.json', Buffer.from(JSON.stringify(index, null, 2), 'utf8'));
    return { data: { fileName: files.fileName, data: zip.toString('base64') } };
  }

  /** The server's installed content that players need, and what the pack is made of. */
  private async files(payload: unknown) {
    const request = ServerIdSchema.safeParse(payload);
    if (!request.success) return fail(400, 'Invalid request');
    const server = await this.db.server.findUnique({ where: { id: request.data.id } });
    if (!server) return fail(404, 'Server not found');
    const template = this.templates.get(server.templateId);
    if (!template?.share) return fail(404, 'This server has nothing to share with players');
    const rows = (await this.db.installedContent.findMany({ where: { serverId: server.id }, orderBy: { name: 'asc' } })).filter((r) => forPlayers(r.side));
    const gameVersion = await gameVersionOf(this.versions, template, knownSettings(template, server.settings as Settings));
    // Same content, same version ID, so launchers see whether the pack changed.
    const versionId = createHash('sha1').update(rows.map((r) => r.sha512 ?? r.path).join()).digest('hex').slice(0, 12);
    const fileName = `${server.name.replace(/[^A-Za-z0-9._-]+/g, '-')}.mrpack`;
    return { rows, files: rows, name: server.name, versionId, gameVersion, loader: template.share.loader, fileName };
  }
}
