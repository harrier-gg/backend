import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Subjects, type MetricsRecord } from '@harrier-gg/contracts';
import type { ClientProxy } from '@nestjs/microservices';
import { of } from 'rxjs';
import { ConsoleHub } from './console-hub';

const NODE = '0190a000-0000-7000-8000-000000000001';
const SERVER = '0190a000-0000-7000-8000-000000000002';

test('one sample per server and minute: average CPU, peak memory, peak players', () => {
  const sent: [string, MetricsRecord][] = [];
  const nats = { emit: (subject: string, payload: MetricsRecord) => sent.push([subject, payload]) } as unknown as ClientProxy;
  const hub = new ConsoleHub(nats, {} as never);
  try {
    hub.stats(NODE, SERVER, { cpuPercent: 10, memoryBytes: 100, memoryLimitBytes: 1000 });
    hub.players(NODE, SERVER, { online: 3, max: 20, names: [] });
    hub.stats(NODE, SERVER, { cpuPercent: 30, memoryBytes: 300, memoryLimitBytes: 1000 });
    hub.players(NODE, SERVER, { online: 1, max: 20, names: [] });
    hub.flushMinute(new Date('2026-11-11T12:00:42Z'));

    assert.deepEqual(sent, [
      [
        Subjects.metricsRecord,
        { nodeId: NODE, samples: [{ serverId: SERVER, at: '2026-11-11T12:00:00.000Z', cpuPercent: 20, memoryBytes: 300, players: 3 }] },
      ],
    ]);

    // Nothing reported since the last flush (e.g. the server stopped): nothing is sent.
    hub.flushMinute();
    assert.equal(sent.length, 1);
  } finally {
    hub.onApplicationShutdown();
  }
});

test('console commands use the current session: logged out or demoted users cannot type', async () => {
  const sent: unknown[] = [];
  const nats = { send: (_subject: string, payload: unknown) => (sent.push(payload), of({ data: null })) } as unknown as ClientProxy;
  const hub = new ConsoleHub(nats, {} as never);
  try {
    const as = (role: string | null) => async () => (role ? ({ id: 'u', name: 'U', role } as never) : null);
    await hub.command({ id: SERVER }, JSON.stringify({ command: 'op griefer' }), as('admin'));
    await hub.command({ id: SERVER }, JSON.stringify({ command: 'op griefer' }), as('member'));
    await hub.command({ id: SERVER }, JSON.stringify({ command: 'op griefer' }), as(null));
    assert.deepEqual(sent, [{ id: SERVER, command: 'op griefer' }]);
  } finally {
    hub.onApplicationShutdown();
  }
});
