import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32 } from 'node:zlib';
import { forPlayers, loaderVersion, mrpackIndex, zipOne, type PackFile } from './share';

const file = (name: string, side: string | null, extra: Partial<PackFile> = {}): PackFile => ({
  name,
  path: `mods/${name}.jar`,
  url: `https://cdn.modrinth.com/${name}.jar`,
  size: 10,
  sha1: 'a1',
  sha512: 'b512',
  side,
  ...extra,
});

test('players get client and shared content, not server-only content', () => {
  assert.deepEqual(['client', 'both', null, 'server'].map(forPlayers), [true, true, true, false]);
});

test('the pack index follows Modrinth\'s format and leaves out what it cannot link', () => {
  const { index, missing } = mrpackIndex({
    name: 'Survival',
    versionId: 'abc',
    gameVersion: '26.3',
    loader: 'fabric-loader',
    loaderVersion: '0.20.1',
    files: [file('sodium', 'client'), file('fabric-api', 'both'), file('manual', 'client', { url: null }), file('old', 'both', { sha1: null })],
  });
  assert.deepEqual(index.dependencies, { minecraft: '26.3', 'fabric-loader': '0.20.1' });
  assert.deepEqual(index.files.map((f) => [f.path, f.env.server]), [
    ['mods/sodium.jar', 'unsupported'],
    ['mods/fabric-api.jar', 'required'],
  ]);
  assert.deepEqual(index.files[0].hashes, { sha1: 'a1', sha512: 'b512' });
  assert.deepEqual(missing, ['manual', 'old'], 'no link or not both hashes');
});

test('the zip holds exactly one stored entry with a correct checksum', () => {
  const data = Buffer.from('{"formatVersion":1}');
  const zip = zipOne('modrinth.index.json', data);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(14), crc32(data));
  const nameLength = zip.readUInt16LE(26);
  assert.equal(zip.subarray(30, 30 + nameLength).toString(), 'modrinth.index.json');
  assert.deepEqual(zip.subarray(30 + nameLength, 30 + nameLength + data.length), data);
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt32LE(zip.readUInt32LE(end + 16)), 0x02014b50, 'the end record points at the central directory');
});

test('the loader is the newest stable one for the game version', async () => {
  const fake = async () => [{ loader: { version: '0.21.0', stable: false } }, { loader: { version: '0.20.1', stable: true } }];
  assert.equal(await loaderVersion('fabric-loader', '26.3', fake), '0.20.1');
  await assert.rejects(loaderVersion('forge', '26.3', fake));
});
