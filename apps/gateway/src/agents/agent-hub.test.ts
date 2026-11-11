import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bearerToken } from './agent-hub';

test('reads the token from a Bearer header', () => {
  assert.equal(bearerToken('Bearer hrr_abc'), 'hrr_abc');
});

test('ignores missing, other or malformed authorization headers', () => {
  for (const header of [undefined, '', 'Basic abc', 'Bearer', 'Bearer a b', `Bearer ${'x'.repeat(201)}`]) {
    assert.equal(bearerToken(header), null, String(header));
  }
});
