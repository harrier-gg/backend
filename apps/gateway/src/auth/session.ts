import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Subjects, type Reply, type SessionInfo } from '@harrier-gg/contracts';
import type { CookieOptions } from 'express';
import type { IncomingMessage } from 'node:http';
import { firstValueFrom, timeout } from 'rxjs';
import { loadConfig } from '../config';
import { NATS } from '../nats';

export const SESSION_COOKIE = 'harrier_session';
const config = loadConfig();

/** Reads one cookie from a Cookie header without extra dependencies. */
export function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key !== name) continue;
    try {
      return decodeURIComponent(value.join('='));
    } catch {
      return null; // malformed encoding is treated like no cookie
    }
  }
  return null;
}

/** HttpOnly + SameSite=Lax always; Secure when the panel is served over HTTPS (ADR 0006). */
export function cookieOptions(expiresAt: string): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.HARRIER_PUBLIC_URL.startsWith('https:'),
    path: '/',
    expires: new Date(expiresAt),
  };
}

@Injectable()
export class Sessions {
  constructor(@Inject(NATS) private readonly nats: ClientProxy) {}

  /** Asks the identity service whether the request's session cookie is valid. */
  async fromRequest(req: IncomingMessage): Promise<SessionInfo | null> {
    const sessionToken = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!sessionToken) return null;
    const reply = await firstValueFrom(
      this.nats.send<Reply<SessionInfo>>(Subjects.identitySession, { sessionToken }).pipe(timeout(3000)),
    ).catch(() => null);
    return reply && 'data' in reply ? reply.data : null;
  }
}
