/**
 * Clone Trooper Factory - For the Republic!
 *
 * Creates a JWT validator with closure-based factory pattern.
 * Validates Trames SSO JWT tokens and checks app access permissions.
 *
 * @example Basic Usage
 * ```typescript
 * import { createCloneTrooperFromFactory } from './lib/clonetrooper/shared/auth';
 *
 * // Initialize once at app startup
 * const clonetrooper = createCloneTrooperFromFactory({
 *   appName: 'thrawn_prod'
 * });
 *
 * // Validate JWT in request handlers
 * const result = await clonetrooper.validate(request.headers.get('cookie'));
 * if (result.valid) {
 *   const { userId, email, orgLid } = result.payload;
 *   // User is authenticated AND has access to thrawn_prod
 * }
 * ```
 */

import { validateTramesesSession } from './session-utils';
import { AuthErrorType, type AuthResult, type AuthError, type ResolvedCloneTrooperConfig } from './types';

export class CloneTrooperError extends Error {
  constructor(
    message: string,
    public readonly code: AuthErrorType,
    public readonly details?: any
  ) {
    super(message);
    this.name = 'CloneTrooperError';
  }
}

// App-only validation - no org/group required
export type ValidatedSession_AppUserOnly = {
  isAuthenticated: true;
  userId: string;
  email: string;
  allowedApps: Array<{ n: string }>; // REQUIRED - Apps user has access to
  scopes: Array<{ s: string }>; // REQUIRED - User-level scopes/permissions
};

// App + org/group validation - org/group guaranteed
export type ValidatedSession_AppOrgGrp = {
  isAuthenticated: true;
  userId: string;
  email: string;
  orgLid: string;
  groupLid: string;
  orgName?: string;
  groupName?: string;
  allowedApps: Array<{ n: string }>; // REQUIRED - Apps user has access to
  scopes: Array<{ s: string }>; // REQUIRED - User-level scopes/permissions
};

export interface CloneTrooperOptions {
  /** SSO login domain (required via options or CLONETROOPER_ENV_DOMAIN) */
  domain?: string;
  /** THIS app's name - validated against JWT's allowedApps (required via options or CLONETROOPER_ENV_APP_NAME) */
  appName?: string;
  /** Require org/group selection in JWT (optional, defaults to false) */
  requireOrgSelection?: boolean;
}

/**
 * Create a Clone Trooper validator (factory function with closures)
 *
 * @param options Configuration options
 * @returns CloneTrooper validator functions
 *
 * @example
 * ```typescript
 * const clonetrooper = createCloneTrooperFromFactory({
 *   domain: 'https://login.trames.io',
 *   appName: 'thrawn_prod'
 * });
 *
 * // For apps that don't need org/group
 * const result = await clonetrooper.validateKenobySession_AppUserOnly(cookieHeader);
 *
 * // For apps that require org/group
 * const result = await clonetrooper.validateKenobySession_AppOrgGrp(cookieHeader);
 * ```
 */
