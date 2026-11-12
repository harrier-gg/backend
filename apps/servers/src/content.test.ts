import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkedFileName, modrinth } from './content';
import { TemplateCatalog } from './templates';

const catalog = TemplateCatalog.fromDirectory(join(__dirname, '../../../templates'));

test('templates name their content kinds and sources (ADR 0017)', () => {
  assert.deepEqual(catalog.list().find((t) => t.id === 'minecraft-java/fabric')?.content, [
    { kind: 'mod', label: { en: 'Mods', de: 'Mods' }, path: 'mods', sources: ['modrinth'] },
  ]);
  assert.equal(catalog.list().find((t) => t.id === 'minecraft-java/paper')?.content[0].kind, 'plugin');
  assert.deepEqual(catalog.list().find((t) => t.id === 'minecraft-java/vanilla')?.content, []);
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
