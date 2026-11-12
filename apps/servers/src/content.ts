// Content providers (ADR 0017): one interface for mods, plugins and the like from any platform.
// Templates name a provider per content kind with that provider's own filters; adding a platform
// is one adapter here.
import type { ContentProject, ContentSide } from '@harrier-gg/contracts';
import { z } from 'zod';
import { fetchJson, type FetchJson } from './versions';

/** A file to download: the agent checks size and hash before it puts it in place. */
export interface Artifact {
  /** null if the author does not allow downloads by other apps (CurseForge). */
  url: string | null;
  fileName: string;
  size: number;
  sha512?: string;
  sha1?: string;
}

export interface ContentVersion {
  id: string;
  name: string;
  artifact: Artifact;
  /** Projects this version needs, from the same provider. */
  requires: string[];
  side: ContentSide | null;
}

/** An installed file the panel asks about: which project, and its hashes. */
export interface InstalledFile {
  projectId: string;
  sha512: string | null;
  sha1: string | null;
}

export interface ContentProvider {
  /** Checks a template's source options; throws with a clear message when they are wrong. */
  parse(options: unknown): unknown;
  search(options: unknown, query: string, gameVersion: string): Promise<ContentProject[]>;
  /** The newest version of a project that fits the server, or null. */
  latest(options: unknown, projectId: string, gameVersion: string): Promise<ContentVersion | null>;
  /** A project's name, for dependencies the user did not pick themselves. */
  project(projectId: string): Promise<ContentProject>;
  /**
   * The newest fitting version for each installed project, or null if none fits the game
   * version any more (e.g. after changing it). Projects the provider cannot answer for are left out.
   */
  updates(options: unknown, files: InstalledFile[], gameVersion: string): Promise<Map<string, ContentVersion | null>>;
}

/** `updates` for providers without a bulk request: one `latest` per project. */
export async function updatesOneByOne(provider: ContentProvider, options: unknown, files: InstalledFile[], gameVersion: string) {
  const updates = new Map<string, ContentVersion | null>();
  for (const file of files) updates.set(file.projectId, await provider.latest(options, file.projectId, gameVersion));
  return updates;
}

/**
 * Dependencies nobody needs any more once `removed` is gone, also dependencies of those
 * (ADR 0017). Only content installed as a dependency is ever cleaned up.
 */
export function orphans<T extends { id: string; provider: string; projectId: string; dependency: boolean; requires: string[] }>(all: T[], removed: T[]): T[] {
  const gone = new Set(removed.map((r) => r.id));
  const found: T[] = [];
  for (;;) {
    const left = all.filter((r) => !gone.has(r.id));
    const next = left.filter((r) => r.dependency && !left.some((o) => o.id !== r.id && o.provider === r.provider && o.requires.includes(r.projectId)));
    if (next.length === 0) return found;
    for (const r of next) gone.add(r.id);
    found.push(...next);
  }
}

// ---- Modrinth (https://docs.modrinth.com/api/) ----

const MODRINTH = 'https://api.modrinth.com/v2';
const ModrinthOptions = z.object({
  provider: z.literal('modrinth'),
  /** Modrinth's project type: mod, plugin, datapack, resourcepack, … */
  type: z.string().regex(/^[a-z]+$/),
  /** Loader or platform as Modrinth calls it: fabric, paper, … */
  loader: z.string().regex(/^[a-z]+$/),
});
type ModrinthOptions = z.infer<typeof ModrinthOptions>;

interface ModrinthHit {
  project_id: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
  icon_url: string | null;
  client_side?: string;
  server_side?: string;
}

interface ModrinthVersion {
  id: string;
  name: string;
  version_number: string;
  environment?: string;
  files: { url: string; filename: string; primary: boolean; size: number; hashes: { sha512?: string; sha1?: string } }[];
  dependencies: { project_id: string | null; dependency_type: string }[];
}

/** Modrinth's sides: a mod the server does not need belongs to the players (ADR 0005). */
function sideOf(client?: string, server?: string): ContentSide | null {
  if (!client || !server) return null;
  if (server === 'unsupported') return 'client';
  if (client === 'unsupported') return 'server';
  return 'both';
}

