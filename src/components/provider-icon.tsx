/**
 * Conferencing-provider glyphs — simplified brand shapes, visually distinct
 * at a glance in the same list (spec §10.1: never a generic "video call"
 * icon). Muted variants mark external-tenant Teams rows the app can't pull
 * automatically.
 */

export function MeetLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-label="Google Meet" role="img">
      <rect x="2" y="5.5" width="13.5" height="13" rx="2.5" fill="#00AC47" />
      <path d="M15.5 10.6 21 6.8v10.4l-5.5-3.8z" fill="#00832D" />
      <circle cx="8.75" cy="12" r="2.6" fill="#E8F5E9" />
    </svg>
  );
}

export function TeamsLogo({ className, muted = false }: { className?: string; muted?: boolean }) {
  const tile = muted ? '#9AA0A6' : '#5059C9';
  const side = muted ? '#B9BEC4' : '#7B83EB';
  return (
    <svg viewBox="0 0 24 24" className={className} aria-label="Microsoft Teams" role="img">
      <circle cx="18.4" cy="8.4" r="2.4" fill={side} />
      <path d="M14.8 12h6.1c.6 0 1.1.5 1.1 1.1v3.4c0 2.1-1.7 3.9-3.9 3.9-1.4 0-2.7-.8-3.3-2v-6.4z" fill={side} />
      <rect x="2" y="4.5" width="13" height="15" rx="2.2" fill={tile} />
      <rect x="5" y="8.4" width="7" height="1.9" rx="0.4" fill="#fff" />
      <rect x="7.55" y="8.4" width="1.9" height="7.2" rx="0.4" fill="#fff" />
    </svg>
  );
}
