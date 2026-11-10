import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerHello, PROTOCOL } from './handshake';

const hello = (protocol: number) =>
  JSON.stringify({ type: 'hello', protocol, agentVersion: '0.1.0', os: 'linux', arch: 'x86_64', hostname: 'box' });

test('accepts an agent with a supported protocol version', () => {
  const result = answerHello(hello(PROTOCOL.current), 'a1');
  assert.equal(result.accepted, true);
  assert.deepEqual(result.reply, { type: 'welcome', protocol: PROTOCOL.current, agentId: 'a1' });
});

test('rejects too old and too new agents with a reason', () => {
  for (const protocol of [PROTOCOL.minimum - 1, PROTOCOL.current + 1]) {
    const result = answerHello(hello(protocol), 'a1');
    assert.equal(result.accepted, false);
    assert.equal(result.reply.type, 'reject');
  }
});

test('rejects broken or wrong first messages', () => {
  const evilHostname = JSON.stringify({
    type: 'hello', protocol: PROTOCOL.current, agentVersion: '0.1.0', os: 'linux', arch: 'x86_64',
    hostname: 'box\n[Nest] LOG forged line',
  });
  for (const raw of ['not json', '{"type":"hello"}', JSON.stringify({ type: 'other' }), evilHostname]) {
    assert.equal(answerHello(raw, 'a1').accepted, false);
  }
});
