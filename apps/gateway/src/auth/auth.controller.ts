import { Body, Controller, Get, HttpCode, HttpException, Inject, Post, Req, Res } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiBody, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Subjects, type Reply, type Role, type SessionCreated, type UserSummary } from '@harrier-gg/contracts';
import type { Request, Response } from 'express';
import { firstValueFrom, timeout } from 'rxjs';
import { NATS } from '../nats';
import { Public, type AuthedRequest } from './auth.guard';
import { cookieOptions, readCookie, SESSION_COOKIE } from './session';

class UserDto implements UserSummary {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['owner', 'admin', 'member'] }) role!: Role;
}

class SetupStatusDto {
  @ApiProperty({ description: 'True until the owner account was created via the setup link' }) needsSetup!: boolean;
}

class SetupDto {
  @ApiProperty({ description: 'Token from the setup link in the identity service log' }) token!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ minLength: 10 }) password!: string;
}

class LoginDto {
  @ApiProperty() email!: string;
  @ApiProperty() password!: string;
}

async function call<T>(nats: ClientProxy, subject: string, payload: unknown): Promise<T> {
  const reply = await firstValueFrom(nats.send<Reply<T>>(subject, payload).pipe(timeout(10_000))).catch(() => {
    throw new HttpException('The identity service is unavailable', 503);
  });
  if ('error' in reply) throw new HttpException(reply.error.detail, reply.error.status);
  return reply.data;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(@Inject(NATS) private readonly nats: ClientProxy) {}

  @Public()
  @Get('setup')
  @ApiOkResponse({ type: SetupStatusDto })
  setupStatus(): Promise<SetupStatusDto> {
    return call(this.nats, Subjects.identitySetupStatus, {});
  }

  /** Creates the owner account with the one-time setup token and logs them in. */
  @Public()
  @Post('setup')
  @HttpCode(200)
  @ApiBody({ type: SetupDto })
  @ApiOkResponse({ type: UserDto })
  async setup(@Body() body: SetupDto, @Res({ passthrough: true }) res: Response): Promise<UserDto> {
    return this.startSession(await call<SessionCreated>(this.nats, Subjects.identitySetup, body), res);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiBody({ type: LoginDto })
  @ApiOkResponse({ type: UserDto })
  async login(@Body() body: LoginDto, @Res({ passthrough: true }) res: Response): Promise<UserDto> {
    return this.startSession(await call<SessionCreated>(this.nats, Subjects.identityLogin, body), res);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const sessionToken = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (sessionToken) await call(this.nats, Subjects.identityLogout, { sessionToken });
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @Get('me')
  @ApiOkResponse({ type: UserDto })
  me(@Req() req: AuthedRequest): UserDto {
    return req.user;
  }

  private startSession(created: SessionCreated, res: Response): UserDto {
    res.cookie(SESSION_COOKIE, created.sessionToken, cookieOptions(created.expiresAt));
    return created.user;
  }
}
