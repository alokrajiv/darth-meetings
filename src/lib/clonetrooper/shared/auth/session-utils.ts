/**
 * Shared session utilities for Trames API servers
 * JWT-based session validation with RSA public key verification
 */

import * as jwt from 'jsonwebtoken';
import type {
  AuthResult,
  TramesesSessionData,
  SessionConfig,
  ParsedCookies,
  AuthError,
  ResolvedCloneTrooperConfig
} from './types';
import { AuthErrorType } from './types';

// JWKS response type
interface JWKSResponse {
  keys: Array<{
    kty: string;
    n: string;
    e: string;
    kid?: string;
    alg?: string;
    use?: string;
  }>;
}

// JWKS cache
let cachedPublicKey: string | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Fetch public key from JWKS endpoint for JWT verification
 * Cached for 1 hour to reduce requests
 */
async function getPublicKey(loginDomain: string = 'https://login.trames.io'): Promise<string> {
  // Check cache
  if (cachedPublicKey && (Date.now() - cacheTimestamp) < CACHE_TTL) {
    return cachedPublicKey;
  }

  try {
    const response = await fetch(`${loginDomain}/api/.well-known/jwks`);

    if (!response.ok) {
      throw new Error(`Failed to fetch JWKS: ${response.status}`);
    }

    const jwks = await response.json() as JWKSResponse;

    if (!jwks.keys || jwks.keys.length === 0) {
      throw new Error('No keys found in JWKS');
    }

    // Get first key (you can add kid matching if needed)
    const key = jwks.keys[0];
    if (!key) {
      throw new Error('No key found in JWKS');
    }

    // Convert JWK to PEM format
    const publicKey = await jwkToPem(key);

    // Cache it
    cachedPublicKey = publicKey;
    cacheTimestamp = Date.now();

    return publicKey;
  } catch (error) {
    console.error('Failed to fetch JWKS:', error);
    throw new Error('Unable to fetch public key for JWT verification');
  }
}

/**
 * Convert JWK to PEM format
 */
async function jwkToPem(jwk: JWKSResponse['keys'][0]): Promise<string> {
  const crypto = await import('crypto');

  const publicKey = crypto.createPublicKey({
    key: {
      kty: jwk.kty,
      n: jwk.n,
      e: jwk.e,
    },
    format: 'jwk',
  });

  return publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

/**
 * Parse cookies from cookie header string
 */
export function parseCookies(cookieHeader?: string): ParsedCookies {
  const cookies: ParsedCookies = {};
  
  if (cookieHeader) {
    const cookiePairs = cookieHeader.split(';');
    for (const pair of cookiePairs) {
      const [name, value] = pair.trim().split('=');
      if (name && value) {
        cookies[name] = decodeURIComponent(value);
      }
    }
  }
  
  return cookies;
}

/**
 * Create cookie store for iron-session from parsed cookies
 */
export function createCookieStore(cookies: ParsedCookies) {
  return {
    get: (name: string) => {
      const value = cookies[name];
      return value ? { name, value } : undefined;
    },
    set: () => {},
    delete: () => {},
  };
}

/**
 * JWT token utilities
 */
export function decodeJWTPayload(token: string): any {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const base64Payload = parts[1];
    if (!base64Payload) {
      return null;
    }
    
    const payload = JSON.parse(
      Buffer.from(base64Payload, 'base64url').toString('utf-8')
    );

    return payload;
  } catch (error) {
    console.error('JWT decode error:', error);
    return null;
  }
}

export function isJWTExpired(token: string, bufferMinutes = 5): boolean {
  const payload = decodeJWTPayload(token);
  if (!payload || typeof payload !== 'object' || !payload.exp) {
    return true;
  }

  const bufferTime = bufferMinutes * 60 * 1000;
  const expiryTime = payload.exp * 1000;
  const now = Date.now();

  return expiryTime <= (now + bufferTime);
}


/**
 * Core session validation function
 * JWT-based validation with RSA signature verification
 * 
 * @param cookieHeader The Cookie header string from the request
 * @param config Strongly typed config - loginDomain required, appName optional (only needed for app access checking)
 */
export async function validateTramesesSession(
  cookieHeader: string,
  config: { loginDomain: string; requireOrgSelection: boolean; appName?: string }
): Promise<{ success: true; data: AuthResult } | { success: false; error: AuthError }> {

  try {
    // Parse cookies from header
    const cookies = parseCookies(cookieHeader);
    const sessionToken = cookies['trames-auth-session'];

    // No session cookie = not authenticated
    if (!sessionToken) {
      return {
        success: false,
        error: {
          type: AuthErrorType.NO_SESSION,
          message: 'No session cookie found'
        }
      };
    }

    // Get public key from JWKS endpoint (cached) - loginDomain is guaranteed from config
    const publicKey = await getPublicKey(config.loginDomain);

    // Verify JWT signature - loginDomain is guaranteed from config
    let payload: any;
    try {
      payload = jwt.verify(sessionToken, publicKey, {
        algorithms: ['RS256'],
        issuer: config.loginDomain,
      });
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        return {
          success: false,
          error: {
            type: AuthErrorType.EXPIRED_SESSION,
            message: 'Session expired'
          }
        };
      }

      if (error instanceof jwt.JsonWebTokenError) {
        return {
          success: false,
          error: {
            type: AuthErrorType.INVALID_SESSION,
            message: 'Invalid session token'
          }
        };
      }

      throw error;
    }

    // Extract user data from JWT payload
    const userId = payload.userId || payload.sub;
    const email = payload.email;
    const orgLid = payload.orgLid;
    const groupLid = payload.groupLid;
    const orgName = payload.orgName;
    const groupName = payload.groupName;
    const allowedApps = payload.allowedApps;
    const scopes = payload.scopes;

    if (!userId || !email) {
      return {
        success: false,
        error: {
          type: AuthErrorType.INVALID_SESSION,
          message: 'Missing required user data in session'
        }
      };
    }

    // Check organization selection if required - config.requireOrgSelection is guaranteed
    if (config.requireOrgSelection && !orgLid) {
      return {
        success: false,
        error: {
          type: AuthErrorType.NO_ORG_SELECTED,
          message: 'No organization selected'
        }
      };
    }

    const authData: AuthResult = {
      isAuthenticated: true,
      userId,
      email,
      orgLid,
      groupLid,
      orgName,
      groupName,
      allowedApps,
      scopes
    };

    return {
      success: true,
      data: authData
    };

  } catch (error) {
    console.error('Session validation error:', error);
    return {
      success: false,
      error: {
        type: AuthErrorType.DECRYPTION_FAILED,
        message: 'Session verification failed',
        details: error instanceof Error ? error.message : 'Unknown error'
      }
    };
  }
}