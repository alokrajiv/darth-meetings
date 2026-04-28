/**
 * Simple JWT Validator for Trames SSO
 *
 * Provides an easy-to-use class for validating JWT tokens from trames-auth-session cookie.
 * Handles JWKS endpoint caching automatically.
 *
 * @example Basic Usage
 * ```typescript
 * import { TramesesJWTValidator } from '@/shared/auth/jwt-validator';
 *
 * // Initialize with default domain (login.trames.io)
 * const validator = new TramesesJWTValidator();
 *
 * // Or specify custom domain
 * const validator = new TramesesJWTValidator({ domain: 'https://login.custom.com' });
 *
 * // Validate JWT from request
 * const result = await validator.validate(request.headers.get('cookie'));
 *
 * if (result.valid) {
 *   console.log('User:', result.payload.userId, result.payload.email);
 *   console.log('Org:', result.payload.orgLid, result.payload.groupLid);
 * } else {
 *   console.error('Invalid JWT:', result.error);
 * }
 * ```
 */

import { validateTramesesSession } from './session-utils';
import type { AuthResult, AuthError } from './types';

export interface JWTValidationResult {
  valid: boolean;
  payload?: AuthResult;
  error?: string;
}

export interface JWTValidatorOptions {
  /** SSO login domain (default: https://login.trames.io) */
  domain?: string;
  /** Require org/group selection in JWT (default: false) */
  requireOrgSelection?: boolean;
}

/**
 * Simple JWT Validator for Trames SSO
 *
 * Automatically fetches and caches JWKS public keys for JWT verification.
 */
export class TramesesJWTValidator {
  private domain: string;
  private requireOrgSelection: boolean;

  /**
   * Create a new JWT validator
   *
   * @param options Configuration options
   */
  constructor(options: JWTValidatorOptions = {}) {
    this.domain = options.domain || 'https://login.trames.io';
    this.requireOrgSelection = options.requireOrgSelection || false;
  }

  /**
   * Validate JWT from cookie header
   *
   * @param cookieHeader The Cookie header string from the request
   * @returns Validation result with payload or error
   *
   * @example
   * ```typescript
   * const validator = new TramesesJWTValidator();
   * const result = await validator.validate(request.headers.get('cookie'));
   *
   * if (result.valid) {
   *   const { userId, email, orgLid, groupLid } = result.payload;
   *   // Use authenticated user data
   * } else {
   *   // Handle authentication error
   *   console.error(result.error);
   * }
   * ```
   */
  async validate(cookieHeader: string | null): Promise<JWTValidationResult> {
    if (!cookieHeader) {
      return {
        valid: false,
        error: 'No cookie header provided'
      };
    }

    const result = await validateTramesesSession(cookieHeader, {
      loginDomain: this.domain,
      requireOrgSelection: this.requireOrgSelection
    });

    if (result.success) {
      return {
        valid: true,
        payload: result.data
      };
    }

    return {
      valid: false,
      error: result.error.message
    };
  }

  /**
   * Validate and extract payload in one step
   * Throws error if validation fails
   *
   * @param cookieHeader The Cookie header string from the request
   * @returns The validated JWT payload
   * @throws Error if JWT is invalid
   *
   * @example
   * ```typescript
   * const validator = new TramesesJWTValidator();
   *
   * try {
   *   const payload = await validator.validateOrThrow(request.headers.get('cookie'));
   *   // payload.userId, payload.email, etc. are guaranteed to exist
   * } catch (error) {
   *   return new Response('Unauthorized', { status: 401 });
   * }
   * ```
   */
  async validateOrThrow(cookieHeader: string | null): Promise<AuthResult> {
    const result = await this.validate(cookieHeader);

    if (!result.valid || !result.payload) {
      throw new Error(result.error || 'JWT validation failed');
    }

    return result.payload;
  }

  /**
   * Extract JWT payload without full validation (no signature check)
   * Useful for debugging or non-security-critical use cases
   *
   * @param cookieHeader The Cookie header string
   * @returns Decoded JWT payload or null
   *
   * @example
   * ```typescript
   * const validator = new TramesesJWTValidator();
   * const payload = validator.decodeUnsafe(request.headers.get('cookie'));
   * console.log('JWT contains:', payload);
   * ```
   */
  decodeUnsafe(cookieHeader: string | null): any {
    if (!cookieHeader) return null;

    const cookies = cookieHeader.split(';').reduce((acc, cookie) => {
      const [name, value] = cookie.trim().split('=');
      if (name === 'trames-auth-session' && value) {
        acc = decodeURIComponent(value);
      }
      return acc;
    }, '');

    if (!cookies) return null;

    try {
      const parts = cookies.split('.');
      if (parts.length !== 3 || !parts[1]) return null;

      const payload = JSON.parse(
        Buffer.from(parts[1], 'base64url').toString('utf-8')
      );

      return payload;
    } catch {
      return null;
    }
  }
}

/**
 * Create a validator instance with default settings
 * Convenience function for most common use case
 *
 * @example
 * ```typescript
 * import { createValidator } from '@/shared/auth/jwt-validator';
 *
 * const validator = createValidator();
 * const result = await validator.validate(cookieHeader);
 * ```
 */
export function createValidator(options?: JWTValidatorOptions): TramesesJWTValidator {
  return new TramesesJWTValidator(options);
}
