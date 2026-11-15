import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { natsOptions } from '@harrier-gg/contracts';

test('NATS connections reconnect forever', () => {
  assert.deepEqual(natsOptions('nats://x:4222', 'servers'), { servers: ['nats://x:4222'], maxReconnectAttempts: -1, reconnectTimeWait: 2000, queue: 'servers' });
});

test('every service connects to NATS with natsOptions', () => {
  // With the library defaults a service gives up after ~20 s without NATS and stays deaf (#48).
  const apps = join(__dirname, '../..');
  for (const app of readdirSync(apps)) {
    const src = join(apps, app, 'src');
    for (const file of readdirSync(src, { recursive: true }) as string[]) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const code = readFileSync(join(src, file), 'utf8');
      for (const [, options] of code.matchAll(/transport: Transport\.NATS,\s*options: ([^,}]+)/g)) {
        assert.match(options, /^natsOptions\(/, `${app}/src/${file}`);
      }
    }
  }
});
