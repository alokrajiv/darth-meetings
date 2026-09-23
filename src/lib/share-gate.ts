/**
 * Only meetings are shareable (docs/recordings-meetings-series-design.md
 * rule 1, invariant I5, step P5). A temporary upload (migration 042
 * `scratch`) is a recording with an expiry, not a meeting, so it takes no
 * NEW share: `POST /api/transcripts/:id/shares` answers 409 and the
 * transcript page hides Share. Shares a temporary row already has are
 * grandfathered (Q7) — they keep working and can still be changed or
 * removed. Pure: used by the route and the page alike.
 */
export function sharingRefusal(row: { scratch?: boolean | null }): string | null {
  if (row.scratch) {
    return 'A temporary recording cannot be shared — only meetings can. Link it to a meeting or make a meeting of it first.';
  }
  return null;
}
