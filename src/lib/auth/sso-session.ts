/**
 * SSO Session management using Clonetrooper
 * Handles authentication via Trames SSO (Kenoby)
 *
 * meeting-whisperer is a regular user app — any authenticated user with
 * app access is allowed. No org/group selection, no super-admin check.
 */

import { createCloneTrooperFromFactory, CloneTrooperError } from '@/lib/clonetrooper/shared/auth';
import { cookies } from 'next/headers';

const clonetrooperUserOnly = createCloneTrooperFromFactory({
  domain: process.env.CLONETROOPER_ENV_DOMAIN || 'https://login.trames.io',
  appName: process.env.CLONETROOPER_ENV_APP_NAME || 'meeting-whisperer',
  requireOrgSelection: false,
});

export interface SSOSessionData {
  userId: string;
  email: string;
  allowedApps: Array<{ n: string }>;
  scopes: Array<{ s: string }>;
}

export async function validateSSOSession(cookieHeader: string | null): Promise<SSOSessionData | null> {
  if (!cookieHeader) {
    return null;
  }

  try {
    const session = await clonetrooperUserOnly.validateKenobySession_AppUserOnly(cookieHeader);

    return {
      userId: session.userId,
      email: session.email,
      allowedApps: session.allowedApps,
      scopes: session.scopes,
    };
  } catch (error) {
    if (error instanceof CloneTrooperError) {
      console.error('[SSO] Validation failed:', error.code, error.message);
    } else {
      console.error('[SSO] Unexpected error:', error);
    }
    return null;
  }
}

/**
 * Get current SSO user from the cookie jar (server components / route handlers).
 * Returns null if not authenticated.
 */
export async function getCurrentUser(): Promise<SSOSessionData | null> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();

  return validateSSOSession(cookieHeader);
}

/**
 * Get SSO session from raw request headers. Useful when you already have a Request
 * object in hand (e.g. inside a route handler) and don't want to round-trip through
 * next/headers.
 */
export async function getCurrentUserFromHeaders(headers: Headers): Promise<SSOSessionData | null> {
  const cookieHeader = headers.get('cookie');
  return validateSSOSession(cookieHeader);
}

export { CloneTrooperError };
