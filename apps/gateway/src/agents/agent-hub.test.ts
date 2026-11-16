import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { IncomingMessage } from 'node:http';
import { type Observable, of, throwError } from 'rxjs';
import { AgentsEventSchema } from '@harrier-gg/contracts';
import { AgentHub, bearerToken, clip } from './agent-hub';

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

test('long state messages are shortened, not dropped by the servers service', () => {
  const emitted: unknown[] = [];
  const consoles = { status: () => undefined };
  const hub = new AgentHub({ emit: (_subject: string, payload: unknown) => emitted.push(payload) } as never, consoles as never);
  const failure = `Install failed with exit code 8:\n${'Update state (0x61) downloading, progress: 42.0\n'.repeat(200)}Error! App '896660' state is 0x202 after update job.`;
  (hub as unknown as { onAgentMessage(n: unknown, raw: string): void }).onAgentMessage(
    { id: '01a1d517-c405-7289-b5bc-01e8d9fcd58e', name: 'n' },
    JSON.stringify({ type: 'serverState', serverId: '01a1e06d-7574-71e6-bc14-cfa019a8f040', status: 'crashed', message: failure }),
  );
  const event = AgentsEventSchema.safeParse(emitted[0]);
  assert.equal(event.success, true);
  const message = event.data!.message.message!;
  assert.equal(message.length, 2000);
  assert.match(message, /^Install failed with exit code 8/);
  assert.match(message, /state is 0x202 after update job\.$/);
  hub.onApplicationShutdown();
});

test('clip keeps short texts and nothing else', () => {
  assert.equal(clip('short', 10), 'short');
  assert.equal(clip(null, 10), null);
  assert.equal(clip('abcdefghijklmnop', 10)!.length, 10);
});