export function createCloneTrooperFromFactory(options: CloneTrooperOptions = {}) {
  // ============================================================================
  // SINGLE SOURCE OF TRUTH: Load all env vars at init time, fail loud if missing
  // ============================================================================
  const loginDomain =
    options.domain ||
    process.env.CLONETROOPER_ENV_DOMAIN;

  const appName =
    options.appName ||
    process.env.CLONETROOPER_ENV_APP_NAME;

  const requireOrgSelection =
    options.requireOrgSelection ??
    (process.env.CLONETROOPER_ENV_REQUIRE_ORG === 'true');

  // FAIL LOUD - no defaults, must be explicit
  if (!appName) {
    throw new Error(
      'CLONETROOPER: appName is required! Set via options.appName or CLONETROOPER_ENV_APP_NAME'
    );
  }

  if (!loginDomain) {
    throw new Error(
      'CLONETROOPER: domain is required! Set via options.domain or CLONETROOPER_ENV_DOMAIN'
    );
  }

  // Create strongly typed config - all env vars resolved, no optionals
  const config: ResolvedCloneTrooperConfig = {
    loginDomain,
    appName,
    requireOrgSelection: requireOrgSelection ?? false,
  };

  /**
   * Check if JWT's allowedApps contains this app
   */
  function checkAppAccess(allowedApps?: Array<{ n: string }>): boolean {
    if (!allowedApps || allowedApps.length === 0) {
      // No allowedApps in JWT = deny access (user has no apps)
      return false;
    }

    return allowedApps.some((app) => app.n === config.appName);
  }

  /**
   * Validate JWT for app access only (user identity + app permission)
   * Does NOT require org/group selection
   *
   * @param cookieHeader The Cookie header string from the request
   * @returns Validated session data with user info and allowedApps
   * @throws CloneTrooperError with typed error code if validation fails
   */
  async function validateKenobySession_AppUserOnly(
    cookieHeader: string | null
  ): Promise<ValidatedSession_AppUserOnly> {
    if (!cookieHeader) {
      throw new CloneTrooperError(
        'No cookie header provided',
        AuthErrorType.NO_COOKIE_HEADER
      );
    }

    const result = await validateTramesesSession(cookieHeader, {
      ...config,
      requireOrgSelection: false, // AppUserOnly doesn't require org
    });

    if (!result.success) {
      throw new CloneTrooperError(
        result.error.message,
        result.error.type,
        result.error.details
      );
    }

    // JWT is valid, now check app access
    const data = result.data;

    if (!checkAppAccess(data.allowedApps)) {
      throw new CloneTrooperError(
        `User does not have access to app '${config.appName}'`,
        AuthErrorType.APP_ACCESS_DENIED,
        { appName: config.appName, allowedApps: data.allowedApps }
      );
    }

    // Runtime validation - userId and email are required for all validations
    if (!data.userId || !data.email) {
      throw new CloneTrooperError(
        'Missing required session data',
        AuthErrorType.INVALID_SESSION,
        { userId: data.userId, email: data.email }
      );
    }

    // TypeScript now knows these are non-null - strong typing!
    const payload: ValidatedSession_AppUserOnly = {
      isAuthenticated: true,
      userId: data.userId,
      email: data.email,
      allowedApps: data.allowedApps,
      scopes: data.scopes || [],
    };

    return payload;
  }

  /**
   * Validate JWT for app access WITH org/group requirement
   * REQUIRES org/group selection in JWT
   *
   * @param cookieHeader The Cookie header string from the request
   * @returns Validated session data with user info, org/group, and allowedApps
   * @throws CloneTrooperError with typed error code if validation fails
   */
  async function validateKenobySession_AppOrgGrp(
    cookieHeader: string | null
  ): Promise<ValidatedSession_AppOrgGrp> {
    if (!cookieHeader) {
      throw new CloneTrooperError(
        'No cookie header provided',
        AuthErrorType.NO_COOKIE_HEADER
      );
    }

    const result = await validateTramesesSession(cookieHeader, {
      ...config,
      requireOrgSelection: true, // AppOrgGrp REQUIRES org
    });

    if (!result.success) {
      throw new CloneTrooperError(
        result.error.message,
        result.error.type,
        result.error.details
      );
    }

    // JWT is valid, now check app access and org/group
    const data = result.data;

    if (!checkAppAccess(data.allowedApps)) {
      throw new CloneTrooperError(
        `User does not have access to app '${config.appName}'`,
        AuthErrorType.APP_ACCESS_DENIED,
        { appName: config.appName, allowedApps: data.allowedApps }
      );
    }

    // Runtime validation - if we got here with requireOrgSelection=true, these MUST exist
    // (validateTramesesSession would have thrown NO_ORG_SELECTED otherwise)
    if (!data.userId || !data.email || !data.orgLid || !data.groupLid) {
      throw new CloneTrooperError(
        'Missing required session data',
        AuthErrorType.INVALID_SESSION,
        { userId: data.userId, email: data.email, orgLid: data.orgLid, groupLid: data.groupLid }
      );
    }

    // TypeScript now knows these are non-null - strong typing!
    const payload: ValidatedSession_AppOrgGrp = {
      isAuthenticated: true,
      userId: data.userId,
      email: data.email,
      orgLid: data.orgLid,
      groupLid: data.groupLid,
      orgName: data.orgName,
      groupName: data.groupName,
      allowedApps: data.allowedApps,
      scopes: data.scopes || [],
    };

    return payload;
  }

  /**
   * Extract JWT payload without full validation (no signature check, no app check)
   * Useful for debugging or non-security-critical use cases
   *
   * @param cookieHeader The Cookie header string
   * @returns Decoded JWT payload or null
   */
  function decodeUnsafe(cookieHeader: string | null): any {
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
        Buffer.from(parts[1]!, 'base64url').toString('utf-8')
      );

      return payload;
    } catch {
      return null;
    }
  }

  return {
    validateKenobySession_AppUserOnly,
    validateKenobySession_AppOrgGrp,
    decodeUnsafe,
  };
}
