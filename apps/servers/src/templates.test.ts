import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildSpec, knownSettings, TemplateCatalog, validateSettings } from './templates';

const catalog = TemplateCatalog.fromDirectory(join(__dirname, '../../../templates'));

test('the official templates load; abstract bases are not offered', () => {
  const ids = catalog.list().map((t) => t.id).sort();
  assert.deepEqual(ids, ['minecraft-java/fabric', 'minecraft-java/paper', 'minecraft-java/vanilla']);
});

test('variants inherit from their base and override only what differs', () => {
  const paper = catalog.get('minecraft-java/paper')!;
  assert.equal(paper.game.id, 'minecraft-java');
  assert.equal(paper.runtime.image, 'itzg/minecraft-server:java25');
  assert.equal(paper.runtime.env.TYPE, 'PAPER');
  assert.equal(paper.runtime.env.EULA, 'TRUE');
  assert.deepEqual(paper.files.map((f) => f.path), ['server.properties']);
});

test('config file paths stay inside the data directory', () => {
  const template = (path: string) =>
    new TemplateCatalog([
      {
        schemaVersion: 1,
        id: 'g/v',
        abstract: false,
        game: { id: 'g', name: 'G' },
        variant: { id: 'v', name: 'V' },
        install: { method: 'image' },
        runtime: { image: 'img', env: {} },
        ports: [{ name: 'game', container: 1000, protocol: 'tcp' }],
        config: [],
        lifecycle: {},
        capabilities: {},
        files: [{ path }],
      },
    ]);
  assert.doesNotThrow(() => template('config/paper-global.yml'));
  for (const path of ['../x', '/etc/passwd', 'a/../b', '.env', 'a//b', '']) {
    assert.throws(() => template(path), /files/, path);
  }
});

test('settings get defaults and are checked against the template', () => {
  const paper = catalog.get('minecraft-java/paper')!;
  assert.deepEqual(validateSettings(paper, {}), {
    settings: { version: 'LATEST', memory: 2048, sleepAfter: 15 },
  });
  assert.ok('error' in validateSettings(paper, { memory: 512 }));
  assert.ok('error' in validateSettings(paper, { version: '1.21; rm -rf /' }));
  assert.ok('error' in validateSettings(paper, { unknown: 'x' }));
  // Stored settings of fields the template dropped since are ignored, not rejected.
  assert.deepEqual(knownSettings(paper, { memory: 4096, pvp: false }), { memory: 4096 });
  assert.ok('error' in validateSettings(paper, { memory: '4096' }), 'values are not converted');
});

test('field definitions are checked when templates load', () => {
  const base = { schemaVersion: 1 as const, id: 'g/v', abstract: false, game: { id: 'g', name: 'G' }, variant: { id: 'v', name: 'V' } };
  const field = (f: object) => new TemplateCatalog([{ ...base, config: [{ key: 'x', label: { en: 'X' }, ...f } as never] }]);
  assert.throws(() => field({ type: 'integer', default: 5, min: 10 }), /default does not fit/);
});

test('the runtime spec is game-neutral and carries env, limits and ports', () => {
  const paper = catalog.get('minecraft-java/paper')!;
  const result = validateSettings(paper, { version: '1.21.4', memory: 4096 });
  assert.ok('settings' in result);
  const spec = buildSpec(paper, result.settings, 25566);
  assert.equal(spec.env.VERSION, '1.21.4');
  assert.equal(spec.env.TYPE, 'PAPER');
  assert.equal(spec.memoryMb, 4096);
  assert.deepEqual(spec.ports, [{ containerPort: 25565, hostPort: 25566, protocol: 'tcp' }]);
  assert.deepEqual(spec.query, { protocol: 'minecraft', port: 25566 });
  assert.equal(spec.sleep?.idleMinutes, 15);
  assert.deepEqual([spec.sleep?.wake?.protocol, spec.sleep?.wake?.port], ['minecraft', 25566], 'woken on the game port');
  assert.equal(buildSpec(paper, { ...result.settings, sleepAfter: 0 }, 25566).sleep, null, '0 = never');
  assert.ok(spec.readyPattern && new RegExp(spec.readyPattern).test('[Server thread/INFO]: Done (3.2s)! For help, type "help"'));

  // The backup waits for the game's save confirmation, which players cannot fake in chat.
  const saved = new RegExp(paper.capabilities.backup!.ready!);
  assert.ok(saved.test('[16:21:41] [Server thread/INFO]: System chat: Saved the game'));
  assert.ok(saved.test('[16:21:41] [Server thread/INFO]: Saved the game'), 'older versions');
  assert.ok(saved.test('[16:21:41 INFO]: Saved the game'), 'Paper');
  assert.ok(!saved.test('[16:21:41] [Server thread/INFO]: <Griefer> INFO]: Saved the game'));
  assert.ok(!saved.test('[16:21:41 INFO]: <Griefer> [16:21:41 INFO]: Saved the game'));
  assert.ok(!saved.test('[16:21:41] [Server thread/INFO]: <Griefer> Saved the game'));
  assert.ok(!saved.test('[16:21:41] [Async Chat Thread - #0/INFO]: <Griefer> ]: Saved the game'));
});

test('a variant whose base is missing is reported clearly', () => {
  assert.throws(
    () => new TemplateCatalog([{ schemaVersion: 1, id: 'x/y', extends: 'missing', abstract: false }]),
    /base "missing" not found/,
  );
});
