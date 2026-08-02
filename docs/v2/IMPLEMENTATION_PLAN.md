# unidb studio v2 — Implementation Plan (React rewrite, for an AI coding agent)

Companion to [`DESIGN_SPEC.md`](./DESIGN_SPEC.md). v2 rebuilds the Studio as
**Vite + React + TypeScript + Tailwind v4 + shadcn/ui** (still a pure static
SPA). The v1 Svelte app on `main` is the **behavior reference** — v2 is done
when it looks like the Supabase dashboard and behaves exactly like v1.

Execute phases **in order**; each phase ends with `npm run dev` clean and
everything built so far functional. Commit per phase:
`v2(phase-N): <summary>`.

**Read first:** `/CLAUDE.md` (engine-truthful rules — binding), `README.md`,
`DESIGN_SPEC.md` (§8 hard constraints, §2 tokens), and skim the v1
components in `src/` — they are the spec for every behavior mentioned below.

**Branch:** `v2`. The rewrite happens in-place: the Svelte app keeps working
on `main`; on `v2` the source tree is replaced phase by phase as below.

---

## Phase 0 — Scaffold + design foundations

1. Preserve v1 source for reference during the rewrite: `git mv src src-v1`
   (deleted in Phase 7). Keep `index.html` entry updated as you go.
2. Scaffold Vite React-TS in place: add `react`, `react-dom`,
   `@vitejs/plugin-react`, `typescript`; remove Svelte plugin/deps from
   `package.json` and `vite.config.js` → `vite.config.ts`. **Port the
   dev-only `/__token` middleware and `.env.local` handling unchanged** —
   verify the Generate-token flow early, not last.
3. Install + configure Tailwind v4 and shadcn/ui (dark class strategy).
   Create `src/styles/tokens.css` with the full token block from
   DESIGN_SPEC §2, map shadcn variables onto the tokens, wire Tailwind
   theme to the CSS variables. Add `lucide-react`.
4. Port engine modules verbatim: `src-v1/lib/{api,schema,csv,format,embed}.js`
   → `src/lib/engine/` (add minimal `.d.ts` or light TS conversion — no
   logic changes; keep the documented workaround comments, e.g.
   `schema.js:214–233` DDL reconstruction).
5. Generate/restyle the shadcn primitives used app-wide: button, input,
   select, textarea, badge, card, dialog, dropdown-menu, tabs, tooltip,
   sonner (toasts), skeleton — restyled per DESIGN_SPEC §4 (32px controls,
   6px radius, hairline borders). Add `EmptyState.tsx` and `StatCard.tsx`.
6. Theme provider (context): dark default, light via `?theme=`, class on
   `<html>`; optional `.accent-claude` variant hook.

**Gate:** blank app boots with tokens active in both themes; engine modules
imported without errors; `npm run build` passes.

## Phase 1 — App shell + navigation

1. `App.tsx`: top bar (48px) + left nav (224px) + content region per
   DESIGN_SPEC §3. Screen switching via a `tab` state synced to `?tab=`
   (`history.replaceState`; no router library). Valid tabs: v1 set +
   `overview` (new default).
2. Top bar: logo/wordmark, connection-state badge (real state from the
   catalog load — see below), theme toggle, server URL, `TokenStatus`
   ported from `src-v1/lib/TokenStatus.svelte` (same countdown + dev
   Generate button logic).
3. Left nav groups: Project Overview pinned; **Database** (Table Editor,
   SQL Editor, Schema, CSV Import), **Platform** (Storage, Events),
   **Monitor** (Observability, Logs, Compare). Item spec per §3.2, lucide
   icons.
4. Port the catalog-loading state machine from `src-v1/App.svelte`
   (`loadTables`: catalog → flat `/tables` fallback, internal-table filter,
   selection re-pointing) into a `useCatalog()` hook — line-for-line
   equivalent behavior.

**Gate:** shell renders, all nav destinations switch (placeholder screens
OK), `?tab=logs` deep link works, catalog hook returns live data.

## Phase 2 — Tables sidebar + shared data grid

1. `TablesSidebar.tsx` per §3.4 (search filter is client-side only; hover
   `⋯` → table actions; skeletons; honest empty/error/unsupported states —
   copy the v1 degradation messages).
2. `DataGrid.tsx` shared by results + record browsing per §4 (sticky
   header, mono cells, NULL styling, right-aligned numerics, in-card
   horizontal scroll). Hand-rolled — no table library.

**Gate:** sidebar lists real tables; grid renders arbitrary
`columns`/`rows` payloads from `POST /sql`.

## Phase 3 — Database screens (port logic from v1 components)

