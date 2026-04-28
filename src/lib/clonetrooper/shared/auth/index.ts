/**
 * Trames Authentication Library
 * 
 * Shared authentication utilities for all Trames API servers
 * Provides consistent session handling and JWT validation
 * 
 * @example Basic Usage
 * ```typescript
 * import { createCloneTrooperFromFactory } from '@/shared/auth';
 * 
 * const clonetrooper = createCloneTrooperFromFactory({
 *   appName: 'my_app'
 * });
 * 
 * const session = await clonetrooper.validateKenobySession_AppOrgGrp(
 *   request.headers.get('cookie')
 * );
 * ```
 */

// Core types and interfaces
export type {
  AuthResult,
  TramesesSessionData,
  AuthenticatedUser,
  SessionConfig,
  AuthMiddlewareOptions,
  ParsedCookies,
  AuthError
} from './types';

export { 
  AuthErrorType,
  AuthResultSchema,
  TramesesSessionDataSchema
} from './types';

// Session utilities
export {
  parseCookies,
  createCookieStore,
  decodeJWTPayload,
  isJWTExpired,
  validateTramesesSession
} from './session-utils';

// JWT Validator (Simple API for engineers)
export {
  TramesesJWTValidator,
  createValidator,
  type JWTValidationResult,
  type JWTValidatorOptions
} from './jwt-validator';

// Clone Trooper Factory (Recommended API for app validation)
export {
  createCloneTrooperFromFactory,
  CloneTrooperError,
  type ValidatedSession_AppUserOnly,
  type ValidatedSession_AppOrgGrp,
  type CloneTrooperOptions
} from './clonetrooper-factory';