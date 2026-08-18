import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { User } from '../users/entities/user.entity';

/**
 * A tiny in-memory stand-in for UsersService, so these tests do not need a
 * database. Passwords are compared as plain text here — hashing is the real
 * UsersService's job, not what we are testing.
 */
class FakeUsersService {
  private users: User[] = [];

  create(dto: { email: string; password: string; name?: string }) {
    const user = {
      id: `user-${this.users.length + 1}`,
      email: dto.email.toLowerCase(),
      password: dto.password,
      name: dto.name,
      hashedRefreshToken: null,
    } as User;
    this.users.push(user);
    return Promise.resolve(user);
  }

  findByEmail(email: string) {
    return Promise.resolve(
      this.users.find((u) => u.email === email.toLowerCase()) ?? null,
    );
  }

  findOrCreateGoogleUser(googleUser: { email: string; name?: string }) {
    const existing = this.users.find(
      (u) => u.email === googleUser.email.toLowerCase(),
    );
    if (existing) return Promise.resolve(existing);
    const user = {
      id: `user-${this.users.length + 1}`,
      email: googleUser.email.toLowerCase(),
      password: null,
      provider: 'google',
      name: googleUser.name,
      hashedRefreshToken: null,
    } as unknown as User;
    this.users.push(user);
    return Promise.resolve(user);
  }

  findById(id: string) {
    return Promise.resolve(this.users.find((u) => u.id === id) ?? null);
  }

  async validateCredentials(email: string, password: string) {
    const user = await this.findByEmail(email);
    return user && user.password === password ? user : null;
  }

  async setHashedRefreshToken(id: string, hash: string | null) {
    const user = await this.findById(id);
    if (user) user.hashedRefreshToken = hash;
  }

  updateLastLogin() {
    return Promise.resolve();
  }
}

const config = {
  JWT_ACCESS_SECRET: 'test-access-secret',
  JWT_ACCESS_EXPIRES_IN: '15m',
  JWT_REFRESH_SECRET: 'test-refresh-secret',
  JWT_REFRESH_EXPIRES_IN: '7d',
} as const;

function buildService() {
  const users = new FakeUsersService();
  const configService = {
    get: (key: keyof typeof config, fallback?: string) =>
      config[key] ?? fallback,
    getOrThrow: (key: keyof typeof config) => config[key],
  } as unknown as ConfigService;

  const auth = new AuthService(
    users as unknown as UsersService,
    new JwtService({}),
    configService,
  );

  return { auth, users };
}

const credentials = { email: 'user@example.com', password: 'password123' };

describe('AuthService', () => {
  it('registers a user and returns both tokens', async () => {
    const { auth } = buildService();

    const result = await auth.register({ ...credentials, name: 'John' });

    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    expect(result.accessToken).not.toBe(result.refreshToken);
    expect(result.user).toEqual({
      id: 'user-1',
      email: 'user@example.com',
      name: 'John',
    });
  });

  it('rejects a second registration with the same email', async () => {
    const { auth } = buildService();
    await auth.register(credentials);

    await expect(auth.register(credentials)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rejects a login with the wrong password', async () => {
    const { auth } = buildService();
    await auth.register(credentials);

    await expect(
      auth.login({ email: credentials.email, password: 'wrong-password' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('the access token cannot be used as a refresh token', async () => {
    const { auth } = buildService();
    const { accessToken, user } = await auth.register(credentials);

    // Signed with the access secret, so it never matches the stored hash.
    await expect(
      auth.refreshTokens(user.id, accessToken),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rotates the refresh token, so the old one stops working', async () => {
    const { auth } = buildService();
    const first = await auth.register(credentials);

    const second = await auth.refreshTokens(first.user.id, first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);

    await expect(
      auth.refreshTokens(first.user.id, first.refreshToken),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('logout revokes the refresh token', async () => {
    const { auth } = buildService();
    const { user, refreshToken } = await auth.register(credentials);

    await auth.logout(user.id);

    await expect(
      auth.refreshTokens(user.id, refreshToken),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('Google login creates the user on first sign-in, reuses on the second', async () => {
    const { auth } = buildService();
    const google = { email: 'gmailuser@example.com', name: 'Gmail User' };

    const first = await auth.loginWithGoogle(google);
    expect(first.accessToken).toBeTruthy();
    expect(first.refreshToken).toBeTruthy();
    expect(first.user.email).toBe('gmailuser@example.com');

    // Signing in again must reuse the same account, not create a duplicate.
    const second = await auth.loginWithGoogle(google);
    expect(second.user.id).toBe(first.user.id);
  });
});
