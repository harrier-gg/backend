import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkedFileName, hangar, hashOnce, modrinth, orphans, thunderstore } from './content';
import { TemplateCatalog } from './templates';

const catalog = TemplateCatalog.fromDirectory(join(__dirname, '../test/templates'));

test('templates name their content kinds and sources (ADR 0017)', () => {
  assert.deepEqual(catalog.list().find((t) => t.id === 'minecraft-java/fabric')?.content, [
    { kind: 'mod', label: { en: 'Mods', de: 'Mods' }, path: 'mods', sources: ['modrinth'] },
  ]);
  assert.equal(catalog.list().find((t) => t.id === 'minecraft-java/paper')?.content[0].kind, 'plugin');
  assert.deepEqual(catalog.list().find((t) => t.id === 'minecraft-java/vanilla')?.content, []);
  assert.deepEqual(catalog.list().find((t) => t.id === 'valheim/bepinex')?.content, [
    { kind: 'mod', label: { en: 'Mods', de: 'Mods' }, path: 'BepInEx/plugins', sources: ['thunderstore'] },
  ]);
});

test('the Modrinth adapter filters by type, loader and version and picks the primary file', async () => {
  const asked: string[] = [];
  const provider = modrinth(async (url) => {
    asked.push(decodeURIComponent(url));
    if (url.includes('/search')) {
      return {
        hits: [
          { project_id: 'AANobbMI', slug: 'sodium', title: 'Sodium', description: 'Fast', author: 'jelly', downloads: 9, icon_url: null, client_side: 'required', server_side: 'unsupported' },
        ],
      };
    }
    return [
      {
        id: 'v1',
        name: 'Fabric API',
        version_number: '0.166.2+26.3',
        environment: 'client_or_server_prefers_both',
        files: [
          { url: 'https://cdn.modrinth.com/sources.jar', filename: 'sources.jar', primary: false, size: 1, hashes: { sha1: 'a' } },
          { url: 'https://cdn.modrinth.com/fabric-api.jar', filename: 'fabric-api-0.166.2+26.3.jar', primary: true, size: 2, hashes: { sha512: 'b', sha1: 'c' } },
        ],
        dependencies: [
          { project_id: 'needed', dependency_type: 'required' },
          { project_id: 'nice', dependency_type: 'optional' },
        ],
      },
    ];
  });
  const options = provider.parse({ provider: 'modrinth', type: 'mod', loader: 'fabric' });

  const [sodium] = await provider.search(options, 'sodium', '26.3');
  assert.equal(sodium.side, 'client', 'the server does not support it: only players need it');
  assert.match(asked[0], /"project_type:mod"\],\["categories:fabric"\],\["versions:26.3"\]/);
  assert.equal(sodium.pageUrl, 'https://modrinth.com/mod/sodium');

  // Modpacks bring their own loader (ADR 0020): no loader facet, and a link the image takes.
  const [pack] = await provider.search(provider.parse({ provider: 'modrinth', type: 'modpack' }), 'pack', '');
  assert.equal(pack.pageUrl, 'https://modrinth.com/modpack/sodium');
  assert.match(asked.at(-1)!, /facets=\[\["project_type:modpack"\]\]&/);
  asked.length = 1;

  const version = await provider.latest(options, 'P7dR8mSH', '26.3');
  assert.deepEqual(version, {
    id: 'v1',
    name: '0.166.2+26.3',
    artifact: { url: 'https://cdn.modrinth.com/fabric-api.jar', fileName: 'fabric-api-0.166.2+26.3.jar', size: 2, sha512: 'b', sha1: 'c' },
    requires: ['needed'],
    side: 'both',
  });
  assert.match(asked[1], /loaders=\["fabric"\]&game_versions=\["26.3"\]/);

  assert.throws(() => provider.parse({ provider: 'modrinth', type: 'mod' }), 'a source without loader is a template error');
});

