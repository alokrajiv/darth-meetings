import Link from 'next/link';
import { CloudOff } from 'lucide-react';

/**
 * Static fallback the service worker serves when a navigation fails and no
 * cached copy of that page exists (public/sw.js). Kept dependency-free:
 * no auth calls, no client data fetches, so the cached copy renders the
 * same whether the server is reachable or not.
 */
export const dynamic = 'force-static';

export const metadata = { title: 'Not saved for offline use' };

export default function OfflinePage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="max-w-md text-center">
        <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-muted">
          <CloudOff className="h-6 w-6 text-muted-foreground" />
        </span>
        <h1 className="text-lg font-semibold tracking-tight">This page isn’t saved for offline use</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You’re offline and this page wasn’t kept on this device. Meetings you saved are still
          available from the archive; everything else needs a connection.
        </p>
        <Link
          href="/"
          className="mt-5 inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
        >
          Go to saved meetings
        </Link>
        <p className="mt-4 text-xs text-muted-foreground">
          Choose which meetings to keep offline under Settings › Offline.
        </p>
      </div>
    </div>
  );
}
