import 'server-only';
import { config } from '@/config';
import type { GraphRecording, GraphTranscript } from '@/lib/teams-link';

/**
 * Microsoft Graph client — app-only (client credentials), no per-user OAuth.
 *
 * The "Darth Meetings" Entra registration holds admin-consented application
 * permissions scoped tenant-wide by the MeetingWhisperer-Access access
 * policy; artifacts are fetched under the ORGANIZER's user path (the Oid
 * embedded in every join link — see `@/lib/teams-link`).
 *
 * Failure taxonomy worth knowing at call sites
 * (docs/teams-integration-spec.md §4.6):
 * - 403 `GraphAccessToTranscriptsDisabled` → the tenant transcript gate
 *   (`Set-CsTeamsMeetingConfiguration -EnableGraphTranscriptAccess`)
 *   regressed — config problem, not a user error.
 * - empty resolution for an own-tenant URL → meeting deleted or URL
 *   malformed; treat as "no artifacts".
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';
const TOKEN_URL = (tenant: string) =>
  `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

export class GraphApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = 'GraphApiError';
  }
}

/** Non-throwing probe — mirrors google-oauth's isClientConfigured. */
export function isGraphConfigured(): boolean {
  const m = config.microsoft;
  return Boolean(m.tenantId && m.clientId && m.clientSecret);
}

// Single tenant → a single cached app token (~1 h expiry), refreshed when
// under 2 min left. Never persisted.
let appToken: { token: string; expiresAt: number } | null = null;

export async function getAppToken(): Promise<string> {
  if (appToken && appToken.expiresAt - Date.now() > 120_000) return appToken.token;
  const { tenantId, clientId, clientSecret } = config.microsoft;
  if (!tenantId || !clientId || !clientSecret) {
    throw new GraphApiError(
      500,
      'Microsoft Graph is not configured (MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET)'
    );
  }
  const res = await fetch(TOKEN_URL(tenantId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GraphApiError(res.status, `Graph token mint ${res.status}: ${body.slice(0, 300)}`);
  }
  const j = (await res.json()) as { access_token: string; expires_in: number };
  appToken = { token: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
  return appToken.token;
}

async function graphFetch(url: string, retried = false): Promise<Response> {
  const token = await getAppToken();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 && !retried) {
    appToken = null;
    return graphFetch(url, true);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let code: string | undefined;
    try {
      code = (JSON.parse(body) as { error?: { code?: string } }).error?.code;
    } catch {
      // non-JSON error body — status alone will have to do
    }
    throw new GraphApiError(res.status, `Graph ${res.status}: ${body.slice(0, 300)}`, code);
  }
  return res;
}

async function graphList<T>(url: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = url;
  while (next) {
    const res = await graphFetch(next);
    const j = (await res.json()) as { value?: T[]; '@odata.nextLink'?: string };
    out.push(...(j.value ?? []));
    next = j['@odata.nextLink'];
  }
  return out;
}

export interface GraphOnlineMeeting {
  id: string;
  subject?: string;
  /** Numeric string, e.g. "48820278136147" — the cache event_key component. */
  meetingCode?: string;
  meetingType?: string;
  /** For a recurring series these are the FIRST occurrence's times — pick a
   * specific occurrence's artifacts by time window, never from these. */
  startDateTime?: string;
  endDateTime?: string;
  joinWebUrl?: string;
  recordAutomatically?: boolean;
  allowTranscription?: boolean;
}

/**
 * Resolve an onlineMeeting by its CANONICAL join URL under the organizer's
 * user path. One recurring series = one meeting object. Returns null when
 * nothing matches (deleted meeting / malformed URL).
 */
export async function resolveMeetingByJoinUrl(
  oid: string,
  joinWebUrl: string
): Promise<GraphOnlineMeeting | null> {
  const url =
    `${GRAPH}/users/${encodeURIComponent(oid)}/onlineMeetings` +
    `?$filter=${encodeURIComponent(`JoinWebUrl eq '${joinWebUrl}'`)}`;
  const list = await graphList<GraphOnlineMeeting>(url);
  return list[0] ?? null;
}

export async function listTranscripts(oid: string, meetingId: string): Promise<GraphTranscript[]> {
  return graphList<GraphTranscript>(
    `${GRAPH}/users/${encodeURIComponent(oid)}/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`
  );
}

export async function listRecordings(oid: string, meetingId: string): Promise<GraphRecording[]> {
  return graphList<GraphRecording>(
    `${GRAPH}/users/${encodeURIComponent(oid)}/onlineMeetings/${encodeURIComponent(meetingId)}/recordings`
  );
}

/** WebVTT with `<v Speaker Name>` cues (attribution works retroactively). */
export async function fetchTranscriptVtt(
  oid: string,
  meetingId: string,
  transcriptId: string
): Promise<string> {
  const res = await graphFetch(
    `${GRAPH}/users/${encodeURIComponent(oid)}/onlineMeetings/${encodeURIComponent(meetingId)}` +
      `/transcripts/${encodeURIComponent(transcriptId)}/content?$format=text/vtt`
  );
  return await res.text();
}

/** MP4 bytes — the response body streams; caller pipes it to a temp file.
 * (Graph honors Range here, but a full-body stream is what ingestion needs.) */
export async function getRecordingStream(
  oid: string,
  meetingId: string,
  recordingId: string
): Promise<Response> {
  return graphFetch(
    `${GRAPH}/users/${encodeURIComponent(oid)}/onlineMeetings/${encodeURIComponent(meetingId)}` +
      `/recordings/${encodeURIComponent(recordingId)}/content`
  );
}