test('only plain file names reach the agent', () => {
  assert.equal(checkedFileName('fabric-api-0.166.2+26.3.jar'), 'fabric-api-0.166.2+26.3.jar');
  for (const bad of ['../evil.jar', 'a/b.jar', '.hidden', '']) assert.throws(() => checkedFileName(bad), bad);
});

test('updates for all files in one request; no answer means nothing fits the version any more', async () => {
  let asked: unknown;
  const provider = modrinth(async (_url, body) => {
    asked = body;
    return {
      aaa: { id: 'new', name: 'x', version_number: '2.0', files: [{ url: 'https://cdn.modrinth.com/x.jar', filename: 'x.jar', primary: true, size: 1, hashes: { sha512: 'n' } }], dependencies: [] },
    };
  });
  const options = provider.parse({ provider: 'modrinth', type: 'mod', loader: 'fabric' });
  const found = await provider.updates(
    options,
    [
      { projectId: 'X', sha512: 'AAA', sha1: null },
      { projectId: 'Y', sha512: 'bbb', sha1: null },
      { projectId: 'Z', sha512: null, sha1: 'only-sha1' },
    ],
    '26.3',
  );
  assert.deepEqual(asked, { hashes: ['aaa', 'bbb'], algorithm: 'sha512', loaders: ['fabric'], game_versions: ['26.3'] });
  assert.equal(found.get('X')?.name, '2.0');
  assert.equal(found.get('Y'), null, 'no fitting version: incompatible');
  assert.equal(found.has('Z'), false, 'a file the provider cannot look up is left out');
});

test('removing content cleans up dependencies nobody needs any more', () => {
  const row = (id: string, dependency: boolean, requires: string[] = []) => ({ id, provider: 'modrinth', projectId: id, dependency, requires });
  const chunky = row('chunky', false, ['fabric-api']);
  const lithium = row('lithium', false);
  const api = row('fabric-api', true, ['lib']);
  const lib = row('lib', true);
  const modMenu = row('modmenu', false, ['fabric-api']);

  assert.deepEqual(orphans([chunky, lithium, api, lib], [chunky]).map((r) => r.id), ['fabric-api', 'lib'], 'also dependencies of dependencies');
  assert.deepEqual(orphans([chunky, modMenu, api, lib], [chunky]), [], 'still needed by Mod Menu');
  assert.deepEqual(orphans([chunky, api, row('picked', false)], [chunky]).map((r) => r.id), ['fabric-api'], 'what a user picked stays');
});

test('hangar: release channel first, SHA-256, Hangar dependencies only', async () => {
  const urls: string[] = [];
  const version = (name: string, file: boolean) => ({
    id: 7,
    name,
    downloads: {
      PAPER: file
        ? { fileInfo: { name: 'ViaBackwards-5.1.jar', sizeBytes: 3, sha256Hash: 'abc' }, downloadUrl: 'https://hangarcdn.papermc.io/v.jar' }
        : { fileInfo: null, downloadUrl: null },
    },
    pluginDependencies: {
      PAPER: [
        { projectId: 31, required: true },
        { projectId: 112, required: false },
        { projectId: null, required: true },
      ],
    },
  });
  const provider = hangar(async (url) => {
    urls.push(url);
    if (url.includes('/projects/12/versions')) return { result: url.includes('channel=Release') ? [version('5.1', true)] : [] };
    if (url.includes('/projects/40/versions')) return { result: url.includes('channel=Release') ? [] : [version('2.0-SNAPSHOT', false)] };
    throw new Error(url);
  });
  const options = provider.parse({ provider: 'hangar', platform: 'PAPER' });

  assert.deepEqual(await provider.latest(options, '12', '1.21.4'), {
    id: '7',
    name: '5.1',
    artifact: { url: 'https://hangarcdn.papermc.io/v.jar', fileName: 'ViaBackwards-5.1.jar', size: 3, sha256: 'abc' },
    requires: ['31'],
    side: 'server',
  });
  assert.match(urls[0], /platform=PAPER&platformVersion=1\.21\.4&channel=Release/);

  // No release: the newest of any channel; a file only linked elsewhere has no URL.
  const linked = await provider.latest(options, '40', '1.21.4');
  assert.equal(linked?.name, '2.0-SNAPSHOT');
  assert.equal(linked?.artifact.url, null);
  assert.throws(() => provider.parse({ provider: 'hangar', platform: 'paper' }));
});

