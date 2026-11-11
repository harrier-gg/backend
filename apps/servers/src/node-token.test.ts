import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatToken, newSecret, parseToken, secretMatches } from './node-token';

const nodeId = '019a6f2e-1c2b-7d3e-8f40-123456789abc';

test('a new token can be parsed and verified against its stored hash', () => {
  const { secret, hash } = newSecret();
  const parsed = parseToken(formatToken(nodeId, secret));
  assert.deepEqual(parsed, { nodeId, secret });
  assert.equal(secretMatches(parsed!.secret, hash), true);
});

test('a different secret does not match', () => {
  const { hash } = newSecret();
  assert.equal(secretMatches(newSecret().secret, hash), false);
});

test('malformed tokens are rejected before any lookup', () => {
  const { secret } = newSecret();
  for (const token of ['', 'hrr_', `${nodeId}_${secret}`, `hrr_not-a-uuid_${secret}`, `hrr_${nodeId}_short`, `${formatToken(nodeId, secret)}x`]) {
    assert.equal(parseToken(token), null, token);
  }
});
