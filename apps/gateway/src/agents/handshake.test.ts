import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerHello, PROTOCOL } from './handshake';

const hello = (protocol: number) =>
  JSON.stringify({ type: 'hello', protocol, agentVersion: '0.1.0', os: 'linux', arch: 'x86_64', hostname: 'box' });

test('nimmt einen Agent mit unterstützter Protokollversion an', () => {
  const result = answerHello(hello(PROTOCOL.current), 'a1');
  assert.equal(result.accepted, true);
  assert.deepEqual(result.reply, { type: 'welcome', protocol: PROTOCOL.current, agentId: 'a1' });
});

test('lehnt zu alte und zu neue Agents mit Begründung ab', () => {
  for (const protocol of [PROTOCOL.minimum - 1, PROTOCOL.current + 1]) {
    const result = answerHello(hello(protocol), 'a1');
    assert.equal(result.accepted, false);
    assert.equal(result.reply.type, 'reject');
  }
});

test('lehnt kaputte oder falsche erste Nachrichten ab', () => {
  for (const raw of ['nicht json', '{"type":"hello"}', JSON.stringify({ type: 'other' })]) {
    assert.equal(answerHello(raw, 'a1').accepted, false);
  }
});
