import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerSummary, UserSummary } from '@harrier-gg/contracts';
import { command, Notifications, suggest, type Harrier } from './bot';

const user = (role: UserSummary['role']): UserSummary => ({ id: 'u1', email: 'a@b.c', name: 'Anil', role, discord: 'anil' });
const server = (name: string, status: ServerSummary['status']): ServerSummary => ({
  id: `id-${name}`,
  name,
  nodeId: 'n1',
  templateId: 'minecraft-java/vanilla',
  settings: {},
  hostPort: 25565,
  status,
  statusMessage: null,
  createdAt: '2026-11-11T00:00:00.000Z',
});

/** Harrier with one linked Discord user (`d1`) and a list of servers; records start/stop calls. */
function fake(role: UserSummary['role'], servers: ServerSummary[], error: string | null = null) {
  const calls: string[] = [];
  const harrier: Harrier = {
    userByDiscord: async (id) => (id === 'd1' ? user(role) : null),
    servers: async () => servers,
    start: async (id) => (calls.push(`start ${id}`), error),
    stop: async (id) => (calls.push(`stop ${id}`), error),
  };
  return { harrier, calls };
}

test('only linked accounts with the right role can use the commands', async () => {
  const { harrier, calls } = fake('member', [server('Lobby', 'stopped')]);
  assert.match((await command(harrier, 'status', { discordId: 'unknown' })).content, /Link your Discord account/);
  assert.match((await command(harrier, 'start', { discordId: 'unknown', locale: 'de', server: 'Lobby' })).content, /Verknüpfe/);

  // Members may start and stop (ADR 0007).
  const started = await command(harrier, 'start', { discordId: 'd1', server: 'lobby' });
  assert.deepEqual(started, { content: '▶️ Anil starts **Lobby** …', ephemeral: false });
  assert.deepEqual(calls, ['start id-Lobby']);
});

test('status lists every server in the caller’s language, only for the caller', async () => {
  const { harrier } = fake('member', [server('Lobby', 'running'), server('Retro', 'sleeping')]);
  const reply = await command(harrier, 'status', { discordId: 'd1', locale: 'de' });
  assert.deepEqual(reply, { content: '🟢 **Lobby** · läuft · Port 25565\n💤 **Retro** · schläft · Port 25565', ephemeral: true });
});

test('start wakes sleeping servers and refuses running ones; errors are shown', async () => {
  const { harrier } = fake('member', [server('Lobby', 'sleeping'), server('Busy', 'running')]);
  assert.equal((await command(harrier, 'start', { discordId: 'd1', locale: 'de', server: 'id-Lobby' })).content, '⏰ Anil weckt **Lobby** auf …');
  assert.match((await command(harrier, 'start', { discordId: 'd1', server: 'Busy' })).content, /already running/);
  assert.match((await command(harrier, 'stop', { discordId: 'd1', server: 'Nope' })).content, /no server called "Nope"/);

  const offline = fake('member', [server('Lobby', 'stopped')], 'The node is offline.');
  assert.deepEqual(await command(offline.harrier, 'start', { discordId: 'd1', server: 'Lobby' }), {
    content: 'That did not work: The node is offline.',
    ephemeral: true,
  });
});

test('autocomplete offers matching server names', async () => {
  const { harrier } = fake('member', [server('Lobby', 'stopped'), server('Survival', 'running')]);
  assert.deepEqual(await suggest(harrier, 'surv'), [{ name: 'Survival', value: 'id-Survival' }]);
});

test('notifications only for changes the bot saw happen', () => {
  const n = new Notifications();
  // After a restart of the bot or an agent reconnect, states are repeated: no message.
  assert.equal(n.observe('s', 'running', false), null);
  assert.equal(n.observe('s', 'running', false), null);

  assert.equal(n.observe('s', 'stopping', false), null);
  assert.equal(n.observe('s', 'stopped', false), null);
  assert.equal(n.observe('s', 'starting', false), null);
  assert.equal(n.observe('s', 'running', false), 'online');

  // A crash with a restart pending is not final; the crash after the last attempt is.
  assert.equal(n.observe('s', 'crashed', true), null);
  assert.equal(n.observe('s', 'starting', false), null);
  assert.equal(n.observe('s', 'crashed', false), 'crashed');
  assert.equal(n.observe('s', 'crashed', false), null);
});
