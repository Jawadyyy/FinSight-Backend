import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { createHash, randomUUID } from 'crypto';
import { UsersService } from '../users/users.service';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { User } from '../users/entities/user.entity';
import { LoginDto } from './dto/login.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { TokensDto } from './dto/tokens.dto';
import { JwtPayload } from '../../common/interfaces/jwt-payload.interface';
import { GoogleUser } from './google-token';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async register(createUserDto: CreateUserDto): Promise<AuthResponseDto> {
    const alreadyRegistered = await this.usersService.findByEmail(
      createUserDto.email,
    );
    if (alreadyRegistered) {
      throw new ConflictException('Email already registered');
    }

    const user = await this.usersService.create(createUserDto);
    const tokens = await this.issueTokens(user);

    return { ...tokens, user: toUserSummary(user) };
  }

  async login(loginDto: LoginDto): Promise<AuthResponseDto> {
    const user = await this.usersService.validateCredentials(
      loginDto.email,
      loginDto.password,
    );
    // Same message for "no such email" and "wrong password" on purpose: we do
    // not want to tell an attacker which emails exist.
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const tokens = await this.issueTokens(user);
    await this.usersService.updateLastLogin(user.id);

    return { ...tokens, user: toUserSummary(user) };
  }

  /**
   * Google sign-in. By the time we get here the GoogleStrategy has already
   * confirmed the identity with Google, so we just find-or-create the account
   * and hand back OUR own tokens — identical to a normal login from here on.
   */
  async loginWithGoogle(googleUser: GoogleUser): Promise<AuthResponseDto> {
    const user = await this.usersService.findOrCreateGoogleUser(googleUser);
    const tokens = await this.issueTokens(user);
    await this.usersService.updateLastLogin(user.id);

    return { ...tokens, user: toUserSummary(user) };
  }

  /**
   * Swaps a valid refresh token for a brand new pair (this is "rotation").
   *
   * The old refresh token stops working the moment we store the hash of the
   * new one, so a stolen token is only useful until the real user refreshes.
   */
  async refreshTokens(
    userId: string,
    refreshToken: string,
  ): Promise<TokensDto> {
    const user = await this.usersService.findById(userId);

    // No stored hash means the user logged out — the signature may still be
    // valid, but we revoked the token.
    if (!user || !user.hashedRefreshToken) {
      throw new UnauthorizedException('Refresh token is no longer valid');
    }

    if (hashToken(refreshToken) !== user.hashedRefreshToken) {
      throw new UnauthorizedException('Refresh token is no longer valid');
    }

    return this.issueTokens(user);
  }

  /** Forget the stored refresh token so it can never be redeemed again. */
  async logout(userId: string): Promise<{ message: string }> {
    await this.usersService.setHashedRefreshToken(userId, null);
    return { message: 'Logged out successfully' };
  }

  /**
   * Signs both tokens and remembers the refresh one (hashed) against the user.
   *
   * Each token is signed with its own secret and its own lifetime:
   *  - access token: short, sent on every request, so a leak is short lived;
   *  - refresh token: long, only ever sent to /auth/refresh.
   */
  private async issueTokens(user: User): Promise<TokensDto> {
    const payload: JwtPayload = { sub: user.id, email: user.email };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: this.expiry('JWT_ACCESS_EXPIRES_IN', '15m'),
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: this.expiry('JWT_REFRESH_EXPIRES_IN', '7d'),
        // "iat" only has second precision, so two refreshes inside the same
        // second would produce byte-identical tokens. A random id keeps every
        // refresh token unique.
        jwtid: randomUUID(),
      }),
    ]);

    await this.usersService.setHashedRefreshToken(
      user.id,
      hashToken(refreshToken),
    );

    return { accessToken, refreshToken };
  }

  /**
   * Reads a lifetime like "15m" or "7d" out of the env.
   * The cast is only needed because jsonwebtoken types the duration as a
   * literal union ("15m" | "7d" | ...) and env values are plain strings.
   */
  private expiry(key: string, fallback: string): JwtSignOptions['expiresIn'] {
    return this.configService.get<string>(
      key,
      fallback,
    ) as JwtSignOptions['expiresIn'];
  }
}

/**
 * SHA-256 rather than bcrypt on purpose. A JWT is long random-ish text, so it
 * does not need a slow hash — and bcrypt silently ignores everything past the
 * first 72 bytes, which for two tokens of the same user is the part that looks
 * almost identical. That would make different tokens compare as equal.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toUserSummary(user: User) {
  // tier travels with the user so the UI knows which plan to render from the
  // moment they sign in, without a second request.
  return { id: user.id, email: user.email, name: user.name, tier: user.tier };
}
