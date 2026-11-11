import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashPassword, newToken, tokensMatch, verifyPassword } from './crypto';

test('a password verifies against its own hash only', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.ok(hash.startsWith('scrypt$32768$8$3$'));
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('wrong horse battery', hash), false);
});

test('the same password gets a different hash every time (salt)', async () => {
  assert.notEqual(await hashPassword('same password'), await hashPassword('same password'));
});

test('malformed stored hashes never verify', async () => {
  for (const stored of ['', 'plain', 'bcrypt$x', 'scrypt$1$2$3$', 'scrypt$x$8$3$c2FsdA==$aGFzaA==']) {
    assert.equal(await verifyPassword('x', stored), false, stored);
  }
});

test('tokens are random, and only the same token matches', () => {
  const a = newToken();
  const b = newToken();
  assert.notEqual(a.token, b.token);
  assert.equal(a.token.length, 43);
  assert.equal(tokensMatch(a.token, a.token), true);
  assert.equal(tokensMatch(a.token, b.token), false);
});
