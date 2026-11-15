import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackupsController, isDue } from './backups.controller';

const now = new Date('2026-11-11T12:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000);

test('a backup is due when scheduled, the server ran since, and the last one is old enough', () => {
  assert.equal(isDue({ backupEveryHours: 24, lastBackupAt: null, activeSinceBackup: true }, now), true);
  assert.equal(isDue({ backupEveryHours: 24, lastBackupAt: hoursAgo(25), activeSinceBackup: true }, now), true);
  assert.equal(isDue({ backupEveryHours: 24, lastBackupAt: hoursAgo(23), activeSinceBackup: true }, now), false);
  // Only by hand.
  assert.equal(isDue({ backupEveryHours: 0, lastBackupAt: null, activeSinceBackup: true }, now), false);
  // A server that did not run since its last backup keeps its older, different backups.
  assert.equal(isDue({ backupEveryHours: 24, lastBackupAt: hoursAgo(100), activeSinceBackup: false }, now), false);
});

test('a disconnected agent frees its servers from running backups and restores (#49)', async () => {
  const node = '01a1d517-c405-7289-b5bc-01e8d9fcd58e';
  const db = { server: { findMany: async () => [{ id: 's1' }, { id: 's2' }, { id: 's3' }] } };
  const backups = new BackupsController(db as never, {} as never, {} as never);
  const state = backups as unknown as { inProgress: Map<string, string>; lastError: Map<string, string> };
  state.inProgress.set('s1', 'create').set('s2', 'restore').set('other-node', 'create');

  await backups.onDisconnected({ nodeId: node });

  assert.deepEqual([...state.inProgress.keys()], ['other-node']);
  assert.match(state.lastError.get('s1')!, /offline during the backup/);
  assert.match(state.lastError.get('s2')!, /offline during the restore/);
  assert.equal(state.lastError.has('s3'), false);
  await backups.onDisconnected({ nodeId: 'not a uuid' });
});
