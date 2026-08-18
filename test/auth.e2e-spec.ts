import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AuthModule } from '../src/modules/auth/auth.module';
import { User } from '../src/modules/users/entities/user.entity';

/**
 * Pull the `refresh_token=...` pair out of a Set-Cookie header so we can send
 * it back on the next request — this is what a browser does automatically.
 */
function refreshCookie(response: request.Response): string {
  const setCookie = response.headers['set-cookie'] as unknown as
    | string[]
    | undefined;
  const cookie = (setCookie ?? []).find((c) => c.startsWith('refresh_token='));
  if (!cookie) throw new Error('no refresh_token cookie was set');
  return cookie.split(';')[0]; // "refresh_token=<value>"
}

/**
 * Walks the real HTTP routes end to end (pipes, guards, strategies), with the
 * database swapped for an array so the test needs no Postgres.
 */
class InMemoryUserRepository {
  private rows: User[] = [];

  create(data: Partial<User>): User {
    return { id: `user-${this.rows.length + 1}`, ...data } as User;
  }

  save(user: User): Promise<User> {
    this.rows.push(user);
    return Promise.resolve(user);
  }

  findOne({ where }: { where: Partial<User> }): Promise<User | null> {
    const match = this.rows.find((row) =>
      Object.entries(where).every(([key, value]) => row[key] === value),
    );
    return Promise.resolve(match ?? null);
  }

  update(id: string, changes: Partial<User>): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) Object.assign(row, changes);
    return Promise.resolve();
  }
}

const credentials = { email: 'e2e@example.com', password: 'password123' };

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let http: request.Agent;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET = 'e2e-access-secret';
    process.env.JWT_REFRESH_SECRET = 'e2e-refresh-secret';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), AuthModule],
    })
      .overrideProvider(getRepositoryToken(User))
      .useClass(InMemoryUserRepository)
      .compile();

    app = moduleFixture.createNestApplication();
    // Same setup as main.ts: cookie parsing + the validation pipe.
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a registration with a short password', async () => {
    const response = await http
      .post('/auth/register')
      .send({ email: 'short@example.com', password: 'abc' })
      .expect(400);

    expect(response.body.message).toContain(
      'Password must be at least 8 characters long',
    );
  });

  it('registers: access token in body, refresh token only in the cookie', async () => {
    const registered = await http
      .post('/auth/register')
      .send({ ...credentials, name: 'E2E User' })
      .expect(201);

    expect(registered.body.accessToken).toBeTruthy();
    // The refresh token must NOT be in the body — it lives in the httpOnly cookie.
    expect(registered.body.refreshToken).toBeUndefined();
    expect(refreshCookie(registered)).toContain('refresh_token=');
    // The password must never travel back to the client.
    expect(JSON.stringify(registered.body)).not.toContain(credentials.password);

    const profile = await http
      .get('/auth/me')
      .set('Authorization', `Bearer ${registered.body.accessToken}`)
      .expect(200);

    expect(profile.body.email).toBe(credentials.email);
  });

  it('sets the refresh cookie as httpOnly', async () => {
    const loggedIn = await http.post('/auth/login').send(credentials).expect(200);
    const setCookie = loggedIn.headers['set-cookie'] as unknown as string[];
    const cookie = setCookie.find((c) => c.startsWith('refresh_token='))!;
    expect(cookie.toLowerCase()).toContain('httponly');
  });

  it('refuses the profile without a token', () => {
    return http.get('/auth/me').expect(401);
  });

  it('refreshes using the cookie, and rejects the used cookie afterwards', async () => {
    const loggedIn = await http.post('/auth/login').send(credentials).expect(200);
    const firstCookie = refreshCookie(loggedIn);

    const refreshed = await http
      .post('/auth/refresh')
      .set('Cookie', firstCookie)
      .expect(200);

    expect(refreshed.body.accessToken).toBeTruthy();
    expect(refreshed.body.refreshToken).toBeUndefined();

    // The old cookie was rotated away — replaying it must fail.
    await http.post('/auth/refresh').set('Cookie', firstCookie).expect(401);
  });

  it('refuses the refresh route with no cookie', () => {
    return http.post('/auth/refresh').expect(401);
  });

  it('refuses an access token used as the refresh cookie', async () => {
    const loggedIn = await http.post('/auth/login').send(credentials).expect(200);

    // Put the access token where the refresh token is expected: wrong secret → 401.
    await http
      .post('/auth/refresh')
      .set('Cookie', `refresh_token=${loggedIn.body.accessToken}`)
      .expect(401);
  });

  it('logout revokes the refresh token and clears the cookie', async () => {
    const loggedIn = await http.post('/auth/login').send(credentials).expect(200);
    const cookie = refreshCookie(loggedIn);

    const loggedOut = await http
      .post('/auth/logout')
      .set('Authorization', `Bearer ${loggedIn.body.accessToken}`)
      .expect(200);

    // The clear-cookie response wipes the value.
    const cleared = (loggedOut.headers['set-cookie'] as unknown as string[]).find(
      (c) => c.startsWith('refresh_token='),
    )!;
    expect(cleared).toMatch(/refresh_token=;/);

    // Even holding the old cookie value, refresh is dead (hash was set to NULL).
    await http.post('/auth/refresh').set('Cookie', cookie).expect(401);
  });

  it('rejects a login with a wrong password', () => {
    return http
      .post('/auth/login')
      .send({ email: credentials.email, password: 'wrong-password' })
      .expect(401);
  });
});
