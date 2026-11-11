import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readCookie } from './session';

test('reads a cookie from a Cookie header', () => {
  assert.equal(readCookie('a=1; harrier_session=abc_DEF-123; b=2', 'harrier_session'), 'abc_DEF-123');
  assert.equal(readCookie('harrier_session=x%3Dy', 'harrier_session'), 'x=y');
});

test('returns null when the cookie is missing or only a prefix matches', () => {
  assert.equal(readCookie(undefined, 'harrier_session'), null);
  assert.equal(readCookie('other=1', 'harrier_session'), null);
  assert.equal(readCookie('harrier_session_old=1', 'harrier_session'), null);
  assert.equal(readCookie('harrier_session=%E0%A4%A', 'harrier_session'), null);
});
