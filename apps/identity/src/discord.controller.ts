import { Controller, Inject, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  DiscordCallbackSchema,
  DiscordStartSchema,
  DiscordUserRequestSchema,
  Subjects,
  type UserSummary,
  type DiscordResult,
  type DiscordStart,
  type Reply,
} from '@harrier-gg/contracts';
import { config } from './config';
import { hashToken, newToken } from './crypto';
import type { Db } from './db';
import { Prisma } from './generated/prisma/client';
import { createSession, DB, fail, toUser } from './identity.controller';

const STATE_TTL_MS = 10 * 60 * 1000;

export const discordEnabled = () => !!(config.HARRIER_DISCORD_CLIENT_ID && config.HARRIER_DISCORD_CLIENT_SECRET);
const redirectUri = () => new URL('/api/v1/auth/discord/callback', config.HARRIER_PUBLIC_URL).toString();

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  email?: string | null;
  verified?: boolean;
}

/** OAuth2 authorization code flow with Discord (ADR 0008). */
@Controller()
export class DiscordController {
  private readonly logger = new Logger(DiscordController.name);
  // ponytail: pending logins in memory of this instance (10 min); a shared store when identity scales out
  private readonly pending = new Map<string, DiscordStart & { expiresAt: number }>();

  constructor(@Inject(DB) private readonly db: Db) {}

  /** The account a Discord user linked, for the bot (ADR 0014). */
  @MessagePattern(Subjects.discordUser)
  async userByDiscord(@Payload() payload: unknown): Promise<Reply<UserSummary>> {
    const request = DiscordUserRequestSchema.safeParse(payload);
    const user = request.success ? await this.db.user.findUnique({ where: { discordId: request.data.discordId } }) : null;
    return user ? { data: toUser(user) } : fail(404, 'No account is linked to this Discord user');
  }

  @MessagePattern(Subjects.discordEnabled)
  enabled(): Reply<{ enabled: boolean }> {
    return { data: { enabled: discordEnabled() } };
  }

  /** Creates the Discord authorize URL and remembers what the login is for. */
  @MessagePattern(Subjects.discordStart)
  start(@Payload() payload: unknown): Reply<{ url: string; state: string }> {
    if (!discordEnabled()) return fail(404, 'Discord login is not configured');
    const request = DiscordStartSchema.safeParse(payload);
    if (!request.success) return fail(400, 'Invalid Discord login request');

    for (const [key, value] of this.pending) if (value.expiresAt < Date.now()) this.pending.delete(key);
    const { token: state } = newToken();
    this.pending.set(state, { ...request.data, expiresAt: Date.now() + STATE_TTL_MS });

    const url = new URL(config.HARRIER_DISCORD_AUTHORIZE_URL);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: config.HARRIER_DISCORD_CLIENT_ID!,
      scope: 'identify email',
      state,
      redirect_uri: redirectUri(),
      prompt: 'none', // skip the consent screen when the user already approved
    }).toString();
    return { data: { url: url.toString(), state } };
  }

  /** Exchanges the code, reads the Discord profile once and logs in, links or joins. */
  @MessagePattern(Subjects.discordCallback)
  async callback(@Payload() payload: unknown): Promise<Reply<DiscordResult>> {
    const request = DiscordCallbackSchema.safeParse(payload);
    const pending = request.success ? this.pending.get(request.data.state) : undefined;
    if (!request.success || !pending || pending.expiresAt < Date.now()) return { data: { error: 'state' } };
    this.pending.delete(request.data.state); // every state works once

    let profile: DiscordUser;
    try {
      profile = await this.fetchProfile(request.data.code);
    } catch (error) {
      this.logger.warn(`Discord login failed: ${String(error)}`);
      return { data: { error: 'failed' } };
    }
    const displayName = profile.global_name || profile.username;

    if (pending.mode === 'login') {
      const user = await this.db.user.findUnique({ where: { discordId: profile.id } });
      if (!user) return { data: { error: 'not_linked' } };
      await this.db.user.update({ where: { id: user.id }, data: { discordName: displayName } });
      return { data: { session: await createSession(this.db, { ...user, discordName: displayName }) } };
    }

    if (pending.mode === 'link') {
      const owner = await this.db.user.findUnique({ where: { discordId: profile.id } });
      if (owner && owner.id !== pending.actorId) return { data: { error: 'taken' } };
      await this.db.user.update({ where: { id: pending.actorId }, data: { discordId: profile.id, discordName: displayName } });
      return { data: { linked: true } };
    }

    // Join via invitation: the account gets name and verified e-mail from Discord, no password.
    if (!profile.email || !profile.verified) return { data: { error: 'email' } };
    const email = profile.email.toLowerCase();
    try {
      const user = await this.db.$transaction(
        async (tx) => {
          const invite = await tx.invite.findUnique({ where: { tokenHash: hashToken(pending.inviteToken) } });
          if (!invite || invite.usedAt || invite.expiresAt <= new Date()) throw new Error('invite');
          if (await tx.user.findFirst({ where: { OR: [{ email }, { discordId: profile.id }] } })) throw new Error('taken');
          const created = await tx.user.create({
            data: { email, name: displayName.slice(0, 64), role: invite.role, discordId: profile.id, discordName: displayName },
          });
          await tx.invite.update({ where: { id: invite.id }, data: { usedAt: new Date(), usedById: created.id } });
          return created;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      this.logger.log(`${user.email} joined as ${user.role} with Discord`);
      return { data: { session: await createSession(this.db, user) } };
    } catch (error) {
      return { data: { error: (error as Error).message === 'taken' ? 'taken' : 'invite' } };
    }
  }

  private async fetchProfile(code: string): Promise<DiscordUser> {
    const token = await fetch(`${config.HARRIER_DISCORD_API_URL}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(),
        client_id: config.HARRIER_DISCORD_CLIENT_ID!,
        client_secret: config.HARRIER_DISCORD_CLIENT_SECRET!,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!token.ok) throw new Error(`token exchange answered ${token.status}`);
    const { access_token: accessToken } = (await token.json()) as { access_token?: string };
    if (!accessToken) throw new Error('no access token');

    // The access token is used once for the profile and then forgotten (ADR 0008).
    const me = await fetch(`${config.HARRIER_DISCORD_API_URL}/users/@me`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!me.ok) throw new Error(`profile answered ${me.status}`);
    const profile = (await me.json()) as DiscordUser;
    if (typeof profile.id !== 'string' || typeof profile.username !== 'string') throw new Error('unexpected profile');
    return profile;
  }
}
