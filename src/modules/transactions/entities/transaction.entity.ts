import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum TransactionType {
  INCOME = 'income',
  EXPENSE = 'expense',
  /** Money moved between accounts — not spending, so budgets ignore it. */
  TRANSFER = 'transfer',
}

export enum TransactionCategory {
  FOOD = 'Food',
  SHOPPING = 'Shopping',
  TRANSPORT = 'Transport',
  BILLS = 'Bills',
  ENTERTAINMENT = 'Entertainment',
  /**
   * Beyond the six in the scope document. Pharmacies, clinics and gyms fit
   * none of the others, and folding them into Shopping would hide medical
   * spending inside a retail total.
   */
  HEALTH = 'Health',
  OTHER = 'Other',
}

export enum TransactionSource {
  MANUAL = 'manual',
  CSV = 'csv',
  PDF = 'pdf',
}

@Entity('transactions')
export class Transaction {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  amount!: number;

  @Column({ type: 'varchar' })
  description!: string;

  @Column({ type: 'varchar', default: TransactionCategory.OTHER })
  category!: TransactionCategory;

  @Column({ type: 'varchar', default: TransactionType.EXPENSE })
  type!: TransactionType;

  @Column({ type: 'varchar', default: TransactionSource.MANUAL })
  source!: TransactionSource;

  @Column({ type: 'date' })
  date!: string;

  /** Merchant pulled out of the description, when one could be identified. */
  @Column({ type: 'varchar', nullable: true })
  merchant?: string | null;

  /** ORDER #, REF, CONSUMER NO — kept separate from the amount. */
  @Column({ type: 'varchar', nullable: true })
  reference?: string | null;

  @Column({ type: 'varchar', length: 3, default: 'PKR' })
  currency!: string;

  /** Face value when the row was billed in another currency (e.g. USD 23.99). */
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  originalAmount?: number | null;

  @Column({ type: 'varchar', length: 3, nullable: true })
  originalCurrency?: string | null;

  /** Running balance printed on the statement row. */
  @Column({ type: 'decimal', precision: 14, scale: 2, nullable: true })
  balanceAfter?: number | null;

  /** 0–1 parser confidence; low scores set needsReview. */
  @Column({ type: 'decimal', precision: 3, scale: 2, default: 1 })
  confidence!: number;

  /** 0–1 confidence in the assigned category (the doc's ai_confidence_score). */
  @Column({ type: 'decimal', precision: 3, scale: 2, default: 0 })
  categoryConfidence!: number;

  /**
   * Who chose the category: a keyword rule, the model, or the user. A manual
   * choice is never overwritten by a later categorisation run.
   */
  @Column({ type: 'varchar', length: 10, nullable: true })
  categorySource?: 'rule' | 'ai' | 'manual' | null;

  @Column({ type: 'boolean', default: false })
  needsReview!: boolean;

  /** Original extracted line, kept for debugging and review. */
  @Column({ type: 'text', nullable: true })
  rawText?: string | null;

  /**
   * Fingerprint of the imported row, unique per user, so re-uploading the same
   * statement cannot create duplicates.
   */
  @Index()
  @Column({ type: 'varchar', length: 64, nullable: true })
  importHash?: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
