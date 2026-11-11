import { ForbiddenException, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Blocks cross-site write requests (CSRF): browsers send an Origin header with every POST, and it
 * must match the host the request goes to. Clients without an Origin (CLI, curl) are not browsers
 * and cannot be abused this way. Login (M2) adds real authentication on top.
 */
@Injectable()
export class SameOriginMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    const origin = req.headers.origin;
    if (req.method !== 'GET' && req.method !== 'HEAD' && origin !== undefined) {
      let host: string | null = null;
      try {
        host = new URL(origin).host;
      } catch {
        // invalid Origin header → treated as foreign
      }
      if (host !== req.headers.host) throw new ForbiddenException('Cross-origin requests are not allowed');
    }
    next();
  }
}
