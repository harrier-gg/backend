import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { SameOriginMiddleware } from './same-origin.middleware';

const run = (method: string, headers: Record<string, string>) => {
  let passed = false;
  try {
    new SameOriginMiddleware().use({ method, headers } as Request, {} as Response, (() => (passed = true)) as NextFunction);
  } catch {
    return 'blocked';
  }
  return passed ? 'passed' : 'blocked';
};

test('blocks writes from other origins', () => {
  assert.equal(run('POST', { host: 'localhost:8080', origin: 'https://evil.example' }), 'blocked');
  assert.equal(run('POST', { host: 'localhost:8080', origin: 'not a url' }), 'blocked');
});

test('allows same-origin writes, reads and non-browser clients', () => {
  assert.equal(run('POST', { host: 'localhost:8080', origin: 'http://localhost:8080' }), 'passed');
  assert.equal(run('GET', { host: 'localhost:8080', origin: 'https://evil.example' }), 'passed');
  assert.equal(run('POST', { host: 'localhost:8080' }), 'passed');
});
