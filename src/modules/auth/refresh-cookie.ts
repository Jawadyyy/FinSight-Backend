import { ConfigService } from '@nestjs/config';
import type { CookieOptions } from 'express';

/**
 * The name of the cookie that carries the refresh token.
 * One place to change it, used by both "set" and "clear".
 */
export const REFRESH_COOKIE = 'refresh_token';

/**
 * Options for the refresh-token cookie.
 *
 *  - httpOnly: JavaScript cannot read it, so an XSS bug cannot steal it. This is
 *    the whole reason we use a cookie instead of returning the token in the body.
 *  - secure: only send over HTTPS. Off in dev (plain http://localhost), on in prod.
 *  - sameSite: in prod the SPA is on a different origin, so the cookie is
 *    cross-site and needs 'none' (which requires secure). In dev we assume the
 *    frontend calls the API same-origin via a dev proxy, so 'lax' is enough.
 *  - path '/auth': the browser only attaches this cookie to /auth/* requests,
 *    so it never rides along on unrelated API calls.
 *  - maxAge: matches the 7-day refresh-token lifetime.
 */
export function refreshCookieOptions(
  configService: ConfigService,
): CookieOptions {
  const isProd = configService.get<string>('NODE_ENV') === 'production';

  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/auth',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
  };
}
