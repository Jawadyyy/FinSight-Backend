import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/** How the account signs in. 'local' = email + password, 'google' = Google OAuth. */
export type AuthProvider = 'local' | 'google';

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

  @Column({ type: 'timestamp', nullable: true })
  lastLoginAt?: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
