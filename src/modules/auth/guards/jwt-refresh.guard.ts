import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Only used on POST /auth/refresh. It runs JwtRefreshStrategy, which validates
 * the token against the *refresh* secret instead of the access secret.
 */
@Injectable()
export class JwtRefreshGuard extends AuthGuard('jwt-refresh') {}
