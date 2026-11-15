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

test('a full limit drops the counter with the fewest failures, never one under attack', () => {
  const limit = new FailureLimit(3, 1000, 2);
  limit.fail('owner@x', 0);
  limit.fail('owner@x', 0);
  limit.fail('a@x', 0);
  // A flood of new one-off keys pushes out other one-off keys, not the owner's counter.
  for (const key of ['b@x', 'c@x', 'd@x']) limit.fail(key, 10);
  assert.equal(limit.count('owner@x', 10), 2);
  assert.equal(limit.count('a@x', 10), 0);
  limit.fail('owner@x', 10);
  assert.equal(limit.blocked('owner@x', 10), true);
  // Counters expire; forgiving takes one failure back.
  assert.equal(limit.blocked('owner@x', 1001), false);
  limit.fail('e@x', 2000);
  limit.forgive('e@x');
  assert.equal(limit.count('e@x', 2000), 0);
});

test('client addresses: IPv6 per /64, nothing usable means no address limit', () => {
  assert.equal(clientKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:DB8::1'), '2001:db8:0:0::/64');
  assert.equal(clientKey('2001:0db8:0001:0002:0:0:0:1'), '2001:db8:1:2::/64');
  assert.equal(clientKey('::1'), '0:0:0:0::/64');
  assert.equal(clientKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(clientKey('203.0.113.7'), '203.0.113.7');
  for (const odd of [undefined, '', 'not an ip', '2001:db8::1:2:3:4:5:6:7']) assert.equal(clientKey(odd), null, String(odd));
});

test('while an e-mail is guessed from elsewhere, its owner still gets in from a clean address', async () => {
  const passwordHash = await hashPassword('correct horse battery');
  const db = {
    user: { findUnique: async () => ({ id: 'u', email: 'owner@harrier.test', name: 'O', role: 'owner', passwordHash, createdAt: new Date() }) },
    session: { create: async () => ({}) },
  };
  const identity = new IdentityController(db as never, { token: null } as never);
  const login = (password: string, from: string) => identity.login({ email: 'owner@harrier.test', password, from });
  // 60 addresses guess a few times each: past the limit per e-mail.
  for (let i = 0; i < 60; i++) await login('wrong password!', `198.18.0.${i}`);
  const again = await login('wrong password!', '198.18.0.1');
  assert.equal('error' in again && again.error.status, 429);
  const owner = await login('correct horse battery', '192.0.2.10');
  assert.equal('error' in owner, false);
});
