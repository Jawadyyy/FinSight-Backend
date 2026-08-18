import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum TransactionType {
  INCOME = 'income',
  EXPENSE = 'expense',
}

export enum TransactionCategory {
  FOOD = 'Food',
  SHOPPING = 'Shopping',
  TRANSPORT = 'Transport',
  BILLS = 'Bills',
  ENTERTAINMENT = 'Entertainment',
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

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
