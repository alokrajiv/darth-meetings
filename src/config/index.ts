/**
 * Application configuration.
 *
 * Env var access is **lazy** — nothing throws at import time, so `next build`
 * runs fine on machines that don't have PG/AssemblyAI credentials. Missing
 * vars surface at first actual use (the Postgres pool or AAI client), with a
 * clear error at that point.
 */

import { SCHEMAS, DB_POOL_CONFIG } from '@/lib/constants/database';

export const config = {
  env: {
    get nodeEnv() {
      return process.env.NODE_ENV || 'development';
    },
    get schemaPrefix() {
      return process.env.SCHEMA_PREFIX || 'prod';
    },
    get isDevelopment() {
      return process.env.NODE_ENV === 'development';
    },
    get isProduction() {
      return process.env.NODE_ENV === 'production';
    },
  },

  auth: {
    get loginDomain() {
      return process.env.NEXT_PUBLIC_SSO_LOGIN_URL || 'https://login.trames.io';
    },
    get clonetrooperDomain() {
      return process.env.CLONETROOPER_ENV_DOMAIN || 'https://login.trames.io';
    },
    get appName() {
      return process.env.CLONETROOPER_ENV_APP_NAME || 'meeting-whisperer';
    },
    cookieName: 'trames-auth-session',
  },

  database: {
    get host() {
      return process.env.PGHOST || '';
    },
    get port() {
      return parseInt(process.env.PGPORT || '5432', 10);
    },
    get database() {
      return process.env.PGDATABASE || '';
    },
    get user() {
      return process.env.PGUSER || '';
    },
    get password() {
      return process.env.PGPASSWORD || '';
    },
    ssl: {
      get enabled() {
        return process.env.PGSSLMODE === 'require';
      },
    },
    schemas: SCHEMAS,
    poolConfig: DB_POOL_CONFIG,
  },

  assemblyai: {
    get apiKey() {
      return process.env.ASSEMBLYAI_API_KEY || '';
    },
  },

  google: {
    get clientId() {
      return process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '';
    },
    get clientSecret() {
      return process.env.GOOGLE_CLIENT_SECRET || '';
    },
    /** Second Internal OAuth client, owned by the trames-engineering.com
     * Workspace org — Internal consent can't span orgs, so each workspace
     * needs its own client. */
    get clientIdEng() {
      return process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID_ENG || '';
    },
    get clientSecretEng() {
      return process.env.GOOGLE_CLIENT_SECRET_ENG || '';
    },
    /** 32-byte hex key for AES-256-GCM encryption of stored refresh tokens. */
    get tokenEncKey() {
      return process.env.GOOGLE_TOKEN_ENC_KEY || '';
    },
    /** External origin of this deployment — the OAuth redirect URI is built
     * from it and must exactly match a URI registered on the GCP client. */
    get appBaseUrl() {
      return process.env.APP_BASE_URL || 'https://meetings.darth-internal.trames.io';
    },
  },

  /**
   * Microsoft Graph, app-only (client credentials — no per-user OAuth).
   * The "Darth Meetings" Entra registration holds admin-consented application
   * permissions (Calendars.Read, OnlineMeetings/Recording/Transcript Read.All)
   * scoped tenant-wide by the MeetingWhisperer-Access application access
   * policy. Meetings organized outside this tenant are not reachable.
   */
  microsoft: {
    get tenantId() {
      return process.env.MS_TENANT_ID || '';
    },
    get clientId() {
      return process.env.MS_CLIENT_ID || '';
    },
    get clientSecret() {
      return process.env.MS_CLIENT_SECRET || '';
    },
  },
} as const;
