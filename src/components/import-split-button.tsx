'use client';

import { ChevronDown, FileAudio, FileText, Video } from 'lucide-react';
import { usePopover } from '@/hooks/use-popover';
import { IMPORT_LABELS, IMPORT_MENU, IMPORT_PRIMARY, type ImportAction } from '@/lib/listing-layout';

/**
 * The header's ONE import control (README "Darth desktop shell" → Layout
 * rules): a split button whose primary half is "Import meeting" and whose
 * chevron opens "Import from…" (a transcript file — Teams, Zoom, VTT) and
 * "Upload media". Replaces the old Import ▾ · Upload media · Import meeting
 * trio. Below `sm` the primary half drops its label (icon + tooltip).
 */

const HINTS: Record<ImportAction, string> = {
  'import-meeting': 'From your Google / Microsoft calendar',
  'import-file': 'A transcript file — Teams, Zoom, VTT…',
  'upload-media': 'An audio or video file',
};

export function ImportSplitButton({
  onAction,
  defaultOpen = false,
}: {
  onAction: (action: ImportAction) => void;
  /** Tests render the menu open. */
  defaultOpen?: boolean;
}) {
  const { open, toggle, close, ref } = usePopover(defaultOpen);
  const half =
    'inline-flex h-8 items-center bg-primary text-primary-foreground text-sm font-medium transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50';
  return (
    <div className="relative" ref={ref} data-import-split>
      <div className="flex items-stretch">
        <button
          type="button"
          title={HINTS[IMPORT_PRIMARY]}
          data-import-primary
          onClick={() => onAction(IMPORT_PRIMARY)}
          className={`${half} gap-1.5 rounded-l-md px-3`}
        >
          <Video className="h-4 w-4" />
          <span className="hidden sm:inline">{IMPORT_LABELS[IMPORT_PRIMARY]}</span>
          <span className="sr-only sm:hidden">{IMPORT_LABELS[IMPORT_PRIMARY]}</span>
        </button>
        <button
          type="button"
          title="More ways to import"
          aria-label="More ways to import"
          aria-expanded={open}
          aria-haspopup="menu"
          data-import-more
          onClick={toggle}
          className={`${half} rounded-r-md border-l border-primary-foreground/25 px-1.5`}
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1.5 w-64 rounded-lg border bg-popover p-1 text-popover-foreground shadow-[0_4px_16px_-2px_rgb(0_0_0/0.08),0_1px_2px_0_rgb(0_0_0/0.04)]"
        >
          {IMPORT_MENU.map((a) => (
            <button
              key={a}
              type="button"
              role="menuitem"
              data-import-item={a}
              className="flex w-full items-start gap-2.5 rounded-md px-3 py-2 text-left hover:bg-muted"
              onClick={() => {
                close();
                onAction(a);
              }}
            >
              {a === 'import-file' ? (
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <FileAudio className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0">
                <span className="block text-sm font-medium">{IMPORT_LABELS[a]}</span>
                <span className="block text-[11px] text-muted-foreground">{HINTS[a]}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
