import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { TemplateCatalog } from './templates';
import { checkVersion, imageForJava, resolveVersion, VersionProviders, type FetchJson } from './versions';

const catalog = TemplateCatalog.fromDirectory(join(__dirname, '../../../templates'));

/** Answers like the real sources, without the network. */
function fakeSources(): { fetch: FetchJson; calls: string[]; down: Set<string> } {
  const calls: string[] = [];
  const down = new Set<string>();
  const data: Record<string, unknown> = {
    'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json': {
      latest: { release: '26.3', snapshot: '26.4-snapshot-8' },
      versions: [
        { id: '26.4-snapshot-8', type: 'snapshot', url: 'm/26.4-snapshot-8.json' },
        { id: '26.3', type: 'release', url: 'm/26.3.json' },
        { id: '1.21.11-rc3', type: 'snapshot', url: 'm/1.21.11-rc3.json' },
        { id: '1.16.5', type: 'release', url: 'm/1.16.5.json' },
        { id: 'b1.7.3', type: 'old_beta', url: 'm/b1.7.3.json' },
      ],
    },
    'm/26.3.json': { javaVersion: { majorVersion: 25 } },
    'm/1.16.5.json': {}, // before 1.17: no javaVersion
    'https://fill.papermc.io/v3/projects/paper': { versions: { '26.3': ['26.3', '26.3-rc-3'], '1.21': ['1.21.11-rc3'], '1.16': ['1.16.5'] } },
    'https://meta.fabricmc.net/v2/versions/game': [
      { version: '26.4-snapshot-8', stable: false },
      { version: '26.3', stable: true },
    ],
  };
  const fetch: FetchJson = async (url) => {
    calls.push(url);
    if (down.has(url) || !(url in data)) throw new Error(`${url} unreachable`);
    return data[url];
  };
  return { fetch, calls, down };
}

test('each provider lists versions newest first and knows the latest release', async () => {
  const providers = new VersionProviders(fakeSources().fetch);
  const mojang = await providers.list('mojang');
  assert.equal(mojang?.latest, '26.3');
  assert.deepEqual(mojang?.versions.map((v) => v.id), ['26.4-snapshot-8', '26.3', '1.21.11-rc3', '1.16.5'], 'old_beta is left out');

  const paper = await providers.list('papermc');
  assert.deepEqual(paper, {
    latest: '26.3',
    versions: [
      { id: '26.3', type: 'release' },
      { id: '26.3-rc-3', type: 'snapshot' },
      { id: '1.21.11-rc3', type: 'snapshot' },
      { id: '1.16.5', type: 'release' },
    ],
  });
  assert.equal((await providers.list('fabric'))?.latest, '26.3');
});

test('lists are cached for an hour and kept while the source is down', async () => {
  const sources = fakeSources();
  let now = 0;
  const providers = new VersionProviders(sources.fetch, () => now);
  await providers.list('fabric');
  await providers.list('fabric');
  assert.equal(sources.calls.length, 1);

  now = 2 * 60 * 60 * 1000;
  sources.down.add('https://meta.fabricmc.net/v2/versions/game');
  assert.equal((await providers.list('fabric'))?.latest, '26.3', 'the last list is kept');
  assert.equal(await new VersionProviders(sources.fetch).list('fabric'), null, 'never reached: no list');
});

test('the image follows the Java a version needs', async () => {
  const providers = new VersionProviders(fakeSources().fetch);
  assert.equal(await providers.javaFor('26.3'), 25);
  assert.equal(await providers.javaFor('1.16.5'), 8);
  assert.equal(await providers.javaFor('9.9.9'), null);

  const images = { '8': 'img:java8', '17': 'img:java17', '25': 'img:java25' };
  assert.equal(imageForJava(images, 8), 'img:java8');
  assert.equal(imageForJava(images, 16), 'img:java17', 'the smallest Java that is new enough');
  assert.equal(imageForJava(images, 30), 'img:java25', 'nothing new enough: the newest');
});

test('starting resolves "latest" and picks the image; offline keeps the default', async () => {
  const paper = catalog.get('minecraft-java/paper')!;
  const sources = fakeSources();
  const providers = new VersionProviders(sources.fetch);

  assert.deepEqual(await resolveVersion(providers, paper, { version: 'LATEST', memory: 2048 }), {
    settings: { version: '26.3', memory: 2048 },
    image: 'itzg/minecraft-server:java25',
  });
  assert.equal((await resolveVersion(providers, paper, { version: '1.16.5', memory: 2048 })).image, 'itzg/minecraft-server:java8');

  const offline = new VersionProviders(async () => {
    throw new Error('offline');
  });
  assert.deepEqual(await resolveVersion(offline, paper, { version: 'LATEST', memory: 2048 }), {
    settings: { version: 'LATEST', memory: 2048 },
    image: 'itzg/minecraft-server:java25',
  });
});

test('only versions the provider knows can be chosen; offline any version name', async () => {
  const fabric = catalog.get('minecraft-java/fabric')!;
  const providers = new VersionProviders(fakeSources().fetch);
  assert.equal(await checkVersion(providers, fabric, { version: '26.3' }), null);
  assert.equal(await checkVersion(providers, fabric, { version: 'latest' }), null);
  assert.match((await checkVersion(providers, fabric, { version: '1.16.5' })) ?? '', /does not exist for Fabric/);

  const offline = new VersionProviders(async () => {
    throw new Error('offline');
  });
  assert.equal(await checkVersion(offline, fabric, { version: '1.16.5' }), null);
});