/** Newer field on versions: `client_only`, `server_only`, `client_and_server`, … */
function sideOfEnvironment(environment?: string): ContentSide | null {
  if (!environment || environment === 'unknown') return null;
  if (environment.includes('client_only')) return 'client';
  if (environment.includes('server_only')) return 'server';
  return 'both';
}

/** A Modrinth version in the shape all providers share. */
function toVersion(version: ModrinthVersion): ContentVersion {
  const file = version.files.find((f) => f.primary) ?? version.files[0];
  return {
    id: version.id,
    name: version.version_number,
    artifact: { url: file.url, fileName: file.filename, size: file.size, sha512: file.hashes.sha512, sha1: file.hashes.sha1 },
    requires: version.dependencies.filter((d) => d.dependency_type === 'required' && d.project_id).map((d) => d.project_id!),
    side: sideOfEnvironment(version.environment),
  };
}

export function modrinth(fetch: FetchJson = fetchJson): ContentProvider {
  const get = (path: string, params: Record<string, string>) => fetch(`${MODRINTH}${path}?${new URLSearchParams(params)}`);
  const project = (hit: ModrinthHit): ContentProject => ({
    id: hit.project_id,
    name: hit.title,
    summary: hit.description,
    author: hit.author,
    downloads: hit.downloads,
    iconUrl: hit.icon_url,
    pageUrl: `https://modrinth.com/project/${hit.slug}`,
    side: sideOf(hit.client_side, hit.server_side),
  });
  return {
    parse: (options) => ModrinthOptions.parse(options),
    async search(options, query, gameVersion) {
      const o = options as ModrinthOptions;
      const facets = [[`project_type:${o.type}`], [`categories:${o.loader}`], ...(gameVersion ? [[`versions:${gameVersion}`]] : [])];
      const result = (await get('/search', { query, facets: JSON.stringify(facets), limit: '20' })) as { hits: ModrinthHit[] };
      return result.hits.map(project);
    },
    async latest(options, projectId, gameVersion) {
      const o = options as ModrinthOptions;
      const versions = (await get(`/project/${encodeURIComponent(projectId)}/version`, {
        loaders: JSON.stringify([o.loader]),
        ...(gameVersion ? { game_versions: JSON.stringify([gameVersion]) } : {}),
        include_changelog: 'false',
      })) as ModrinthVersion[];
      // Newest first.
      return versions[0] ? toVersion(versions[0]) : null;
    },
    /** One request for all files: Modrinth finds each project by the file's hash. */
    async updates(options, files, gameVersion) {
      const o = options as ModrinthOptions;
      const byHash = new Map(files.filter((f) => f.sha512).map((f) => [f.sha512!.toLowerCase(), f.projectId]));
      const updates = new Map<string, ContentVersion | null>();
      if (byHash.size === 0) return updates;
      const found = (await fetch(`${MODRINTH}/version_files/update`, {
        hashes: [...byHash.keys()],
        algorithm: 'sha512',
        loaders: [o.loader],
        ...(gameVersion ? { game_versions: [gameVersion] } : {}),
      })) as Record<string, ModrinthVersion>;
      // A hash without an answer has no version for this game version (any more).
      for (const [hash, projectId] of byHash) updates.set(projectId, found[hash] ? toVersion(found[hash]) : null);
      return updates;
    },
    async project(projectId) {
      const p = (await fetch(`${MODRINTH}/project/${encodeURIComponent(projectId)}`)) as ModrinthHit & { id: string; client_side: string; server_side: string };
      return project({ ...p, project_id: p.id, author: '', downloads: p.downloads });
    },
  };
}

/** Providers by the name templates use. */
export type Providers = Record<string, ContentProvider>;

export function providers(fetch: FetchJson = fetchJson): Providers {
  return { modrinth: modrinth(fetch) };
}

/** Safe file names only: what the agent writes is `<kind path>/<file name>`. */
export function checkedFileName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,200}$/.test(name)) throw new Error(`Unexpected file name "${name}"`);
  return name;
}
