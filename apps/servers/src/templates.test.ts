import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildSpec, knownSettings, TemplateCatalog, templateFileSchema, validateSettings } from './templates';

const catalog = TemplateCatalog.fromDirectory(join(__dirname, '../../../templates'));

test('the official templates load; abstract bases are not offered', () => {
  const ids = catalog.list().map((t) => t.id).sort();
  assert.deepEqual(ids, ['minecraft-java/fabric', 'minecraft-java/modrinth-modpack', 'minecraft-java/paper', 'minecraft-java/vanilla']);
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

/** One complete template with `extra` merged over it (fields not in the file format are cast). */
const egg = (extra: object) =>
  new TemplateCatalog([
    {
      schemaVersion: 1,
      id: 'g/v',
      abstract: false,
      game: { id: 'g', name: 'G' },
      variant: { id: 'v', name: 'V' },
      install: { method: 'script', image: 'ghcr.io/ptero-eggs/installers:debian', entrypoint: 'bash', script: 'echo hi' },
      runtime: { image: 'ghcr.io/ptero-eggs/yolks:debian', startup: './server -port {{SERVER_PORT}}', mountPath: '/home/container' },
      ports: [
        { name: 'game', container: 2456, protocol: 'udp', samePort: true },
        { name: 'query', container: 2457, protocol: 'udp' },
      ],
      config: [],
      lifecycle: { stop: { signal: 'SIGINT' } },
      capabilities: { players: { protocol: 'a2s', port: 'query' } },
      ...extra,
    } as never,
  ]).get('g/v')!;

test('egg-style templates: script install, startup, port offsets, stop and A2S parse', () => {
  const t = egg({});
  assert.deepEqual(t.install, { method: 'script', image: 'ghcr.io/ptero-eggs/installers:debian', entrypoint: 'bash', script: 'echo hi' });
  assert.equal(t.runtime.startup, './server -port {{SERVER_PORT}}');
  assert.equal(t.runtime.mountPath, '/home/container');
  assert.deepEqual(t.ports.map((p) => [p.offset, p.samePort]), [[0, true], [1, undefined]], 'offset defaults to the index');
  assert.deepEqual(t.lifecycle.stop, { signal: 'SIGINT' });
  assert.deepEqual(egg({ lifecycle: { stop: { command: 'save-all' } } }).lifecycle.stop, { command: 'save-all' });
  assert.deepEqual(t.capabilities.players, { protocol: 'a2s', port: 'query' });
  const ports = [{ name: 'a', container: 1, protocol: 'tcp', offset: 2 }, { name: 'b', container: 2, protocol: 'tcp' }];
  assert.deepEqual(egg({ ports, capabilities: {} }).ports.map((p) => p.offset), [2, 1]);
});

test('egg-style templates: bad values are rejected', () => {
  const bad: object[] = [
    { install: { method: 'script', image: 'x', entrypoint: 'bash' } }, // no script
    { install: { method: 'download' } }, // not runnable yet
    { runtime: { image: 'x', mountPath: 'home/container' } },
    { runtime: { image: 'x', mountPath: '/home/../etc' } },
    { ports: [{ name: 'game', container: 1, protocol: 'udp', offset: -1 }] },
    { ports: [{ name: 'game', container: 1, protocol: 'udp', samePort: 'yes' }] },
    { ports: [{ name: 'a', container: 1, protocol: 'udp', offset: 1 }, { name: 'b', container: 2, protocol: 'udp' }] }, // same offset
    { lifecycle: { stop: { signal: 'SIGKILL' } } },
    { lifecycle: { stop: { signal: 'SIGINT', command: 'stop' } } },
    { capabilities: { players: { protocol: 'gamespy' } } },
    { capabilities: { players: { protocol: 'a2s', port: 'missing' } } },
  ];
  for (const extra of bad) assert.throws(() => egg(extra), /incomplete/, JSON.stringify(extra));
});

test('boolean and secret fields', () => {
  const t = egg({
    config: [
      { key: 'public', label: { en: 'Public' }, type: 'boolean', default: true, env: 'PUBLIC', values: { on: '1', off: '0' } },
      { key: 'password', label: { en: 'Password' }, type: 'secret', default: 'hunter22', min: 5, max: 20, env: 'PASSWORD' },
    ],
  });
  assert.deepEqual(validateSettings(t, {}), { settings: { public: true, password: 'hunter22' } });
  assert.ok('settings' in validateSettings(t, { public: false, password: 'secret' }));
  assert.ok('error' in validateSettings(t, { public: 'true' }), 'values are not converted');
  assert.ok('error' in validateSettings(t, { public: 1 }));
  assert.ok('error' in validateSettings(t, { password: 'abc' }), 'too short');
  assert.ok('error' in validateSettings(t, { password: 'x'.repeat(21) }), 'too long');
  assert.ok('error' in validateSettings(t, { password: 12345 }));
  // `values` maps for the env var only; the API sees neither it nor env.
  assert.deepEqual(Object.keys(egg({ config: [{ key: 'b', label: { en: 'B' }, type: 'boolean', default: false, values: { on: '1', off: '0' } }] }).config[0]).sort(), ['default', 'key', 'label', 'type', 'values']);

  const field = (f: object) => egg({ config: [{ key: 'x', label: { en: 'X' }, ...f }] });
  assert.throws(() => field({ type: 'boolean', default: 'true' }), /default does not fit/);
  assert.throws(() => field({ type: 'secret', default: 'ab', min: 5 }), /default does not fit/);
  assert.throws(() => field({ type: 'string', default: 'x', values: { on: '1', off: '0' } }), /only for boolean/);
  assert.throws(() => field({ type: 'boolean', default: true, values: { on: '1' } }), /incomplete/);
});

test('template.schema.json is current (otherwise run `just schema`)', () => {
  const committed = JSON.parse(readFileSync(join(__dirname, '../../../template.schema.json'), 'utf8'));
  assert.deepEqual(templateFileSchema(), committed);
  // It describes files as written: abstract bases and variants with `extends` need only these.
  assert.deepEqual((committed as { required: string[] }).required, ['schemaVersion', 'id']);
});
