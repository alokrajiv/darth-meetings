# Labels for Darth Meetings — design (v1 + hooks)

Grounded in: `src/db-ops/transcripts.ts` (listPagedForUser `base` CTE), `src/app/api/transcripts/route.ts` (v2 + legacy listing), `src/components/transcript-table.tsx` (toolbar/`toolbarExtra`/`renderRow`/SeriesBadge slot), `src/app/page.tsx` (no rail today; `<main max-w-[1720px]>`), `src/db-ops/series.ts` + `migrations/020_series.sql` (series are org-global, no ACL — the precedent), `transcript_shares` + `resolveAccess` (owner/edit/read), `transcript_activity` (audit precedent), `cli-subcommand-src/index.ts` (legacy `/api/transcripts` array, `ctx.requireWrite()`), `migrations/` latest = **026** → labels = **027**, rules = **028** (v2). No prior tags/folders notes in `docs/`.

---

## 1. Recommendation

**Hierarchical labels, many-to-many. Not folders.**

- A label has a path (`Customers/LP Global/Weekly catch-up`) so the rail renders as a folder tree and filtering by a node includes its subtree (S3-prefix feel), but a transcript can carry N labels (Gmail). Folders force one home; a "Customers/LP Global" weekly call is also "Topics/Pricing" and "Quarter/2026-Q3". Folders also collide with what already exists: series is already the "one home" object for recurring calls.
- **No primary label in v1.** The only place a primary would matter is a physical folder export; there the CLI exports a transcript under *every* label path it carries (duplicates are cheap files). If ever needed: `transcript_labels.is_primary bool` + a partial unique index — additive, no redesign.
- **Series stays separate.** Series = identity object (evidence keys, auto-import, membership = exactly one). Label = human taxonomy (N per transcript, no machinery). Bridge = a *rule*: "every member of series X gets label Y" (v2 rule kind `series`, §5). Do NOT auto-create a label per series — 100+ series would pollute the taxonomy; the user chooses which series map to which label. Series title chip and label chips coexist on the row.
- **Org-wide labels, one model.** Same as series: anyone can see/use every label; an assignment is visible iff you can see the transcript (the rail count is "visible-to-you"). Why not personal labels too: no users table, 2× UI (two trees, "share this label", promote-to-org), and the failure mode (five people each inventing "LP Global") is exactly what a shared taxonomy prevents in a ~20-person tool. Escape hatch later: add `owner_user_id uuid NULL` (NULL = org) — additive.

---

## 2. Data model (migration 027)

Path storage: **`parent_id` + materialized `path`/`path_key`**, no `ltree` (extension dependency; only `pg_trgm` exists; hundreds of labels at most, `LIKE 'prefix/%'` with `text_pattern_ops` is plenty). Rename/move recompute the subtree in one transaction in `db-ops/labels.ts` (no triggers — keep logic where the repo keeps it).

```sql
-- migrations/027_labels.sql
SET search_path = meeting_whisperer_prod, public;

CREATE TABLE IF NOT EXISTS labels (
  id            serial PRIMARY KEY,
  parent_id     integer REFERENCES labels(id) ON DELETE CASCADE,
  name          text NOT NULL,                 -- display segment, no '/'
  name_key      text NOT NULL,                 -- lower(btrim(name)), app-written
  path          text NOT NULL,                 -- 'Customers/LP Global/Weekly catch-up'
  path_key      text NOT NULL,                 -- lower(path)
  depth         smallint NOT NULL,             -- 1 = top level
  color         text,                          -- '#rrggbb' or null (inherits parent in UI)
  description   text,
  created_by    uuid NOT NULL,
  created_by_email text NOT NULL,
  updated_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (position('/' IN name) = 0),
  CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  CHECK (depth BETWEEN 1 AND 6),
  CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$')
);
-- case-insensitive unique per parent (NULL parent folded to 0)
CREATE UNIQUE INDEX IF NOT EXISTS labels_parent_name_key
  ON labels (COALESCE(parent_id, 0), name_key);
CREATE UNIQUE INDEX IF NOT EXISTS labels_path_key ON labels (path_key);
CREATE INDEX IF NOT EXISTS labels_path_prefix_idx ON labels (path_key text_pattern_ops);

CREATE TABLE IF NOT EXISTS transcript_labels (
  transcript_id integer NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  label_id      integer NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  how           text NOT NULL DEFAULT 'manual' CHECK (how IN ('manual','cli','bulk','rule')),
  rule_id       integer,                       -- v2: label_rules(id), no FK yet
  added_by      uuid NOT NULL,
  added_by_email text NOT NULL,
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (transcript_id, label_id)
);
CREATE INDEX IF NOT EXISTS transcript_labels_label_idx ON transcript_labels (label_id);

-- Taxonomy audit (org-wide renames/moves/deletes are what people argue about).
-- Assignment audit goes through transcript_activity (new actions below).
CREATE TABLE IF NOT EXISTS label_history (
  id        serial PRIMARY KEY,
  label_id  integer,                           -- no FK: survives delete
  action    text NOT NULL CHECK (action IN ('create','rename','move','recolor','delete','merge')),
  before    jsonb,
  after     jsonb,
  by_user   uuid NOT NULL,
  by_email  text NOT NULL,
  at        timestamptz NOT NULL DEFAULT now()
);
```

