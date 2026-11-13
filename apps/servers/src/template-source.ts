// Loads templates from the templates repository's index (ADR 0021): at start and every hour,
// keeping the last good index in the database so the panel also starts without network.
import { Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Db } from './db';
import { TemplateCatalog } from './templates';

const REFRESH_MS = 60 * 60 * 1000;
const MAX_INDEX_BYTES = 10 * 1024 * 1024;

async function fetchIndex(url: string): Promise<unknown> {
  // `file://` for development against a local checkout of the templates repository.
  const text = url.startsWith('file:')
    ? await readFile(fileURLToPath(url), 'utf8')
    : await fetch(url, { signal: AbortSignal.timeout(15_000) }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      });
  if (text.length > MAX_INDEX_BYTES) throw new Error('index is too large');
  return JSON.parse(text);
}

/** The URL without credentials or query, for logs (a private mirror may take a token). */
function forLog(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}${u.pathname}`;
}

export async function loadTemplates(db: Db, url: string): Promise<TemplateCatalog> {
  const log = new Logger('Templates');
  const where = forLog(url);
  const catalog = new TemplateCatalog();
  const skip = (id: string, reason: string) => log.warn(`Template ${id} skipped: ${reason}`);
  // A broken or empty index never replaces working templates.
  const apply = (index: unknown) => {
    const files = TemplateCatalog.parseIndex(index, skip);
    if (!files.length) throw new Error('the index has no templates');
    catalog.load(files, skip);
  };
  const refresh = async () => {
    const index = await fetchIndex(url);
    apply(index);
    await db.templateCache.upsert({ where: { id: 1 }, create: { id: 1, index: index as object }, update: { index: index as object, fetchedAt: new Date() } });
    log.log(`${catalog.size} templates from ${where}`);
  };

  try {
    await refresh();
  } catch (e) {
    const cached = await db.templateCache.findUnique({ where: { id: 1 } });
    if (!cached) log.error(`No templates: ${where} failed (${(e as Error).message}) and nothing is cached yet; retrying hourly`);
    else {
      apply(cached.index);
      log.warn(`${where} failed (${(e as Error).message}); using the copy from ${cached.fetchedAt.toISOString()}`);
    }
  }
  setInterval(() => refresh().catch((e) => log.warn(`Refreshing templates failed: ${(e as Error).message}`)), REFRESH_MS).unref();
  return catalog;
}