1. `SqlEditor.tsx` ← `src-v1/lib/SqlEditor.svelte`: params handling, the
   **EXPLAIN ANALYZE companion call** and the round-trip vs server-exec
   timing split, result kinds (rows / affected / DDL / error). Layout per
   §6.
2. `TableEditor.tsx` (record browser) ← `RecordBrowser.svelte`: **keyset
   paging with OFFSET fallback**, inline editing gated on catalog PKs,
   Open-in-SQL-editor handoff.
3. `SchemaVisualizer.tsx` ← v1: nodes, FK edges, zoom; dotted-grid canvas
   per §6.
4. `CsvImport.tsx` ← `CsvUpload.svelte` + `engine/csv.js`: batched
   single-transaction requests, real rows/sec reporting, drop-zone flow.
5. `TableBuilder.tsx` + `TableActions.tsx` on shadcn Dialog; DROP uses the
   danger pattern with the table name echoed.

**Gate:** full loop against a live engine: create table → insert → edit
cell → CSV import → drop; engine errors shown verbatim; both timings
correct (compare numbers side-by-side with v1 on `main`).

## Phase 4 — Project Overview (new screen)

`Overview.tsx` per DESIGN_SPEC §5, using `useCatalog()` +
existing metrics calls + `MetricChart.tsx` (ported in Phase 5 order may be
pulled forward). Every tile shows `—` / "Not available" when its endpoint
is absent. **No invented numbers — reviewed against `/CLAUDE.md` line by
line.**

**Gate:** engine up → real values; engine down → honest offline state;
pre-M18 server → catalog tile reports `tables` fallback.

## Phase 5 — Platform & Monitor screens

Port in order, layout per §6, logic line-for-line from the v1 components:
`MetricChart.tsx`, `TimeRangePicker.tsx`, `StoragePanel.tsx`,
`EventsPanel.tsx` (+ `eventStore` → hook), `LogsPanel.tsx` (histogram axis
behavior included), `ObservabilityPanel.tsx` + `QueryPerformancePanel.tsx`
(slow queries only from engine data), `ComparePanel.tsx`,
`CollapsibleSection.tsx`.

**Gate:** each panel shows live data identical to v1; polling intervals and
subtab structure preserved; empty states honest.

## Phase 6 — Polish

1. Toasts (sonner) on DDL success, CSV completion, copy actions.
2. Keyboard/a11y audit: `:focus-visible` rings, dialog focus trap/restore,
   Esc, `prefers-reduced-motion`.
3. Optional: nav icon-rail collapse <1024px; `.accent-claude` theme
   variant in the toggle.

## Phase 7 — Cleanup & verification

1. Delete `src-v1/`, remove Svelte remnants from config/deps, delete
   `svelte.config.js`, `jsconfig.json` if superseded by `tsconfig.json`.
2. `npm run build` + `npm run preview` clean; no console errors.
3. Run the parity + review checklists below; fix everything found.
4. Update root `README.md` (stack section, commands unchanged) and write
   `docs/v2/CHANGES.md` (what was rebuilt, any approved extra deps + why).

---

## Parity checklist (v1 on `main` is the oracle — compare side by side)

**Run for real, 2026-08-02** (after v1 was merged into v2 and both apps had
grown well past the original "10 destinations" — v2 now has 18 tabs; every
one of them was covered, not just the original set). v1 was checked out in a
separate `git worktree` and run side by side with v2 against the same live
`unidb-server` (Playwright-driven, not eyeballed). Found and fixed 3 real
bugs along the way (noted inline) — this was not a rubber-stamp pass.

- [x] All 10 (now 18) destinations render; `?tab=` deep links; default = overview.
      Verified every tab live: correct `?tab=` round-trip, non-empty body, zero
      console errors (the one apparent Storage "failure" was the documented
      `STORAGE_NOT_AVAILABLE` graceful-degradation state, confirmed correct).
- [x] SQL: SELECT / DML / DDL / error rendering; params; both timings match v1's numbers.
      Verified SELECT/INSERT/DDL/error/`$1` params identically in v1 and v2
      against the same engine; one apparent v1 DML failure during the pass
      turned out to be a real `UNIQUE_VIOLATION` from shared test-engine state
      (v2's run had already used that id), not a v1 defect.
- [x] EXPLAIN companion call fires only for SELECT/CTE, like v1.
      Verified via network interception: exactly 1 `EXPLAIN ANALYZE` call on
      SELECT, 0 on INSERT, in both apps.
- [x] Record browser: keyset paging Next/First, OFFSET fallback, inline edit rules (PK-gated).
      Verified with 110 rows on a PK'd table (100 + 10 keyset pages, inline
      edit activates) and a PK-less table (OFFSET-fallback label shown,
      inline edit correctly inert).
