'use client';

import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Paperclip, Play } from 'lucide-react';

interface NotesMarkdownProps {
  markdown: string;
  /** AssemblyAI id — used to resolve attachment: links. */
  transcriptId: string;
  /** Click handler for [m:ss](t:<ms>) timestamp chips (seconds). */
  onSeek?: (seconds: number) => void;
}

/**
 * Markdown renderer for AI summaries/reports with three custom link
 * protocols the prompts instruct the model to emit:
 *   [m:ss](t:<ms>)          -> click-to-seek player chip
 *   [title](attachment:<id>) -> link to the attachment download
 *   ![caption](.../frames/<ms>.jpg) -> figure with caption, click seeks
 * Everything else renders as ordinary (externally-opening) markdown.
 */
export function NotesMarkdown({ markdown, transcriptId, onSeek }: NotesMarkdownProps) {
  const frameMs = (src: string | undefined): number | null => {
    const m = typeof src === 'string' ? /\/frames\/(\d+)\.jpg$/.exec(src) : null;
    return m ? Number.parseInt(m[1]!, 10) : null;
  };

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      // Default sanitizer strips unknown protocols, which would erase our
      // t:<ms> and attachment:<id> hrefs before the renderers see them.
      urlTransform={(url) =>
        /^(t:\d+|attachment:\d+)$/.test(url) ? url : defaultUrlTransform(url)
      }
      components={{
        a: ({ href, children }) => {
          const h = typeof href === 'string' ? href : '';
          const t = /^t:(\d+)$/.exec(h);
          if (t) {
            const ms = Number.parseInt(t[1]!, 10);
            return (
              <button
                type="button"
                onClick={() => onSeek?.(ms / 1000)}
                title="Jump the player here"
                className="mx-0.5 inline-flex translate-y-[-1px] cursor-pointer items-center gap-0.5 rounded bg-primary/10 px-1 py-px align-middle text-[11px] font-medium leading-4 text-primary hover:bg-primary/20"
              >
                <Play className="h-2.5 w-2.5" />
                {children}
              </button>
            );
          }
          const att = /^attachment:(\d+)$/.exec(h);
          if (att) {
            return (
              <a
                href={`/api/transcripts/${transcriptId}/attachments/${att[1]}/download`}
                target="_blank"
                rel="noreferrer"
                className="mx-0.5 inline-flex items-center gap-1 rounded bg-muted px-1.5 py-px align-middle text-[11px] font-medium leading-4 text-foreground hover:bg-muted/70"
              >
                <Paperclip className="h-2.5 w-2.5" />
                {children}
              </a>
            );
          }
          return (
            <a href={h || undefined} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
              {children}
            </a>
          );
        },
        img: ({ src, alt }) => {
          const ms = frameMs(typeof src === 'string' ? src : undefined);
          return (
            <span className="my-3 block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={typeof src === 'string' ? src : undefined}
                alt={alt ?? ''}
                loading="lazy"
                onClick={ms != null && onSeek ? () => onSeek(ms / 1000) : undefined}
                title={ms != null ? 'Click to jump the player to this moment' : undefined}
                className={`max-h-[360px] w-auto max-w-full rounded-md border ${ms != null && onSeek ? 'cursor-pointer hover:opacity-90' : ''}`}
              />
              {alt && (
                <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">
                  {alt}
                  {ms != null && (
                    <span className="text-muted-foreground/60">
                      {' '}· {Math.floor(ms / 60000)}:{String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}
                    </span>
                  )}
                </span>
              )}
            </span>
          );
        },
        table: ({ children }) => (
          <div className="my-3 overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">{children}</table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border bg-muted/60 px-2 py-1 text-left font-semibold">{children}</th>
        ),
        td: ({ children }) => <td className="border px-2 py-1 align-top">{children}</td>,
        h1: ({ children }) => <h2 className="mt-4 mb-1.5 text-[15px] font-semibold">{children}</h2>,
        h2: ({ children }) => <h2 className="mt-4 mb-1.5 text-[15px] font-semibold">{children}</h2>,
        h3: ({ children }) => <h3 className="mt-3 mb-1 text-sm font-semibold">{children}</h3>,
        p: ({ children }) => <p className="my-2 leading-6">{children}</p>,
        ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
        li: ({ children }) => <li className="leading-6">{children}</li>,
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}
