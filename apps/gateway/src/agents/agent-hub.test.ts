import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IncomingMessage } from 'node:http';
import { type Observable, of, throwError } from 'rxjs';
import { AgentHub, bearerToken } from './agent-hub';

test('reads the token from a Bearer header', () => {
  assert.equal(bearerToken('Bearer hrr_abc'), 'hrr_abc');
});

test('ignores missing, other or malformed authorization headers', () => {
  for (const header of [undefined, '', 'Basic abc', 'Bearer', 'Bearer a b', `Bearer ${'x'.repeat(201)}`]) {
    assert.equal(bearerToken(header), null, String(header));
  }
});

test('answers 503 when the token cannot be checked, so the agent retries instead of quitting', async () => {
  const reply = (r: () => Observable<unknown>) => new AgentHub({ send: r } as never, {} as never);
  const req = { headers: { authorization: 'Bearer hrr_abc' }, socket: {} } as IncomingMessage;
  const verify = (hub: AgentHub) => (hub as unknown as { verify(r: IncomingMessage): Promise<number> }).verify(req);

  assert.equal(await verify(reply(() => throwError(() => new Error('no subscribers')))), 503);
  assert.equal(await verify(reply(() => of({ node: null }))), 401);
  assert.equal(await verify(reply(() => of({ node: { id: 'n1', name: 'n1' } }))), 200);
});
