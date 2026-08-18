import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile, VerifyCallback } from 'passport-google-oauth20';

/** The trimmed-down Google profile we care about — email and name. */
export interface GoogleUser {
  email: string;
  name?: string;
}

/**
 * Handles "Sign in with Google", registered under the name 'google'.
 *
 * The flow has two steps, both guarded by this strategy:
 *   1. GET /auth/google           → we redirect the browser to Google's consent screen
 *   2. GET /auth/google/callback  → Google sends the user back with a one-time code;
 *                                    Passport exchanges it for the profile and calls validate()
 *
 * We never see or store the user's Google password — Google vouches for the email.
 */
@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(configService: ConfigService) {
    super({
      clientID: configService.getOrThrow<string>('GOOGLE_CLIENT_ID'),
      clientSecret: configService.getOrThrow<string>('GOOGLE_CLIENT_SECRET'),
      callbackURL: configService.getOrThrow<string>('GOOGLE_CALLBACK_URL'),
      scope: ['email', 'profile'], // what we ask Google for
    });
  }

  /**
   * Passport calls this after Google confirms the user. Whatever we pass to
   * `done` becomes `request.user` in the callback controller.
   */
  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): void {
    const email = profile.emails?.[0]?.value;

    if (!email) {
      // No email means we cannot create an account — reject.
      done(new Error('Google account has no email'), undefined);
      return;
    }

    const googleUser: GoogleUser = { email, name: profile.displayName };
    done(null, googleUser);
  }
}
