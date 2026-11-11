import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildSpec, TemplateCatalog, validateSettings } from './templates';

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
});

test('settings get defaults and are checked against the template', () => {
  const paper = catalog.get('minecraft-java/paper')!;
  assert.deepEqual(validateSettings(paper, {}), { settings: { version: 'LATEST', memory: 2048, motd: 'A Harrier server' } });
  assert.ok('error' in validateSettings(paper, { memory: 512 }));
  assert.ok('error' in validateSettings(paper, { version: '1.21; rm -rf /' }));
  assert.ok('error' in validateSettings(paper, { motd: 'two\nlines' }));
  assert.ok('error' in validateSettings(paper, { unknown: 'x' }));
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
  assert.ok(spec.readyPattern && new RegExp(spec.readyPattern).test('[Server thread/INFO]: Done (3.2s)! For help, type "help"'));
});

test('a variant whose base is missing is reported clearly', () => {
  assert.throws(
    () => new TemplateCatalog([{ schemaVersion: 1, id: 'x/y', extends: 'missing', abstract: false }]),
    /base "missing" not found/,
  );
});
