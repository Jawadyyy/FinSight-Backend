import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsNumber, IsOptional, IsDateString, IsString, Min } from 'class-validator';
import { TransactionType, TransactionCategory } from '../entities/transaction.entity';

export class CreateTransactionDto {
  @ApiProperty({ description: 'Transaction amount', example: 49.99 })
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @ApiProperty({ description: 'What the transaction was for', example: 'Grocery shopping at Walmart' })
  @IsString()
  @IsNotEmpty()
  description!: string;

  @ApiPropertyOptional({ description: 'Spending category', example: 'Food', enum: TransactionCategory })
  @IsEnum(TransactionCategory)
  @IsOptional()
  category?: TransactionCategory;

  @ApiPropertyOptional({ description: 'Income or expense', example: 'expense', enum: TransactionType })
  @IsEnum(TransactionType)
  @IsOptional()
  type?: TransactionType;

  @ApiProperty({ description: 'Date of the transaction', example: '2026-08-18' })
  @IsDateString()
  date!: string;
}
