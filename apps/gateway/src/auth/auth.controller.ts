import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiBody, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Permissions, can, Subjects, type Permission, type Role, type SessionCreated, type UserSummary } from '@harrier-gg/contracts';
import type { Request, Response } from 'express';
import { NATS } from '../nats';
import { Public, type AuthedRequest } from './auth.guard';
import { callIdentity as call } from './users.controller';
import { cookieOptions, readCookie, SESSION_COOKIE } from './session';

class UserDto implements UserSummary {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['owner', 'admin', 'member'] }) role!: Role;
  @ApiProperty({ type: String, nullable: true, description: 'Display name of the linked Discord account' }) discord!: string | null;
}

const PERMISSIONS = Object.keys(Permissions) as Permission[];

class MeDto extends UserDto {
  @ApiProperty({ enum: PERMISSIONS, isArray: true, description: 'What this user may do (ADR 0007); the web hides the rest' })
  permissions!: Permission[];
}

class InviteCheckDto {
  @ApiProperty({ enum: ['admin', 'member'] }) role!: Role;
}

class AcceptInviteDto {
  @ApiProperty({ description: 'Token from the invitation link' }) token!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ minLength: 10 }) password!: string;
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
  @ApiOkResponse({ type: MeDto })
  me(@Req() req: AuthedRequest): MeDto {
    return { ...req.user, permissions: PERMISSIONS.filter((p) => can(req.user.role, p)) };
  }

  /** Public: the invitation page shows which role the link gives before signing up. */
  @Public()
  @Get('invites/check')
  @ApiOkResponse({ type: InviteCheckDto })
  checkInvite(@Query('token') token: string): Promise<InviteCheckDto> {
    return call(this.nats, Subjects.invitesCheck, { token: String(token ?? '') });
  }

  /** Public: creates the account from an invitation and logs the person in. */
  @Public()
  @Post('invites/accept')
  @HttpCode(200)
  @ApiBody({ type: AcceptInviteDto })
  @ApiOkResponse({ type: UserDto })
  async acceptInvite(@Body() body: AcceptInviteDto, @Res({ passthrough: true }) res: Response): Promise<UserDto> {
    return this.startSession(await call<SessionCreated>(this.nats, Subjects.invitesAccept, body), res);
  }

  private startSession(created: SessionCreated, res: Response): UserDto {
    res.cookie(SESSION_COOKIE, created.sessionToken, cookieOptions(created.expiresAt));
    return created.user;
  }
}