test('thunderstore: search, newest version as a zip, dependencies without the loader (ADR 0023)', async () => {
  const urls: string[] = [];
  const listing = (namespace: string, name: string, categories: string[]) => ({
    namespace,
    name,
    description: 'd',
    download_count: 5,
    icon_url: null,
    categories: categories.map((c) => ({ name: c })),
  });
  const provider = thunderstore(async (url) => {
    urls.push(url);
    if (url.includes('/cyberstorm/listing/valheim/'))
      return {
        results: [
          listing('ArgusMagnus', 'ServersideQoL', ['Server-side']),
          listing('denikson', 'BepInExPack_Valheim', ['Libraries']),
          listing('Advize', 'PlantEverything', ['Server-side', 'Client-side']),
          listing('ebkr', 'r2modman', ['Tools']),
        ],
      };
    if (url.endsWith('/experimental/package/RandyKnapp/EpicLoot/'))
      return {
        namespace: 'RandyKnapp',
        name: 'EpicLoot',
        owner: 'RandyKnapp',
        total_downloads: 9,
        latest: {
          version_number: '0.11.4',
          description: 'Loot',
          icon: null,
          download_url: 'https://thunderstore.io/package/download/RandyKnapp/EpicLoot/0.11.4/',
          dependencies: ['denikson-BepInExPack_Valheim-5.4.2333', 'ValheimModding-Jotunn-2.30.2'],
        },
        community_listings: [{ community: 'valheim', categories: ['Mods', 'Client-side'] }],
      };
    throw new Error(url);
  });
  const options = provider.parse({
    provider: 'thunderstore',
    community: 'valheim',
    provides: ['denikson-BepInExPack_Valheim'],
    folders: { patchers: 'BepInEx/patchers' },
  });

  const found = await provider.search(options, 'qol', '');
  assert.match(urls[0], /\/api\/cyberstorm\/listing\/valheim\/\?q=qol&ordering=most-downloaded&deprecated=false&nsfw=false$/);
  assert.deepEqual(
    found.map((p) => [p.id, p.side]),
    [
      ['ArgusMagnus-ServersideQoL', 'server'],
      ['Advize-PlantEverything', 'both'],
    ],
  );
  assert.equal(found[0].pageUrl, 'https://thunderstore.io/c/valheim/p/ArgusMagnus/ServersideQoL/');

  assert.deepEqual(await provider.latest(options, 'RandyKnapp-EpicLoot', ''), {
    id: '0.11.4',
    name: '0.11.4',
    artifact: {
      url: 'https://thunderstore.io/package/download/RandyKnapp/EpicLoot/0.11.4/',
      fileName: 'RandyKnapp-EpicLoot',
      size: 0,
      extract: true,
      routes: [{ from: 'patchers', to: 'BepInEx/patchers/RandyKnapp-EpicLoot' }],
    },
    requires: ['ValheimModding-Jotunn'],
    side: 'client',
  });
  await assert.rejects(provider.latest(options, '../x', ''), /Unexpected Thunderstore package/);
  assert.throws(() => provider.parse({ provider: 'thunderstore', community: '../valheim' }));
  assert.throws(() => provider.parse({ provider: 'thunderstore', community: 'valheim', folders: { patchers: '../etc' } }));
  assert.throws(() => provider.parse({ provider: 'thunderstore', community: 'valheim', folders: { 'a/b': 'BepInEx/patchers' } }));
});

test('hashOnce downloads a file once and keeps its hash and size', async () => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.end('zip bytes');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mod.zip`;
    const expected = { sha256: createHash('sha256').update('zip bytes').digest('hex'), size: 9 };
    assert.deepEqual(await hashOnce(url), expected);
    assert.deepEqual(await hashOnce(url), expected);
    assert.equal(requests, 1);
  } finally {
    server.close();
  }
});
