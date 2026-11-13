import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { parse } from 'yaml';
import type { Db } from './db';
import { loadTemplates } from './template-source';

const fixtures = join(__dirname, '../test/templates');
const index = { templates: readdirSync(fixtures).map((f) => parse(readFileSync(join(fixtures, f), 'utf8'))) };

/** Just the cache table, in memory. */
function fakeDb() {
  let row: { index: unknown; fetchedAt: Date } | null = null;
  const templateCache = {
    upsert: async ({ create }: { create: { index: unknown } }) => (row = { index: create.index, fetchedAt: new Date() }),
    findUnique: async () => row,
  };
  return { db: { templateCache } as unknown as Db, row: () => row };
}

test('templates come from the index and are cached; without the index, from the cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'templates-'));
  const file = join(dir, 'index.json');
  writeFileSync(file, JSON.stringify(index));
  const { db, row } = fakeDb();

  const fresh = await loadTemplates(db, pathToFileURL(file).href);
  assert.equal(fresh.size, 4);
  assert.deepEqual(row()?.index, index);

  const offline = await loadTemplates(db, pathToFileURL(join(dir, 'missing.json')).href);
  assert.equal(offline.size, 4);

  writeFileSync(file, JSON.stringify({ templates: [] }));
  const empty = await loadTemplates(fakeDb().db, pathToFileURL(file).href);
  assert.equal(empty.size, 0, 'nothing cached and nothing usable: no templates, but the service starts');
});
