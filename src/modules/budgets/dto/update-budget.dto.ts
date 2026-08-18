import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, Min } from 'class-validator';

export class UpdateBudgetDto {
  @ApiPropertyOptional({ example: 600 })
  @IsNumber()
  @IsOptional()
  @Min(0.01)
  limit?: number;
}
