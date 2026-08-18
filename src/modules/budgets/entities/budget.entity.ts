import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { TransactionCategory } from '../../transactions/entities/transaction.entity';

@Entity('budgets')
@Unique(['userId', 'category', 'month'])
export class Budget {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column({ type: 'varchar' })
  category!: TransactionCategory;

  // Format: YYYY-MM (e.g. "2026-08")
  @Column({ type: 'varchar', length: 7 })
  month!: string;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  limit!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
