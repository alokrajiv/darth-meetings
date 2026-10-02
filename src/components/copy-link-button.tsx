'use client';

import { useEffect, useRef, useState } from 'react';
import { LinkIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { showToast } from '@/components/toast';
import { copyText, isCopyLinkShortcut } from '@/lib/meeting-link';

/** Copy `link` (or the link a pending lookup yields) and say so in a toast. */
export async function copyLinkWithToast(link: string | Promise<string>): Promise<boolean> {
  const ok = await copyText(link);
  showToast(ok ? 'Link copied' : "Couldn't copy the link");
  return ok;
}

/** ⌘⇧C / Ctrl+Shift+C → `getLink()` copied with a toast, while mounted. */
export function useCopyLinkShortcut(getLink: (() => string | Promise<string>) | null): void {
  const latest = useRef(getLink);
  useEffect(() => {
    latest.current = getLink;
  });
  const enabled = getLink !== null;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isCopyLinkShortcut(e) || e.defaultPrevented) return;
      const get = latest.current;
      if (!get) return;
      e.preventDefault();
      void copyLinkWithToast(get());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/** '⌘⇧C' on Apple platforms, else 'Ctrl+Shift+C' — decided after mount so
 * the server render and the first client render agree. */
function useShortcutLabel(): string {
  const [mac, setMac] = useState(false);
  useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
  }, []);
  return mac ? '⌘⇧C' : 'Ctrl+Shift+C';
}

/**
 * The header's "Copy link" button — inside the Darth desktop shell there is
 * no URL bar, so this is how a meeting's link leaves the app. Icon-only below
 * md, "Copy link" beside the icon from md up.
 */
export function CopyLinkButton({
  getLink,
  label = 'Copy link',
  what = 'this meeting',
}: {
  getLink: () => string | Promise<string>;
  label?: string;
  what?: string;
}) {
  const shortcut = useShortcutLabel();
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void copyLinkWithToast(getLink())}
      title={`Copy a link to ${what} (${shortcut})`}
      aria-label={label}
      aria-keyshortcuts="Meta+Shift+C Control+Shift+C"
      data-copy-link
    >
      <LinkIcon className="h-4 w-4" />
      <span className="hidden md:inline">{label}</span>
    </Button>
  );
}
