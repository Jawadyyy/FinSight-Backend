import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Put `@UseGuards(JwtAuthGuard)` on any route that needs a logged in user.
 * It runs JwtStrategy, which reads the access token from the Authorization header.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
