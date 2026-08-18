import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Runs the 'google' strategy. On the first route it redirects to Google; on the
 * callback route it turns the code into a profile and fills request.user.
 */
@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {}
