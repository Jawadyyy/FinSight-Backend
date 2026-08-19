import { ApiProperty } from '@nestjs/swagger';

export class UploadResponseDto {
  @ApiProperty({ example: 15, description: 'Number of transactions imported' })
  imported!: number;

  @ApiProperty({ example: 2, description: 'Number of rows skipped (invalid data)' })
  skipped!: number;

  @ApiProperty({
    example: 3,
    description: 'Rows already present from an earlier upload of the same statement',
  })
  duplicates!: number;

  @ApiProperty({
    example: 1,
    description: 'Imported rows the parser was unsure about, flagged for review',
  })
  needsReview!: number;

  @ApiProperty({
    type: [String],
    example: ['Statement totals do not balance: …'],
    description: 'Statement-level discrepancies found while parsing',
  })
  warnings!: string[];
}
