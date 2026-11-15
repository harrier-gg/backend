import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword } from './crypto';
import { FailureLimit, clientKey } from './failure-limit';
import { IdentityController } from './identity.controller';

test('parallel wrong passwords are limited before hashing, per e-mail and address', async () => {
  const passwordHash = await hashPassword('correct horse battery');
  const db = {
    user: { findUnique: async () => ({ id: 'u', email: 'owner@harrier.test', name: 'O', role: 'owner', passwordHash, createdAt: new Date() }) },
    session: { create: async () => ({}) },
  };
  const identity = new IdentityController(db as never, { token: null } as never);
  const login = (password: string, from = '203.0.113.7') => identity.login({ email: 'owner@harrier.test', password, from });

  // 30 guesses at once: all are counted before any hash finishes. At most 4 are hashed at the
  // same time (the rest are told to retry), and never more than 10 get through.
  const replies = await Promise.all(Array.from({ length: 30 }, () => login('wrong password!')));
  const codes = replies.map((r) => ('error' in r ? r.error.status : 200));
  assert.equal(codes.filter((c) => c === 401).length <= 10, true);
  assert.equal(codes.includes(200), false);
  for (let i = 0; i < 12; i++) await login('wrong password!');
  const locked = await login('correct horse battery');
  assert.equal('error' in locked && locked.error.status, 429);

  // The owner's own address isn't locked out by someone else's guesses.
  const own = await login('correct horse battery', '198.51.100.1');
  assert.equal('error' in own, false);
});

test('a full limit refuses unknown keys instead of forgetting live ones', () => {
  const limit = new FailureLimit(2, 1000, 2);
  limit.fail('owner@x', 0);
  limit.fail('a@x', 0);
  // Full of live counters: a flood of new keys can't push the owner's counter out.
  assert.equal(limit.blocked('b@x', 10), true);
  limit.fail('owner@x', 10);
  assert.equal(limit.blocked('owner@x', 10), true);
  // Expired counters make room again; forgiving takes one failure back.
  assert.equal(limit.blocked('b@x', 1001), false);
  limit.fail('c@x', 2000);
  limit.forgive('c@x');
  assert.equal(limit.blocked('c@x', 2000), false);
});

test('IPv6 clients are limited per /64', () => {
  assert.equal(clientKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(clientKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(clientKey(undefined), '');
});
