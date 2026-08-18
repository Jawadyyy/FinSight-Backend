import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';

/** Cost factor for bcrypt. 10 is the usual default: slow enough to matter, fast enough to log in. */
const SALT_ROUNDS = 10;

/** A throwaway hash, computed once at startup, only used to burn time on unknown emails. */
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', SALT_ROUNDS);

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  async create(createUserDto: CreateUserDto): Promise<User> {
    const user = this.usersRepository.create({
      email: normalizeEmail(createUserDto.email),
      password: await bcrypt.hash(createUserDto.password, SALT_ROUNDS),
      provider: 'local',
      name: createUserDto.name,
    });

    return this.usersRepository.save(user);
  }

  /**
   * Google sign-in: find the user by email, or create one if this is their
   * first time. Google already verified the email, so there is no password —
   * the account has provider 'google' and a null password.
   *
   * If a matching email already exists (even a local account), we just return
   * it: the person owns that email either way, so we log them in rather than
   * erroring on a duplicate.
   */
  async findOrCreateGoogleUser(googleUser: {
    email: string;
    name?: string;
  }): Promise<User> {
    const existing = await this.findByEmail(googleUser.email);
    if (existing) return existing;

    const user = this.usersRepository.create({
      email: normalizeEmail(googleUser.email),
      password: null,
      provider: 'google',
      name: googleUser.name,
    });

    return this.usersRepository.save(user);
  }

  findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({
      where: { email: normalizeEmail(email) },
    });
  }

  findById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  /**
   * Returns the user when the email/password pair is correct, otherwise null.
   *
   * When the email does not exist we still run a bcrypt compare against a dummy
   * hash. Without it, "unknown email" would answer noticeably faster than
   * "wrong password", which leaks to an attacker which emails are registered.
   */
  async validateCredentials(
    email: string,
    password: string,
  ): Promise<User | null> {
    const user = await this.findByEmail(email);

    // No user, or a Google account with no password: run the dummy compare so
    // the timing matches the real path, then reject.
    if (!user || !user.password) {
      await bcrypt.compare(password, DUMMY_HASH);
      return null;
    }

    const passwordMatches = await bcrypt.compare(password, user.password);
    return passwordMatches ? user : null;
  }

  /** Pass null to revoke (that is what logout does). */
  async setHashedRefreshToken(
    userId: string,
    hashedRefreshToken: string | null,
  ): Promise<void> {
    await this.usersRepository.update(userId, { hashedRefreshToken });
  }

  async updateLastLogin(userId: string): Promise<void> {
    await this.usersRepository.update(userId, { lastLoginAt: new Date() });
  }
}