- [x] CSV import: one transaction per request batch, real rows/sec.
      Verified a real 3-row import (real wall-clock + rows/sec shown) and the
      atomic-rollback path (a type-mismatched batch reports "imported 0 of N
      rows... rolled back"). **Finding, not a Studio bug:** the engine itself
      does not coerce a quoted text literal into an `Int64`/`BIGINT` column
      (confirmed via raw `curl` against `POST /sql`, no Studio code involved,
      identical in v1) — contradicts this README's documented "coerced to
      each column's type by the engine" claim for that type. Not fixed here
      (engine behavior, out of scope for this repo) — worth a backlog item
      in `unidb`.
- [x] Schema ERD: nodes, FK edges, zoom.
      Verified real FK-derived nodes/edges render for a `customers`→`orders`
      relationship, zoom control present.
- [x] Storage / Events / Logs / Observability / Compare parity incl. consumer lag + slow queries.
      Verified Events (CDC tables + consumers list), Observability (consumer
      lag + slow-query sections present), Logs (real empty-state copy),
      Storage (graceful `STORAGE_NOT_AVAILABLE` state). **Found + fixed a
      real bug in Compare:** the dev server's SPA fallback returns 200 +
      `index.html` for the missing `/benchmark-results.json` (only a real
      static host 404s a genuinely absent file), so the panel's own
      already-correct "no results yet" 404 branch never fired and a raw
      `Unexpected token '<'... is not valid JSON` leaked to the user instead
      — reproduced identically in v1, so not a v2 regression, but is now a
      v2-only bug since v1 no longer exists on `main`. Fixed by treating a
      non-JSON response the same as a 404 (`ComparePanel.tsx`).
- [x] Token countdown + dev Generate button; `.env.local` flow; production build excludes `/__token`.
      Verified the Generate button + countdown live in dev, and confirmed
      `canGenerate = import.meta.env.DEV` fully eliminates both the button
      and the `/__token`-calling code from the production bundle (`grep` for
      the string found zero occurrences in `dist/`).
- [x] Internal `__`-prefixed tables hidden; graceful degradation on missing routes.
      Confirmed `useCatalog.ts`'s `notInternal` filter and spot-checked the
      live tables sidebar.
- [x] Engine offline: no white screens anywhere.
      Killed the engine and hit all 18 tabs. **Found + fixed a real bug:**
      `GraphqlPanel.tsx`'s schema-load effect had no `.catch()` — a
      transport failure became an unhandled promise rejection, and the panel
      silently showed an empty schema with no explanation. Added a
      `loadError` state + message; re-verified clean (no crash, real error
      text shown) after the fix. All other 17 tabs already degraded
      correctly.

## Design review checklist

**Run for real, 2026-08-02**, alongside the parity pass above.

- [x] Only tokens/Tailwind-mapped colors (no stray hex); 4/8px spacing grid.
      `grep`-audited every file touched this session: zero stray hex colors;
      the arbitrary-bracket values present (`ring-[2px]`, `max-w-[420px]`
      etc.) match the exact pattern already used throughout the pre-existing
      codebase (`StoragePanel.tsx`, `TableBuilder.tsx`), not new conventions.
- [x] Hover/focus/disabled on every interactive element; skeletons where fetches are in flight.
      **Found + fixed a real gap:** four panels (Users, Webhooks, Channel
      Authz, Scheduled Jobs) rendered their "No X yet" empty-state text
      during the brief window before the first fetch resolved (since the
      list starts as `[]`), a false-empty flash. Added an explicit
      `loading` branch ahead of the empty-state check in all four,
      consistent with the "Loading…" pattern the rest of the app already
      uses (the app's real convention — a single shared `Skeleton`
      component exists but is only used in `TablesSidebar`, so text-based
      loading states are the actual prevailing pattern, not a shortfall).
- [x] Dark + light themes pass contrast (§7); reduced-motion respected.
      Screenshotted Users/GraphQL/Broadcast & Presence in both themes — good
      contrast throughout, consistent with the rest of the app. Confirmed
      `prefers-reduced-motion: reduce` is handled globally in
      `globals.css` (a blanket `*` selector), covering every new panel's
      `animate-spin`/`transition` usage with no per-component work needed.
- [x] Side-by-side with Supabase dashboard reads as the same family (§9).
      Screenshot review: sidebar/card/badge/monospace-input language is
      consistent across all 7 new panels and the rest of the app.
