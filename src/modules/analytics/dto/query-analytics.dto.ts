import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

export class QueryAnalyticsDto {
  @ApiPropertyOptional({ example: '2026-03-01', description: 'Start of the range' })
  @IsDateString()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-31', description: 'End of the range' })
  @IsDateString()
  @IsOptional()
  to?: string;

  @ApiPropertyOptional({ example: 6, description: 'Months back from today when no range is given' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  @IsOptional()
  months?: number;

  @ApiPropertyOptional({ example: '2026-08', description: 'Month for budget vs actual (YYYY-MM)' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  @IsOptional()
  month?: string;
}
