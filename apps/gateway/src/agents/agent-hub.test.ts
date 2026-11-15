import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
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

test('agents that miss a ping are dropped, the others pinged again', () => {
  // The hello timeout of `accept` must not fire after the test.
  mock.timers.enable({ apis: ['setTimeout'] });
  const hub = new AgentHub({} as never, {} as never);
  const fake = () => {
    const calls: string[] = [];
    const handlers: Record<string, () => void> = {};
    const socket = {
      calls,
      terminate: () => calls.push('terminate'),
      ping: () => calls.push('ping'),
      on: (event: string, handler: () => void) => (handlers[event] = handler),
      once: () => undefined,
      pong: () => handlers.pong(),
    };
    return socket;
  };
  const accept = (socket: unknown) => (hub as unknown as { accept(s: unknown, n: unknown): void }).accept(socket, { id: 'n', name: 'n' });
  const [alive, dead] = [fake(), fake()];
  accept(alive);
  accept(dead);

  hub.ping([alive, dead] as never);
  assert.deepEqual([alive.calls, dead.calls], [['ping'], ['ping']]);
  alive.pong();
  hub.ping([alive, dead] as never);
  assert.deepEqual([alive.calls, dead.calls], [['ping', 'ping'], ['ping', 'terminate']]);
  hub.onApplicationShutdown();
  mock.timers.reset();
});
