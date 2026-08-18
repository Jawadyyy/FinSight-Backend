import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TokensDto } from './tokens.dto';

class UserSummaryDto {
  @ApiProperty({ example: 'b3f1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d' })
  id!: string;

  @ApiProperty({ example: 'user@example.com' })
  email!: string;

  @ApiPropertyOptional({ example: 'John Doe' })
  name?: string;
}

/**
 * What AuthService produces internally: both tokens plus the safe user fields.
 * The controller splits this — refresh token into the httpOnly cookie, the rest
 * into the JSON body (the DTOs below).
 */
export class AuthResponseDto extends TokensDto {
  @ApiProperty({ type: UserSummaryDto })
  user!: UserSummaryDto;
}

/**
 * The JSON body for register / login. Note there is no refreshToken here — it
 * goes into the httpOnly cookie so JavaScript can never read it.
 */
export class AuthBodyDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  accessToken!: string;

  @ApiProperty({ type: UserSummaryDto })
  user!: UserSummaryDto;
}

/** The JSON body for refresh: just the new access token. */
export class AccessTokenBodyDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  accessToken!: string;
}
