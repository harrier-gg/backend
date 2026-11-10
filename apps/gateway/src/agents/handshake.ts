import type { Hello, PanelMessage } from '@harrier-gg/protocol';
import { z } from 'zod';

/**
 * Protokollversionen, die dieses Gateway spricht.
 * Regel (ADR 0002): immer die aktuelle und die vorherige Major-Version.
 */
export const PROTOCOL = { minimum: 1, current: 1 } as const;

// `z.ZodType<Hello>` bricht den Build, sobald die generierten Rust-Typen und dieses Schema auseinanderlaufen.
const HelloSchema: z.ZodType<Hello> = z.object({
  protocol: z.number().int().nonnegative(),
  agentVersion: z.string(),
  os: z.string(),
  arch: z.string(),
  hostname: z.string(),
});

const AgentHelloMessage = HelloSchema.and(z.object({ type: z.literal('hello') }));

export type HandshakeResult =
  | { accepted: true; hello: Hello; reply: PanelMessage }
  | { accepted: false; reply: PanelMessage };

/** Prüft die erste Nachricht eines Agents und entscheidet über Annahme oder Ablehnung. */
export function answerHello(raw: string, agentId: string): HandshakeResult {
  const reject = (reason: string): HandshakeResult => ({
    accepted: false,
    reply: { type: 'reject', reason, minProtocol: PROTOCOL.minimum, maxProtocol: PROTOCOL.current },
  });

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return reject('Erste Nachricht ist kein gültiges JSON');
  }

  const parsed = AgentHelloMessage.safeParse(json);
  if (!parsed.success) return reject('Erste Nachricht muss ein gültiges "hello" sein');

  const hello = parsed.data;
  if (hello.protocol < PROTOCOL.minimum) {
    return reject(`Agent zu alt: Protokoll ${hello.protocol}, Panel braucht mindestens ${PROTOCOL.minimum}. Bitte Agent aktualisieren.`);
  }
  if (hello.protocol > PROTOCOL.current) {
    return reject(`Panel zu alt: Agent spricht Protokoll ${hello.protocol}, Panel höchstens ${PROTOCOL.current}. Bitte Panel aktualisieren.`);
  }

  const { type: _type, ...info } = hello;
  return { accepted: true, hello: info, reply: { type: 'welcome', protocol: hello.protocol, agentId } };
}
