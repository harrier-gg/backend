import type { Hello, PanelMessage } from '@harrier-gg/protocol';
import { z } from 'zod';

/**
 * Protocol versions this gateway speaks.
 * Rule (ADR 0002): always the current and the previous version.
 */
export const PROTOCOL = { minimum: 1, current: 1 } as const;

// `z.ZodType<Hello>` breaks the build as soon as the generated Rust types and this schema drift apart.
// The regex limits keep control characters (log injection) and huge values out.
const HelloSchema: z.ZodType<Hello> = z.object({
  protocol: z.number().int().nonnegative(),
  agentVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,64}$/),
  os: z.string().regex(/^[a-z0-9_]{1,32}$/),
  arch: z.string().regex(/^[a-z0-9_]{1,32}$/),
  hostname: z.string().regex(/^[A-Za-z0-9._-]{1,253}$/),
});

const AgentHelloMessage = HelloSchema.and(z.object({ type: z.literal('hello') }));

export type HandshakeResult =
  | { accepted: true; hello: Hello; reply: PanelMessage }
  | { accepted: false; reply: PanelMessage };

/** Checks an agent's first message and decides whether to accept or reject it. */
export function answerHello(raw: string, agentId: string): HandshakeResult {
  const reject = (reason: string): HandshakeResult => ({
    accepted: false,
    reply: { type: 'reject', reason, minProtocol: PROTOCOL.minimum, maxProtocol: PROTOCOL.current },
  });

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return reject('First message is not valid JSON');
  }

  const parsed = AgentHelloMessage.safeParse(json);
  if (!parsed.success) return reject('First message must be a valid "hello"');

  const hello = parsed.data;
  if (hello.protocol < PROTOCOL.minimum) {
    return reject(`Agent too old: protocol ${hello.protocol}, the panel needs at least ${PROTOCOL.minimum}. Please update the agent.`);
  }
  if (hello.protocol > PROTOCOL.current) {
    return reject(`Panel too old: the agent speaks protocol ${hello.protocol}, the panel at most ${PROTOCOL.current}. Please update the panel.`);
  }

  const { type: _type, ...info } = hello;
  return { accepted: true, hello: info, reply: { type: 'welcome', protocol: hello.protocol, agentId } };
}
