import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDue } from './backups.controller';

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
