'use client';

import { useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Loader2, RotateCcw, Send, Sparkles } from 'lucide-react';

interface ChatMsg {
  role: 'user' | 'assistant';
  text: string;
  costUsd?: number | null;
  durationMs?: number | null;
}

/**
 * "Ask AI" — conversational search over the archive. Each thread is a
 * headless Claude session server-side (claude -p --resume), so follow-ups
 * keep full context; answers cite meetings as /transcript/<id> links.
 */
export function AskAiPanel({ onClose }: { onClose?: () => void }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const ask = async () => {
    const q = input.trim();
    if (!q || busy) return;
    setInput('');
    setError(null);
    setBusy(true);
    setMessages((prev) => [...prev, { role: 'user', text: q }]);
    setTimeout(() => scrollRef.current?.scrollTo({ top: 1e9 }), 50);
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, sessionId: sessionRef.current ?? undefined }),
      });
      const data = (await res.json()) as {
        answer?: string;
        sessionId?: string | null;
        costUsd?: number | null;
        durationMs?: number | null;
        error?: string;
      };
      if (!res.ok || !data.answer) throw new Error(data.error || `Failed (${res.status})`);
      if (data.sessionId) sessionRef.current = data.sessionId;
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: data.answer!,
          costUsd: data.costUsd,
          durationMs: data.durationMs,
        },
      ]);
      setTimeout(() => scrollRef.current?.scrollTo({ top: 1e9, behavior: 'smooth' }), 50);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ask failed');
    } finally {
      setBusy(false);
    }
  };

  const resetThread = () => {
    sessionRef.current = null;
    setMessages([]);
    setError(null);
  };

  return (
    <Card className="border-primary/25">
      <CardContent className="p-3">
        <div className="mb-2 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="text-[13px] font-semibold">Ask AI about your meetings</span>
          <span className="text-[11px] text-muted-foreground">
            follow-ups keep context · answers link the transcripts
          </span>
          <span className="ml-auto flex items-center gap-1">
            {messages.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px]"
                onClick={resetThread}
                title="Start a fresh thread"
              >
                <RotateCcw className="h-3 w-3" />
                New thread
              </Button>
            )}
            {onClose && (
              <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={onClose}>
                Close
              </Button>
            )}
          </span>
        </div>

        {messages.length > 0 && (
          <div ref={scrollRef} className="mb-2 max-h-[45vh] space-y-2.5 overflow-y-auto pr-1">
            {messages.map((m, i) =>
              m.role === 'user' ? (
                <p key={i} className="ml-auto w-fit max-w-[85%] rounded-lg bg-primary/10 px-3 py-1.5 text-sm">
                  {m.text}
                </p>
              ) : (
                <div key={i} className="max-w-[92%] rounded-lg border bg-muted/40 px-3 py-2">
                  <div className="markdown-body text-sm [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        p: ({ children }) => <p className="my-1 leading-6">{children}</p>,
                        ul: ({ children }) => <ul className="my-1 list-disc space-y-0.5 pl-5">{children}</ul>,
                        ol: ({ children }) => <ol className="my-1 list-decimal space-y-0.5 pl-5">{children}</ol>,
                      }}
                    >
                      {m.text}
                    </ReactMarkdown>
                  </div>
                  {(m.costUsd != null || m.durationMs != null) && (
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {m.durationMs != null && `${Math.round(m.durationMs / 1000)}s`}
                      {m.costUsd != null && ` · $${Number(m.costUsd).toFixed(2)}`}
                    </p>
                  )}
                </div>
              )
            )}
            {busy && (
              <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Reading your meetings…
              </div>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void ask();
            }}
            placeholder={
              messages.length === 0
                ? 'e.g. What did we decide about the SAP integration scope?'
                : 'Ask a follow-up…'
            }
            disabled={busy}
            className="h-9 text-sm"
          />
          <Button size="sm" className="h-9" onClick={() => void ask()} disabled={busy || !input.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
        {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
