/**
 * Database schema and table constants.
 *
 * meeting-whisperer uses a single schema whose name is built from SCHEMA_PREFIX,
 * following the same pattern as sister Trames apps. All app tables live under it.
 */

function getSchemaPrefix(): string {
  return process.env.SCHEMA_PREFIX || 'prod';
}

export const SCHEMAS = {
  MEETING_WHISPERER: `meeting_whisperer_${getSchemaPrefix()}`,
} as const;

export const TABLES = {
  TRANSCRIPTS: `${SCHEMAS.MEETING_WHISPERER}.transcripts`,
  SPEAKER_MAPPINGS: `${SCHEMAS.MEETING_WHISPERER}.speaker_mappings`,
  TRANSCRIPT_EDITS: `${SCHEMAS.MEETING_WHISPERER}.transcript_edits`,
  TRANSCRIPT_SHARES: `${SCHEMAS.MEETING_WHISPERER}.transcript_shares`,
  USER_VOCAB: `${SCHEMAS.MEETING_WHISPERER}.user_vocab`,
  ORG_VOCAB: `${SCHEMAS.MEETING_WHISPERER}.org_vocab`,
  ORG_VOCAB_HISTORY: `${SCHEMAS.MEETING_WHISPERER}.org_vocab_history`,
} as const;

export const DB_POOL_CONFIG = {
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
} as const;
