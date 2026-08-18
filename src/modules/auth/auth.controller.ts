import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiBearerAuth,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { AccessTokenBodyDto, AuthBodyDto } from './dto/auth-response.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { REFRESH_COOKIE, refreshCookieOptions } from './refresh-cookie';
import { verifyGoogleIdToken } from './google-token';
// `import type` is required here: these are interfaces used in decorated
// method signatures, and they must not survive into the emitted JavaScript.
import type {
  AuthenticatedUser,
  RefreshRequestUser,
} from '../../common/interfaces/jwt-payload.interface';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create an account; sets the refresh cookie' })
  @ApiResponse({ status: 201, type: AuthBodyDto })
  @ApiResponse({ status: 409, description: 'Email already registered' })
  async register(
    @Body() createUserDto: CreateUserDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthBodyDto> {
    const { accessToken, refreshToken, user } =
      await this.authService.register(createUserDto);
    this.setRefreshCookie(response, refreshToken);
    return { accessToken, user };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Log in; sets the refresh cookie' })
  @ApiResponse({ status: 200, type: AuthBodyDto })
  @ApiResponse({ status: 401, description: 'Invalid email or password' })
  async login(
    @Body() loginDto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthBodyDto> {
    const { accessToken, refreshToken, user } =
      await this.authService.login(loginDto);
    this.setRefreshCookie(response, refreshToken);
    return { accessToken, user };
  }

  /**
   * Reads the refresh token from the httpOnly cookie, rotates it, and sets the
   * new one. Returns only the new access token in the body.
   */
  @Post('refresh')
  @UseGuards(JwtRefreshGuard)
  @ApiCookieAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate the refresh cookie, get a new access token',
  })
  @ApiResponse({ status: 200, type: AccessTokenBodyDto })
  @ApiResponse({ status: 401, description: 'Refresh token is no longer valid' })
  async refresh(
    @CurrentUser() user: RefreshRequestUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AccessTokenBodyDto> {
    const { accessToken, refreshToken } = await this.authService.refreshTokens(
      user.userId,
      user.refreshToken,
    );
    this.setRefreshCookie(response, refreshToken);
    return { accessToken };
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke the refresh token and clear the cookie' })
  @ApiResponse({ status: 200, description: 'Logged out successfully' })
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.logout(user.id);
    // Clear with the same options (minus maxAge) or the browser keeps the cookie.
    response.clearCookie(REFRESH_COOKIE, {
      ...refreshCookieOptions(this.configService),
      maxAge: undefined,
    });
    return result;
  }

  /**
   * Google sign-in for @react-oauth/google. The frontend does the popup and
   * sends us the Google ID token ("credential"). We verify it with Google,
   * find-or-create the user, and issue OUR tokens exactly like a normal login.
   */
  @Post('google')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify a Google ID token and sign in' })
  @ApiResponse({ status: 200, type: AuthBodyDto })
  @ApiResponse({ status: 401, description: 'Invalid Google token' })
  async google(
    @Body() googleLoginDto: GoogleLoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthBodyDto> {
    const clientId = this.configService.getOrThrow<string>('GOOGLE_CLIENT_ID');

    let googleUser;
    try {
      googleUser = await verifyGoogleIdToken(googleLoginDto.credential, clientId);
    } catch {
      throw new UnauthorizedException('Invalid Google token');
    }

    const { accessToken, refreshToken, user } =
      await this.authService.loginWithGoogle(googleUser);
    this.setRefreshCookie(response, refreshToken);
    return { accessToken, user };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Who the current access token belongs to' })
  @ApiResponse({ status: 200, description: 'The logged in user' })
  getProfile(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }

  /** Write the refresh token into the httpOnly cookie. */
  private setRefreshCookie(response: Response, refreshToken: string): void {
    response.cookie(
      REFRESH_COOKIE,
      refreshToken,
      refreshCookieOptions(this.configService),
    );
  }
}