Code-side rules (`src/lib/labels.ts`, pure, shared client/server, unit-tested):
- `splitPath('a / b//c ')` → `['a','b','c']` (trim segments, drop empties, reject `/`-only), `joinPath`, `normalizeKey` = `lower(trim)`, `validateSegment` (1–60 chars, no `/`, no leading/trailing spaces), max depth 6.
- `resolveOrCreatePath(path, user)` in db-ops: walk segments, `SELECT ... WHERE COALESCE(parent_id,0)=? AND name_key=? FOR SHARE` (the share lock on each parent segment blocks behind an in-flight rename/move of it and keeps a later one out until the child commits — the FK's KEY SHARE alone would not), insert missing; returns leaf + created[] (one txn, `ON CONFLICT (COALESCE(parent_id,0), name_key) DO NOTHING` + re-select for races).
- `renameLabel(id, newName)` / `moveLabel(id, newParentId)` / `deleteLabel`: in one txn, **first `SELECT … WHERE id=$id FOR UPDATE` and work from that post-lock row**, then lock the subtree in a fresh statement (`SELECT ... WHERE path_key = $cur OR path_key LIKE $cur||'/%' FOR UPDATE`), recompute `path/path_key/depth` for all, reject move into own subtree (409), reject depth overflow, write `label_history`. Move locks root + new parent in ascending id order; all mutations retry on PG deadlock 40P01. `PATCH` combines rename→move→meta in one txn (`updateLabel`).
- `transcript_activity.action` gains `'label_add' | 'label_remove'` with `details {label_id, path}` — free audit on the detail page's activity bar.

---

## 3. Permissions

| Action | Who | Notes |
|---|---|---|
| List labels / see tree | any authenticated | counts = transcripts visible to caller |
| Create label (any depth) | any authenticated | inline create from picker included |
| Rename / move / recolor | any authenticated | org taxonomy; `label_history` logs who |
| Delete label | any authenticated | 409 if it has children unless `cascade=true`; UI confirm shows "removes from N meetings, M sub-labels"; assignments cascade via FK |
| Add/remove a label on a transcript | **owner or `edit`** share (mirror `canManageShares`) | `read` → 403; readers still see chips |
| Bulk tag | per-row check, partial success reported | never silently skip |
| CLI mutations | read+write token | `withAuth` already 403s read-only tokens on non-GET |

On delete: assignments vanish (FK cascade), subtree vanishes only with `cascade`. On move: assignments untouched, paths rewritten. On merge (v1.5, `POST /api/labels/:id/merge {into}`): `INSERT ... SELECT ... ON CONFLICT DO NOTHING`, children re-parented under `into`, loser deleted — same shape as `mergeSeries`. Trashed transcripts keep their assignments (restore is lossless); counts/filters exclude `deleted_at IS NOT NULL` like everything else.

---

## 4. Listing UX

```
┌─ AppHeader ───────────────────────────────────────────────── Import ▾  Upload  Import meeting ─┐
│ ┌ Labels ──────────────┐ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ ▾ Customers      (41)│ │ [Imported][Not imported (12)][No recording]  All Mine Shared Trash│ │
│ │   ▾ LP Global    (17)│ │ Customers › LP Global  [incl. sub-labels ▾] ×   ⋯ chips  🔍 /   │ │
│ │       Weekly catch-up│ ├──────────────────────────────────────────────────────────────────┤ │
│ │       QBR         (2)│ │ ☐ Today                                                          │ │
│ │     Maersk       (9) │ │ ☐ ● ▣ LP Global weekly  ↻LP weekly  [LP Global][+1]  1:02  4sp  │ │
│ │ ▸ Topics         (23)│ │ ☐ ● ▣ Pricing sync        [Topics/Pricing]             0:41  3sp │ │
│ │ ▸ Internal       (88)│ │ ☐ Yesterday                                                      │ │
│ │   Unlabelled    (130)│ │ …                                                                │ │
│ │ + New label          │ └──────────────────────────────────────────────────────────────────┘ │
│ └──────────────────────┘   [3 selected]  Add label ▾   Remove label ▾   Clear   (sticky)     │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Left rail** (`label-rail.tsx`, 240px, collapsible; toggle button "Labels" in the toolbar, state in localStorage `mw-label-rail`). Click-only v1 (no drag). Node = chevron + color dot + name + visible count (subtree-inclusive). `⋯` on hover → New sub-label / Rename / Move to… / Color / Delete. Pseudo-nodes: **All** (clears), **Unlabelled** (`label=none`). Rail is rendered by `page.tsx` (flex wrapper around `<TranscriptTable>`), not inside the table — keeps it out of the filter-chips agent's file.
- **Filter**: `?label=<id>` (+`&exact=1`) on the URL, `label` prop into `TranscriptTable` → `?v=2&label=..&exact=..`. Default includes descendants; a small dropdown on the breadcrumb chip flips to "exactly this label". Breadcrumb chip shows the path; each crumb clickable (jumps to ancestor). Counts on tabs respect the label filter (they already respect from/to+q).
- **Row chips** (`label-chips.tsx`): after SeriesBadge, max 2 + `+N` overflow popover; colored dot + leaf name, full path on hover title; click → sets label filter (`stopPropagation`). Hover on row shows ghost `+` (same reveal pattern as SeriesBadge 'row' variant) → LabelPicker. Hidden in trash rows; not shown on `up-`/`defer-` placeholders.
- **Bulk**: checkbox column appears on row hover / when selection non-empty; shift-click ranges; sticky bottom bar "N selected · Add label ▾ · Remove label ▾ · Clear". Rows you can't edit are counted separately ("2 read-only skipped"). Keyboard: `x` toggles focused row, `l` opens picker for selection (Gmail muscle memory), `Esc` clears.
- **LabelPicker** (`label-picker.tsx`, shared by row ghost, bulk bar, detail page): search input (autofocus), filtered flat list rendered as indented tree with checkmarks for current assignments, ↑↓ move, `Enter` toggles, `Esc` closes. When typed text has no exact path match: first row is **`Create "Customers/LP Global/QBR"`** (creates the whole chain). Typing `/` narrows by path segments (`cust/lp` matches). position:fixed popover like SeriesBadge so it escapes the table's overflow.
- **Detail page**: chips + `+ Label` ghost next to SeriesBadge (line ~2318 of `transcript/[id]/page.tsx`), `l` shortcut, readers see chips only. Activity bar shows "added label Customers/LP Global".
- **Calendar layer rows (not-imported / no-recording)**: **v1 = transcripts only.** Calendar rows are a per-user cache keyed `(user_id, event_key)` — labels on them would be personal, non-durable, and need carry-over at import. The right lever is the series rule (§5): recurring meetings are the bulk of pre-labelling demand. v1.5: import endpoints accept `labelIds[]` so the import dialog can offer "Add labels" at import time (one-shot, no calendar-row storage).

---

## 5. Auto-labelling rules (v2 — design only, migration 028 later)

```sql
CREATE TABLE label_rules (
  id          serial PRIMARY KEY,
  label_id    integer NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('series','participant_domain','participant_email','organizer_email','title_regex','provider')),
  value       text NOT NULL,                   -- series id / 'lpglobal.com' / regex / 'teams'
  apply_existing boolean NOT NULL DEFAULT true,
  enabled     boolean NOT NULL DEFAULT true,
  created_by  uuid NOT NULL, created_by_email text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (label_id, kind, value)
);
-- then: ALTER TABLE transcript_labels ADD CONSTRAINT ... FOREIGN KEY (rule_id) REFERENCES label_rules(id) ON DELETE SET NULL;
```
Engine hooks: `post-completion.ts` (`onTranscriptCompleted`) + `series.addMember` + import-core → `applyRules(transcriptId)`; assignments written with `how='rule', rule_id`; deleting a rule offers "also remove its N auto-assignments" (`WHERE rule_id = ?`). First kind to ship: `series` (UI in series-dialog: "Labels for this series"), then `participant_domain` (customer labels from attendee domains in `gmeet_context.attendees`).

---

## 6. CLI (`darth-cli meetings …`, deterministic, no AI)

```
labels                               Tree with counts (--json = flat rows with path)
label <id> <path>                    Add label (creates missing path segments; prints "created …")
unlabel <id> <path>                  Remove label
list --label <path> [--exact]        Filter (default incl. sub-labels)
export --label <path> [--exact] [--out <dir>]
                                     Mirror as folders: <dir>/<label path>/<date> <title> (<id>)/{meta.json,text.txt,notes.md,report.md}
                                     (a transcript under N labels lands N times — by design)
