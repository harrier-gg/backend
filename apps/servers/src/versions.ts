// Version providers (ADR 0012): which versions of a game exist, which one "latest" is, and which
// Java a version needs. Asked from the sources directly, cached in memory.
import type { GameVersion, VersionList } from '@harrier-gg/contracts';
import type { Settings, Template } from './templates';

export const PROVIDERS = ['mojang', 'papermc', 'fabric'] as const;
export type Provider = (typeof PROVIDERS)[number];

const LIST_TTL_MS = 60 * 60 * 1000;
const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const PAPER_PROJECT = 'https://fill.papermc.io/v3/projects/paper';
const FABRIC_GAME = 'https://meta.fabricmc.net/v2/versions/game';

/** GET, or POST with a JSON body. */
export type FetchJson = (url: string, body?: unknown) => Promise<unknown>;

/** PaperMC asks API clients to identify themselves. */
export const fetchJson: FetchJson = async (url, body) => {
  const headers: Record<string, string> = { 'user-agent': 'Harrier panel (https://github.com/harrier-gg)' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, {
    signal: AbortSignal.timeout(5000),
    headers,
    ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
};

interface MojangManifest {
  latest: { release: string };
  versions: { id: string; type: string; url: string }[];
}

export class VersionProviders {
  private readonly lists = new Map<Provider, { at: number; list: VersionList }>();
  /** Mojang's per-version files, by id; they never change. */
  private readonly versionUrls = new Map<string, string>();
  private readonly java = new Map<string, number>();

  constructor(
    private readonly fetch: FetchJson = fetchJson,
    private readonly now: () => number = Date.now,
  ) {}

  /** The provider's versions, newest first, or null if it could never be reached. */
  async list(provider: Provider): Promise<VersionList | null> {
    const cached = this.lists.get(provider);
    if (cached && this.now() - cached.at < LIST_TTL_MS) return cached.list;
    try {
      const list = await this.load(provider);
      this.lists.set(provider, { at: this.now(), list });
      return list;
    } catch {
      return cached?.list ?? null; // keep the last list while the source is down
    }
  }

  /** The Java major version a Minecraft version needs, or null if unknown (e.g. offline). */
  async javaFor(version: string): Promise<number | null> {
    const known = this.java.get(version);
    if (known !== undefined) return known;
    if (!this.versionUrls.has(version)) await this.list('mojang');
    const url = this.versionUrls.get(version);
    if (!url) return null;
    try {
      const file = (await this.fetch(url)) as { javaVersion?: { majorVersion?: number } };
      // Versions before 1.17 have no javaVersion and run on Java 8.
      const major = file.javaVersion?.majorVersion ?? 8;
      this.java.set(version, major);
      return major;
    } catch {
      return null;
    }
  }

  private async load(provider: Provider): Promise<VersionList> {
    switch (provider) {
      case 'mojang': {
        const manifest = (await this.fetch(MOJANG_MANIFEST)) as MojangManifest;
        const versions: GameVersion[] = [];
        for (const v of manifest.versions) {
          if (v.type !== 'release' && v.type !== 'snapshot') continue; // old_alpha, old_beta
          this.versionUrls.set(v.id, v.url);
          versions.push({ id: v.id, type: v.type });
        }
        return { latest: manifest.latest.release, versions };
      }
      case 'papermc': {
        // Paper only lists Minecraft versions; whether one is a release comes from Mojang.
        const [paper, mojang] = await Promise.all([this.fetch(PAPER_PROJECT) as Promise<{ versions: Record<string, string[]> }>, this.list('mojang')]);
        const releases = new Set(mojang?.versions.filter((v) => v.type === 'release').map((v) => v.id));
        const versions = Object.values(paper.versions)
          .flat()
          .map((id): GameVersion => ({ id, type: releases.has(id) ? 'release' : 'snapshot' }));
        return { latest: versions.find((v) => v.type === 'release')?.id ?? versions[0].id, versions };
      }
      case 'fabric': {
        const game = (await this.fetch(FABRIC_GAME)) as { version: string; stable: boolean }[];
        const versions = game.map((g): GameVersion => ({ id: g.version, type: g.stable ? 'release' : 'snapshot' }));
        return { latest: versions.find((v) => v.type === 'release')?.id ?? versions[0].id, versions };
      }
    }
  }
}

/** The image for a Java version: the smallest Java the template offers that is at least `need`. */
export function imageForJava(images: Record<string, string>, need: number): string | undefined {
  const offered = Object.keys(images)
    .map(Number)
    .sort((a, b) => a - b);
  const pick = offered.find((java) => java >= need) ?? offered.at(-1);
  return pick === undefined ? undefined : images[String(pick)];
}

const isLatest = (version: string) => version.toLowerCase() === 'latest';

/** The concrete game version a server runs ("latest" resolved), or "" for games without one. */
export async function gameVersionOf(providers: VersionProviders, template: Template, settings: Settings): Promise<string> {
  const field = template.config.find((f) => f.type === 'version');
  if (!field) return '';
  const resolved = await resolveVersion(providers, template, settings);
  return String(resolved.settings[field.key] ?? '');
}

/** Rejects versions the provider does not know. Without a list (offline) the name check is all. */
export async function checkVersion(providers: VersionProviders, template: Template, settings: Settings): Promise<string | null> {
  const field = template.config.find((f) => f.type === 'version');
  if (!field || !template.versions) return null;
  const version = String(settings[field.key]);
  if (isLatest(version)) return null;
  const list = await providers.list(template.versions.provider);
  if (list && !list.versions.some((v) => v.id === version)) return `${field.key} "${version}" does not exist for ${template.variant.name}`;
  return null;
}

/**
 * Turns "latest" into the newest release and picks the image with the Java the version needs.
 * Offline it keeps the settings as they are and uses the template's default image.
 */
export async function resolveVersion(providers: VersionProviders, template: Template, settings: Settings): Promise<{ settings: Settings; image: string }> {
  const field = template.config.find((f) => f.type === 'version');
  if (!field || !template.versions) return { settings, image: template.runtime.image };
  let version = String(settings[field.key]);
  if (isLatest(version)) version = (await providers.list(template.versions.provider))?.latest ?? version;
  const java = template.runtime.java && !isLatest(version) ? await providers.javaFor(version) : null;
  const image = (java !== null && template.runtime.java && imageForJava(template.runtime.java, java)) || template.runtime.image;
  return { settings: { ...settings, [field.key]: version }, image };
}
