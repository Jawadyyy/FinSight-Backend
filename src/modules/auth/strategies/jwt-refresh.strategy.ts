import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import type { Request } from 'express';
import {
  JwtPayload,
  RefreshRequestUser,
} from '../../../common/interfaces/jwt-payload.interface';
import { REFRESH_COOKIE } from '../refresh-cookie';

/** Pull the refresh token out of the httpOnly cookie (never a header, never the body). */
function refreshTokenFromCookie(request: Request): string | null {
  const cookies = request.cookies as Record<string, string> | undefined;
  return cookies?.[REFRESH_COOKIE] ?? null;
}

/**
 * Handles the refresh token, registered under the name 'jwt-refresh'.
 *
 * Two things make it different from JwtStrategy:
 *  1. it verifies against JWT_REFRESH_SECRET, so an access token cannot be
 *     replayed here (and a refresh token cannot be used as an access token);
 *  2. `passReqToCallback` lets us read the raw token string back out of the
 *     request, because AuthService still has to check it against the hash we
 *     stored at login. Signature valid is not the same as still valid.
 *
 * The token arrives in an httpOnly cookie, so we extract it from there instead
 * of the Authorization header — that is what keeps it out of reach of JavaScript.
 */
@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(
  Strategy,
  'jwt-refresh',
) {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: refreshTokenFromCookie,
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
      passReqToCallback: true,
    });
  }

  validate(request: Request, payload: JwtPayload): RefreshRequestUser {
    const refreshToken = refreshTokenFromCookie(request);

    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is missing');
    }

    return { userId: payload.sub, refreshToken };
  }
}