label-create <path> | label-rename <path> <newName> | label-rm <path> [--cascade]
```
`list` keeps the legacy `/api/transcripts` array and just passes `&label=&exact=`; rows print a `{a/b,c}` column when labels present. `label/unlabel/label-*` call `ctx.requireWrite()`. `<path>` is case-insensitive; ids accepted too (`#12`).

---

## 7. API surface

| Method/Path | Body / params | Returns |
|---|---|---|
| `GET /api/labels` | `?counts=1` | `{labels:[{id,parent_id,name,path,path_key,depth,color,description,created_by_email,count_visible,count_direct}], unlabelled, total}` flat, sorted by path_key; client builds tree. `unlabelled`/`total` (visible-to-caller, counts=1 only) feed the rail's pseudo-nodes |
| `POST /api/labels` | `{path}` or `{name,parentId?}`, `color?` | `{label, created:[…]}` (chain creation), 200 if existed |
| `PATCH /api/labels/:id` | `{name?, parentId?: number\|null, color?, description?}` — all steps in one txn (rename→move→meta), a 4xx rolls everything back | `{label, updated:[{id,path}]}` (subtree); 409 cycle/dup/depth |
| `DELETE /api/labels/:id` | `?cascade=1` | `{ok, removedAssignments, removedLabels}`; 409 has children w/o cascade; every dropped assignment gets a `label_remove` activity row (`details.via='label_delete'`) |
| `POST /api/labels/:id/merge` (v1.5) | `{into}` | `{ok}` |
| `GET /api/transcripts/:id/labels` | | `{labels:[{id,name,path,color,how,added_by_email,added_at}], canEdit}` |
| `POST /api/transcripts/:id/labels` | `{labelId}` or `{path}` (creates) | `{labels:[…]}`; 403 read-only |
| `DELETE /api/transcripts/:id/labels/:labelId` | | `{labels:[…]}` |
| `POST /api/labels/bulk` | `{transcriptIds:[aai ids], add:[labelId\|path], remove:[labelId]}` — `add` entries are typed: JSON number = id, string = path (a top-level `'2026'` is a path) | `{applied:n, skipped:[{id,reason}]}` |
| `GET /api/transcripts?v=2&label=<id\|none>&exact=1` | existing params | rows gain `labels:[{id,name,path,color}]`; filter applied in `base` CTE (see below) and in the tab counts. The legacy no-`v` `/api/transcripts` is left byte-identical (no `labels` field, label params ignored) — darth-cli's `list --label` uses v2 |

