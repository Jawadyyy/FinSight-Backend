import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsersService } from '../../users/users.service';
import {
  AuthenticatedUser,
  JwtPayload,
} from '../../../common/interfaces/jwt-payload.interface';

/**
 * Handles the access token. Registered under the name 'jwt', which is what
 * JwtAuthGuard asks for.
 *
 * Passport verifies the signature and the expiry before calling validate(),
 * so by the time we get here the payload is trustworthy.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    configService: ConfigService,
    private readonly usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  // Whatever this returns becomes `request.user`.
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    // The token could still point at a user that was deleted since it was issued.
    const user = await this.usersService.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }

    return { id: user.id, email: user.email, name: user.name };
  }
}
