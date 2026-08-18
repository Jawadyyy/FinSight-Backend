import { ApiProperty } from '@nestjs/swagger';

export class UploadResponseDto {
  @ApiProperty({ example: 15, description: 'Number of transactions imported' })
  imported!: number;

  @ApiProperty({ example: 2, description: 'Number of rows skipped (invalid data)' })
  skipped!: number;
}