Listing SQL (in `base`): `AND EXISTS (SELECT 1 FROM transcript_labels tl JOIN labels l ON l.id=tl.label_id WHERE tl.transcript_id=t.id AND (l.id=$id OR (${!exact} AND l.path_key LIKE $pk||'/%')))`; `label=none` → `NOT EXISTS (… tl.transcript_id=t.id)`. Row labels: `LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('id',l.id,'name',l.name,'path',l.path,'color',l.color) ORDER BY l.path_key) …)` on the page rows only (after `page_days` join, same place the series join lives). Rail counts: one query `SELECT l.id, count(DISTINCT t.id)` over visible transcripts joined via `path_key = l.path_key OR LIKE l.path_key||'/%'`. `publishEvent({kind:'labels', assemblyaiId})` on every assignment change so open tabs refresh.

---

## 8. Execution plan — one session, 3 parallel agents

**Step 0 (lead, 15 min, before fan-out):** commit the contract: `src/lib/labels.ts` (pure path utils + types `LabelRow`, `LabelRef`, `TranscriptListRow.labels?: LabelRef[]` added in `src/lib/format.ts`) and this doc's §7 as the API contract. Everyone builds against it.

| Agent | Owns (exclusive) | Deliverables |
|---|---|---|
| **Server** | `migrations/027_labels.sql`, `src/db-ops/labels.ts`, `src/app/api/labels/**`, `src/app/api/transcripts/[id]/labels/**`, **edits in** `src/db-ops/transcripts.ts` (label filter + labels agg in `listPagedForUser` and `listVisibleToUser`), `src/app/api/transcripts/route.ts` (parse `label`/`exact`), `src/db-ops/transcript-activity.ts` (new actions), `src/lib/server/event-bus.ts` comment | migration applied on dev tunnel, all endpoints curl-green |
| **UI** | `src/components/label-rail.tsx`, `label-picker.tsx`, `label-chips.tsx`, `src/app/page.tsx` (flex wrapper + rail + `?label=` URL state), `src/app/transcript/[id]/page.tsx` (chips + `+ Label` + `l` key), **narrow edits in** `src/components/transcript-table.tsx`: new props `labelFilter`/`onLabelFilter`, chips in `renderRow`, checkbox column + bulk bar. ⚠ The filter-chips agent is editing the toolbar area of this file now — UI agent touches only `renderRow` + new props + a new `bulkBar` block, never the toolbar JSX; rebase on their commit before starting, and put the breadcrumb chip inside the rail header, not the toolbar, to avoid merge conflicts. | rail, filter, chips, picker w/ inline create, bulk |
| **CLI** | `cli-subcommand-src/index.ts` (+ HELP/SKILL text) | the 8 verbs in §6, tested against local dev with a dth token |

