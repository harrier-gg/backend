import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import type { Db } from './db';
import { decrypt, encrypt, Settings } from './settings';

/** Just enough of the settings table, in memory. */
function fakeDb() {
  const rows = new Map<string, { key: string; value: string; secret: boolean }>();
  const db = {
    setting: {
      findMany: async ({ where }: { where: { key: { in: string[] } } }) => [...rows.values()].filter((r) => where.key.in.includes(r.key)),
      upsert: async ({ create }: { create: { key: string; value: string; secret: boolean } }) => rows.set(create.key, create),
      deleteMany: async ({ where }: { where: { key: string } }) => rows.delete(where.key),
    },
  } as unknown as Db;
  return { db, rows };
}

const appKey = randomBytes(32).toString('base64');

test('secrets are encrypted, bound to their key, and never listed', async () => {
  const { db, rows } = fakeDb();
  const settings = new Settings(db, appKey, {});
  assert.equal(await settings.set({ 'discord.botToken': 'bot.token-value_123', 'discord.channelId': '1234567890' }), null);

  const stored = rows.get('discord.botToken')!.value;
  assert.match(stored, /^v1:/);
  assert.ok(!stored.includes('bot.token-value_123'));
  assert.equal(rows.get('discord.channelId')!.value, '1234567890', 'not secret: stored as it is');
  assert.throws(() => decrypt(Buffer.from(appKey, 'base64'), 'discord.clientSecret', stored), 'moved to another key: refused');

  assert.equal(await settings.getOne('discord.botToken'), 'bot.token-value_123');
  const listed = await settings.list();
  assert.deepEqual(listed.find((s) => s.key === 'discord.botToken'), { key: 'discord.botToken', secret: true, set: true, value: null, fromEnv: false });
  assert.equal(listed.find((s) => s.key === 'discord.channelId')?.value, '1234567890');

  // Removing.
  assert.equal(await settings.set({ 'discord.botToken': null }), null);
  assert.equal(await settings.getOne('discord.botToken'), null);
});

test('the environment wins and cannot be changed from the panel', async () => {
  const { db } = fakeDb();
  const settings = new Settings(db, appKey, { HARRIER_DISCORD_CLIENT_ID: '1111111111' });
  assert.equal(await settings.getOne('discord.clientId'), '1111111111');
  assert.match((await settings.set({ 'discord.clientId': '2222222222' })) ?? '', /set in the environment/);
  assert.deepEqual((await settings.list()).find((s) => s.key === 'discord.clientId'), {
    key: 'discord.clientId',
    secret: false,
    set: true,
    value: '1111111111',
    fromEnv: true,
  });
});

test('without HARRIER_APP_KEY no secret is stored; invalid values are refused', async () => {
  const { db, rows } = fakeDb();
  const settings = new Settings(db, undefined, {});
  assert.match((await settings.set({ 'discord.botToken': 'abcdefghijklmnop' })) ?? '', /HARRIER_APP_KEY/);
  assert.equal(rows.size, 0);
  assert.match((await settings.set({ 'discord.channelId': 'not a snowflake' })) ?? '', /does not look right/);

  // A secret stored with another key reads as not set instead of failing.
  const other = encrypt(randomBytes(32), 'discord.botToken', 'secret.value.1234');
  rows.set('discord.botToken', { key: 'discord.botToken', value: other, secret: true });
  assert.equal(await new Settings(db, appKey, {}).getOne('discord.botToken'), null);
});
