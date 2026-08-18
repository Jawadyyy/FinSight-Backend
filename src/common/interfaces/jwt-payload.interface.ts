/**
 * This is what we put inside every JWT we sign.
 * "sub" (subject) is the standard JWT claim for "who this token belongs to".
 */
export interface JwtPayload {
  sub: string;
  email: string;
}

/** What the jwt strategy attaches to `request.user` on protected routes. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  name?: string;
}

/** What the jwt-refresh strategy attaches to `request.user` on POST /auth/refresh. */
export interface RefreshRequestUser {
  userId: string;
  refreshToken: string;
}