Order: Server lands migration + `GET/POST /api/labels` + assignment routes first (hour 1) → UI switches from mock to live; listing filter/agg second; CLI can start immediately on `labels`/`label`/`unlabel` and finish `list --label`/`export` once listing params land.

**Test plan**
- **bun test** (`src/lib/__tests__/labels.test.ts`): splitPath/joinPath/normalize edge cases (unicode, double slashes, trailing spaces, depth 7 rejected, `/`-only), subtree path rewrite computation (pure function `rewritePaths(oldPrefix,newPrefix,rows)`), case-insensitive match.
- **curl** (script in scratchpad, against local dev on :3002 over the 5433 tunnel, SSO cookie jar): create chain `A/B/C` (expect 3 created) → re-POST same (0 created, same ids) → POST `a/b/c` (case collision → same) → PATCH rename `B`→`Bee` (C.path updated) → PATCH move `C` under `A` → move `A` under `C` (409) → assign to an owned transcript (200), to a `read`-shared one (403), with read-only dth token (403) → `?v=2&label=A` incl. descendants returns it, `&exact=1` doesn't → `label=none` excludes it → bulk with mixed access → DELETE `A` without cascade (409) → with cascade (assignments gone, `transcript_activity` has label_add/remove rows, `label_history` has rows) → legacy `/api/transcripts` still byte-identical when no `label` param except the additive `labels` key.
- **Playwright** (MCP, cookie-injected per memory recipe): rail shows tree+counts; click node → URL `?label=` + rows filtered + breadcrumb; toggle exact; row hover `+` → picker → type new path → "Create …" → chip appears; select 3 rows → bulk Add label → chips on all 3; detail page `l` → picker; read-only shared transcript shows chips without `+`; reload preserves rail collapsed state.
- **CLI**: `labels`, `label <id> Customers/LP Global`, `list --label customers` (case-insens), `--exact`, `export --label Customers --out /tmp/x` → folder tree exists with `text.txt`, `unlabel`, `label-rm --cascade`.
- **Deploy**: guarded-deploy recipe (memory), apply 027 via psql on VM first, then build; smoke `GET /api/labels` on prod.

Out of v1 (explicit): drag-and-drop, personal labels, calendar-row labels, rules engine (028), merge (v1.5 if time), per-label colors inheritance beyond "null = parent's".
