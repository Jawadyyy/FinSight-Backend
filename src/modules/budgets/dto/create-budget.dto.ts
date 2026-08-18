import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNumber, IsNotEmpty, Matches, Min } from 'class-validator';
import { TransactionCategory } from '../../transactions/entities/transaction.entity';

export class CreateBudgetDto {
  @ApiProperty({ example: 'Food', enum: TransactionCategory })
  @IsEnum(TransactionCategory)
  category!: TransactionCategory;

  @ApiProperty({ example: '2026-08', description: 'YYYY-MM format' })
  @IsNotEmpty()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month!: string;

  @ApiProperty({ example: 500 })
  @IsNumber()
  @Min(0.01)
  limit!: number;
}
