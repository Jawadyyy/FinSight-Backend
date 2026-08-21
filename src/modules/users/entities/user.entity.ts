import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/** How the account signs in. 'local' = email + password, 'google' = Google OAuth. */
export type AuthProvider = 'local' | 'google';

/** Free is capped on uploads and has no AI insights; Pro has neither limit. */
export type SubscriptionTier = 'free' | 'pro';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', unique: true })
  email!: string;

  /**
   * bcrypt hash — the plain password is never stored or logged.
   * Nullable because Google users have no password; they sign in through Google.
   */
  @Column({ type: 'varchar', nullable: true })
  password?: string | null;

  /** 'local' by default; 'google' for accounts created via Google sign-in. */
  @Column({ type: 'varchar', default: 'local' })
  provider!: AuthProvider;

  @Column({ type: 'varchar', nullable: true })
  name?: string;

  /**
   * SHA-256 of the refresh token we last handed out to this user.
   *
   * We store a hash instead of the token itself so a leaked database dump
   * cannot be used to log in. It is nullable because a logged-out user has
   * no valid refresh token.
   */
  @Column({ type: 'varchar', nullable: true })
  hashedRefreshToken?: string | null;

  /** Which plan the account is on. Everyone starts free. */
  @Column({ type: 'varchar', length: 10, default: 'free' })
  tier!: SubscriptionTier;

  /**
   * Statement uploads used in `uploadsPeriod`.
   *
   * ponytail: a counter on the user rather than an uploads table — it answers
   * "how many left this month?" in one read and needs no join. Add a table if
   * you ever want upload history or per-file auditing.
   */
  @Column({ type: 'int', default: 0 })
  uploadsUsed!: number;

  /** The month the counter belongs to (YYYY-MM); a new month resets it. */
  @Column({ type: 'varchar', length: 7, nullable: true })
  uploadsPeriod?: string | null;

  @Column({ type: 'timestamp', nullable: true })
  lastLoginAt?: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
