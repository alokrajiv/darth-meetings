/**
 * Shared authentication types for Trames API servers
 * Used by thrawn-server, tarkin-server, and future API repos
 */

import { z } from 'zod';

// Basic auth result interface
export interface AuthResult {
  isAuthenticated: boolean;
  userId?: string;
  email?: string;
  orgLid?: string; // Changed from selectedOrgId (number) to orgLid (string)
  groupLid?: string; // Changed from selectedGroupId (number) to groupLid (string)
  orgName?: string;
  groupName?: string;
  allowedApps: Array<{ n: string }>; // REQUIRED - Apps user has access to
  scopes: Array<{ s: string }>; // REQUIRED - User-level scopes/permissions
}

// Zod schema for auth result validation
export const AuthResultSchema = z.object({
  isAuthenticated: z.boolean(),
  userId: z.string().optional(),
  email: z.string().email().optional(),
  orgLid: z.string().optional(), // Changed from selectedOrgId (number)
  groupLid: z.string().optional() // Changed from selectedGroupId (number)
});

// Iron session data structure for Trames applications
export interface TramesesSessionData {
  isAuthenticated?: boolean;
  accessToken?: string;        // JWT token (also validated for expiry)
  expiresAt?: number;         // Session expiration timestamp
  userId?: string;
  email?: string;
  userAttributes?: any;
  orgLid?: string;            // Organization logical identifier
  groupLid?: string;          // Group logical identifier
  orgName?: string;           // Organization name
  groupName?: string;         // Group name
  allowedApps: Array<{ n: string }>; // REQUIRED - Apps user has access to
  scopes: Array<{ s: string }>; // REQUIRED - User-level scopes/permissions
}

// Zod schema for session data validation
export const TramesesSessionDataSchema = z.object({
  isAuthenticated: z.boolean().optional(),
  accessToken: z.string().optional(),
  expiresAt: z.number().optional(),
  userId: z.string().optional(),
  email: z.string().email().optional(),
  userAttributes: z.any().optional()
});

// Authenticated user interface for Fastify request extension
export interface AuthenticatedUser {
  userId: string;
  email?: string;
  [key: string]: any; // Allow additional user attributes
}

// Session configuration options
export interface SessionConfig {
  password: string;
  cookieName: string;
  cookieOptions: {
    secure: boolean;
    httpOnly: boolean;
    maxAge: number;
    sameSite: 'strict' | 'lax' | 'none';
    path: string;
    domain?: string;
  };
}

// Factory options for creating auth middleware
export interface AuthMiddlewareOptions {
  domain?: string;
  requireOrgSelection?: boolean;
  customCookieName?: string;
}

// Auth error types
export enum AuthErrorType {
  NO_SESSION = 'NO_SESSION',
  INVALID_SESSION = 'INVALID_SESSION',
  EXPIRED_SESSION = 'EXPIRED_SESSION',
  EXPIRED_TOKEN = 'EXPIRED_TOKEN',
  NO_ORG_SELECTED = 'NO_ORG_SELECTED',
  DECRYPTION_FAILED = 'DECRYPTION_FAILED',
  APP_ACCESS_DENIED = 'APP_ACCESS_DENIED',  // User doesn't have access to this app
  NO_COOKIE_HEADER = 'NO_COOKIE_HEADER'     // No cookie header provided
}

export interface AuthError {
  type: AuthErrorType;
  message: string;
  details?: any;
}

// Cookie parsing result
export interface ParsedCookies {
  [key: string]: string;
}

// Resolved configuration - all env vars loaded at init time, strongly typed
export interface ResolvedCloneTrooperConfig {
  /** SSO login domain - REQUIRED, no defaults */
  loginDomain: string;
  /** App name to validate against JWT's allowedApps - REQUIRED, no defaults */
  appName: string;
  /** Whether org/group selection is required */
  requireOrgSelection: boolean;
}