import { Controller, Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  LoginRequestSchema,
  SessionTokenSchema,
  SetupRequestSchema,
  Subjects,
  type Reply,
  type SessionCreated,
  type SessionInfo,
  type UserSummary,
} from '@harrier-gg/contracts';
import { config } from './config';
import { hashPassword, hashToken, newToken, tokensMatch, verifyPassword } from './crypto';
import type { Db } from './db';
import { Prisma } from './generated/prisma/client';

export const DB = Symbol('DB');

const SESSION_DAYS = 30;
const RENEW_WHEN_DAYS_LEFT = 15;
const DAY = 24 * 60 * 60 * 1000;
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export const fail = (status: number, detail: string) => ({ error: { status, detail } });
export const toUser = (u: { id: string; email: string; name: string; role: UserSummary['role'] }): UserSummary => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
});

/** Holds the one-time setup token while no user exists (ADR 0006). */
@Injectable()
export class SetupToken implements OnApplicationBootstrap {
  private readonly logger = new Logger('Setup');
  token: string | null = null;

  constructor(@Inject(DB) private readonly db: Db) {}

  async onApplicationBootstrap() {
    if ((await this.db.user.count()) > 0) return;
    this.token = newToken().token;
    const url = new URL('/setup', config.HARRIER_PUBLIC_URL);
    url.searchParams.set('token', this.token);
    this.logger.warn(`No user exists yet. Create the owner account here (link valid until restart):\n\n    ${url}\n`);
  }
}

@Controller()
export class IdentityController {
  private readonly logger = new Logger(IdentityController.name);
  // ponytail: in-memory limit per e-mail of this instance; shared store when identity scales out
  private readonly failedLogins = new Map<string, { count: number; resetAt: number }>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly setupToken: SetupToken,
  ) {}

  @MessagePattern(Subjects.identitySetupStatus)
  setupStatus(): Reply<{ needsSetup: boolean }> {
    return { data: { needsSetup: this.setupToken.token !== null } };
  }

  /** Creates the owner. Only with the setup token and only while no user exists. */
  @MessagePattern(Subjects.identitySetup)
  async setup(@Payload() payload: unknown): Promise<Reply<SessionCreated>> {
    const request = SetupRequestSchema.safeParse(payload);
    if (!request.success) return fail(400, 'Name, a valid e-mail address and a password of at least 10 characters are required');
    const expected = this.setupToken.token;
    if (!expected || !tokensMatch(request.data.token, expected)) return fail(403, 'The setup link is invalid or was already used');

    const passwordHash = await hashPassword(request.data.password);
    try {
      // Serializable: two setup requests at the same time cannot both see "no users".
      const user = await this.db.$transaction(
        async (tx) => {
          if ((await tx.user.count()) > 0) throw new Error('already set up');
          return tx.user.create({ data: { email: request.data.email, name: request.data.name, passwordHash, role: 'owner' } });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      this.setupToken.token = null;
      this.logger.log(`Owner account created for ${user.email}`);
      return { data: await createSession(this.db, user) };
    } catch {
      this.setupToken.token = null;
      return fail(409, 'Harrier is already set up');
    }
  }

  @MessagePattern(Subjects.identityLogin)
  async login(@Payload() payload: unknown): Promise<Reply<SessionCreated>> {
    const request = LoginRequestSchema.safeParse(payload);
    const invalid = fail(401, 'E-mail address or password is wrong');
    if (!request.success) return invalid;
    const { email, password } = request.data;

    const attempts = this.failedLogins.get(email);
    if (attempts && attempts.resetAt > Date.now() && attempts.count >= LOGIN_LIMIT) {
      return fail(429, 'Too many failed logins. Please wait a few minutes.');
    }

    const user = await this.db.user.findUnique({ where: { email } });
    // Without a user, still spend the same time on hashing, so response times do not reveal
    // which e-mail addresses exist.
    const ok = user ? await verifyPassword(password, user.passwordHash) : (await hashPassword(password), false);
    if (!user || !ok) {
      const current = attempts && attempts.resetAt > Date.now() ? attempts : { count: 0, resetAt: Date.now() + LOGIN_WINDOW_MS };
      this.failedLogins.set(email, { ...current, count: current.count + 1 });
      return invalid;
    }
    this.failedLogins.delete(email);
    return { data: await createSession(this.db, user) };
  }

  @MessagePattern(Subjects.identityLogout)
  async logout(@Payload() payload: unknown): Promise<Reply<{ ok: true }>> {
    const request = SessionTokenSchema.safeParse(payload);
    if (request.success) await this.db.session.deleteMany({ where: { tokenHash: hashToken(request.data.sessionToken) } });
    return { data: { ok: true } };
  }

  /** Called by the gateway for every request with a session cookie. */
  @MessagePattern(Subjects.identitySession)
  async session(@Payload() payload: unknown): Promise<Reply<SessionInfo>> {
    const request = SessionTokenSchema.safeParse(payload);
    if (!request.success) return fail(401, 'Not logged in');
    const session = await this.db.session.findUnique({
      where: { tokenHash: hashToken(request.data.sessionToken) },
      include: { user: true },
    });
    if (!session) return fail(401, 'Not logged in');
    if (session.expiresAt.getTime() <= Date.now()) {
      await this.db.session.delete({ where: { id: session.id } });
      return fail(401, 'The session has expired');
    }

    let expiresAt = session.expiresAt;
    const renewed = expiresAt.getTime() - Date.now() < RENEW_WHEN_DAYS_LEFT * DAY;
    if (renewed) {
      expiresAt = new Date(Date.now() + SESSION_DAYS * DAY);
      await this.db.session.update({ where: { id: session.id }, data: { expiresAt } });
    }
    return { data: { user: toUser(session.user), expiresAt: expiresAt.toISOString(), renewed } };
  }

}

/** Creates a session for a user and returns the token for the cookie (ADR 0006). */
export async function createSession(db: Db, user: Parameters<typeof toUser>[0]): Promise<SessionCreated> {
  const { token, hash } = newToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * DAY);
  await db.session.create({ data: { userId: user.id, tokenHash: hash, expiresAt } });
  return { sessionToken: token, expiresAt: expiresAt.toISOString(), user: toUser(user) };
}
