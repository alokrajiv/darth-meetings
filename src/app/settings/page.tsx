'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';
import { AppHeader } from '@/components/app-header';
import { VocabEditor } from '@/components/vocab-editor';
import type { VocabPayload } from '@/lib/format';

interface OrgVocabMeta {
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userVocab, setUserVocab] = useState<VocabPayload | null>(null);
  const [orgVocab, setOrgVocab] = useState<VocabPayload | null>(null);
  const [orgMeta, setOrgMeta] = useState<OrgVocabMeta | null>(null);

  const load = async () => {
    try {
      setLoading(true);
      setError(null);
      const [userRes, orgRes] = await Promise.all([
        fetch('/api/vocab/user'),
        fetch('/api/vocab/org'),
      ]);
      if (!userRes.ok) throw new Error(`user vocab ${userRes.status}`);
      if (!orgRes.ok) throw new Error(`org vocab ${orgRes.status}`);
      const userJson = (await userRes.json()) as { vocab: VocabPayload };
      const orgJson = (await orgRes.json()) as {
        vocab: VocabPayload;
        version: number;
        updated_at: string | null;
        updated_by: string | null;
      };
      setUserVocab(userJson.vocab);
      setOrgVocab(orgJson.vocab);
      setOrgMeta({
        version: orgJson.version,
        updated_at: orgJson.updated_at,
        updated_by: orgJson.updated_by,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const saveUser = async (payload: VocabPayload) => {
    const res = await fetch('/api/vocab/user', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vocab: payload }),
    });
    if (!res.ok) throw new Error(`user save ${res.status}`);
    const { vocab } = (await res.json()) as { vocab: VocabPayload };
    setUserVocab(vocab);
  };

  const saveOrg = async (payload: VocabPayload) => {
    const res = await fetch('/api/vocab/org', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vocab: payload }),
    });
    if (!res.ok) throw new Error(`org save ${res.status}`);
    const json = (await res.json()) as {
      vocab: VocabPayload;
      version: number;
      updated_at: string | null;
      updated_by: string | null;
    };
    setOrgVocab(json.vocab);
    setOrgMeta({
      version: json.version,
      updated_at: json.updated_at,
      updated_by: json.updated_by,
    });
  };

  return (
    <div className="min-h-screen">
      <AppHeader breadcrumb={{ title: 'Settings' }}>
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={load} title="Refresh">
          <RefreshCw className="h-4 w-4" />
          <span className="sr-only">Refresh</span>
        </Button>
      </AppHeader>
      <main className="mx-auto max-w-4xl px-6 py-6">
      <div className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight leading-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Key terms and custom spellings — applied at transcription time.
        </p>
      </div>

      {loading && (
        <Card>
          <CardHeader>
            <CardTitle>Loading...</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          </CardContent>
        </Card>
      )}

      {error && (
        <Card>
          <CardHeader>
            <CardTitle>Error</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-red-500 mb-4">{error}</p>
            <Button onClick={load} variant="outline">
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {!loading && !error && userVocab && orgVocab && (
        <div className="space-y-6">
          <VocabEditor
            title="Your vocabulary"
            description="Personal word boost and spellings — only applied to transcripts you upload."
            initial={userVocab}
            onSave={saveUser}
          />
          <VocabEditor
            title="Company vocabulary"
            description="Shared across everyone using Darth Meetings. Anyone can edit; every save is versioned in the database."
            initial={orgVocab}
            onSave={saveOrg}
            meta={
              orgMeta && (
                <p className="text-xs text-muted-foreground mt-1">
                  Version {orgMeta.version}
                  {orgMeta.updated_at && ` · updated ${new Date(orgMeta.updated_at).toLocaleString()}`}
                  {orgMeta.updated_by && ` · by ${orgMeta.updated_by.slice(0, 8)}…`}
                </p>
              )
            }
          />
        </div>
      )}
      </main>
    </div>
  );
}
