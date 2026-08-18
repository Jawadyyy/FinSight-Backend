import { ApiProperty } from '@nestjs/swagger';

/** The pair of tokens we hand back from register / login / refresh. */
export class TokensDto {
  @ApiProperty({
    description: 'Short lived token. Send it as: Authorization: Bearer <token>',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  accessToken!: string;

  @ApiProperty({
    description:
      'Long lived token. Only used on POST /auth/refresh to get a new pair.',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  refreshToken!: string;
}
