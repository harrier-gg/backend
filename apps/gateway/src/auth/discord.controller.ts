import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiExcludeEndpoint, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Subjects, type DiscordResult } from '@harrier-gg/contracts';
import type { CookieOptions, Request, Response } from 'express';
import { loadConfig } from '../config';
import { NATS } from '../nats';
import { Public } from './auth.guard';
import { cookieOptions, readCookie, SESSION_COOKIE, Sessions } from './session';
import { callIdentity } from './users.controller';

const config = loadConfig();
const STATE_COOKIE = 'harrier_oauth';
const stateCookie: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax', // must survive the top-level redirect back from Discord
  secure: config.HARRIER_PUBLIC_URL.startsWith('https:'),
  path: '/api/v1/auth/discord',
  maxAge: 10 * 60 * 1000,
};

class ProvidersDto {
  @ApiProperty({ description: 'Whether "Log in with Discord" is configured (ADR 0008)' }) discord!: boolean;
}

/**
 * Discord login (ADR 0008). The browser navigates to /start and comes back to /callback;
 * the `state` is checked against a cookie, so nobody can push a login into someone else's browser.
 */
@ApiTags('auth')
@Controller('auth')
export class DiscordController {
  constructor(
    @Inject(NATS) private readonly nats: ClientProxy,
    private readonly sessions: Sessions,
  ) {}

  @Public()
  @Get('providers')
  @ApiOkResponse({ type: ProvidersDto })
  async providers(): Promise<ProvidersDto> {
    const { enabled } = await callIdentity<{ enabled: boolean }>(this.nats, Subjects.discordEnabled, {});
    return { discord: enabled };
  }

  @Public()
  @Get('discord/start')
  @ApiExcludeEndpoint() // a browser navigation, not an API call
  async start(@Query('mode') mode: string, @Query('token') token: string | undefined, @Req() req: Request, @Res() res: Response) {
    let payload: unknown = { mode: 'login' };
    if (mode === 'invite') payload = { mode, inviteToken: String(token ?? '') };
    if (mode === 'link') {
      const session = await this.sessions.fromRequest(req);
      if (!session) return res.redirect('/?auth_error=failed');
      payload = { mode, actorId: session.user.id };
    }
    try {
      const { url, state } = await callIdentity<{ url: string; state: string }>(this.nats, Subjects.discordStart, payload);
      res.cookie(STATE_COOKIE, state, stateCookie);
      res.redirect(url);
    } catch {
      res.redirect('/?auth_error=failed');
    }
  }

  @Public()
  @Get('discord/callback')
  @ApiExcludeEndpoint()
  async callback(@Query('state') state: string, @Query('code') code: string, @Req() req: Request, @Res() res: Response) {
    const expected = readCookie(req.headers.cookie, STATE_COOKIE);
    res.clearCookie(STATE_COOKIE, { path: stateCookie.path });
    // Cancelled on Discord, or a callback this browser did not start.
    if (!code || !state || !expected || expected !== state) return res.redirect('/?auth_error=state');

    const result = await callIdentity<DiscordResult>(this.nats, Subjects.discordCallback, { state, code }).catch(
      () => ({ error: 'failed' }) as const,
    );
    if ('error' in result) return res.redirect(`/?auth_error=${result.error}`);
    if ('session' in result) res.cookie(SESSION_COOKIE, result.session.sessionToken, cookieOptions(result.session.expiresAt));
    res.redirect('linked' in result ? '/?auth=discord_linked' : '/');
  }
}
