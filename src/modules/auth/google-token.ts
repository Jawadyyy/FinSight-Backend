import { OAuth2Client } from 'google-auth-library';

/** The trimmed-down Google profile we care about. */
export interface GoogleUser {
  email: string;
  name?: string;
}

// One reusable client. It fetches and caches Google's public signing keys.
const client = new OAuth2Client();

/**
 * Verify a Google ID token (the "credential" the frontend gets from
 * @react-oauth/google) and return the email + name.
 *
 * verifyIdToken checks the signature against Google's public keys, the expiry,
 * and that the token's audience matches OUR client id — so a token minted for a
 * different app is rejected. If any check fails it throws.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  clientId: string,
): Promise<GoogleUser> {
  const ticket = await client.verifyIdToken({ idToken, audience: clientId });
  const payload = ticket.getPayload();

  if (!payload?.email) {
    throw new Error('Google token has no email');
  }

  return { email: payload.email, name: payload.name };
}
