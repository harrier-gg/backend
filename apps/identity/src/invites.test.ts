import assert from 'node:assert/strict';
import { test } from 'node:test';
import { can } from '@harrier-gg/contracts';
import { mayManage } from './invites.controller';

test('members may play, admins may manage members, only the owner manages admins (ADR 0007)', () => {
  assert.equal(can('member', 'startStopServers'), true);
  assert.equal(can('member', 'sendCommands'), false);
  assert.equal(can('admin', 'sendCommands'), true);

  assert.equal(mayManage('member', 'member'), false);
  assert.equal(mayManage('admin', 'member'), true);
  assert.equal(mayManage('admin', 'admin'), false);
  assert.equal(mayManage('owner', 'admin'), true);
});

test('nobody can hand out or take away the owner role', () => {
  for (const actor of ['member', 'admin', 'owner'] as const) assert.equal(mayManage(actor, 'owner'), false);
});
