import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { can, type Permission, type UserSummary } from '@harrier-gg/contracts';
import type { Request, Response } from 'express';
import { cookieOptions, readCookie, SESSION_COOKIE, Sessions } from './session';

const PUBLIC = 'harrier:public';
/** Marks a route as reachable without login (health, meta, login itself). */
export const Public = () => SetMetadata(PUBLIC, true);

const PERMISSION = 'harrier:permission';
/** Requires a permission from the role table (ADR 0007). Without it, any logged-in user may call the route. */
export const Allow = (permission: Permission) => SetMetadata(PERMISSION, permission);

export type AuthedRequest = Request & { user: UserSummary };

/** Every route needs a valid session unless it is marked @Public() (ADR 0006). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: Sessions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true; // NATS handlers are internal
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [context.getHandler(), context.getClass()])) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const session = await this.sessions.fromRequest(req);
    if (!session) throw new UnauthorizedException('Please log in');

    (req as AuthedRequest).user = session.user;
    const permission = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION, [context.getHandler(), context.getClass()]);
    if (permission && !can(session.user.role, permission)) throw new ForbiddenException('Your role does not allow this');
    // Sliding sessions: when the identity service extended the session, the cookie follows.
    if (session.renewed) {
      const res = context.switchToHttp().getResponse<Response>();
      const token = readCookie(req.headers.cookie, SESSION_COOKIE);
      if (token) res.cookie(SESSION_COOKIE, token, cookieOptions(session.expiresAt));
    }
    return true;
  }
}
