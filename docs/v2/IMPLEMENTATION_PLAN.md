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

- [ ] All 10 destinations render; `?tab=` deep links; default = overview
- [ ] SQL: SELECT / DML / DDL / error rendering; params; both timings match v1's numbers
- [ ] EXPLAIN companion call fires only for SELECT/CTE, like v1
- [ ] Record browser: keyset paging Next/First, OFFSET fallback, inline edit rules (PK-gated)
- [ ] CSV import: one transaction per request batch, real rows/sec
- [ ] Schema ERD: nodes, FK edges, zoom
- [ ] Storage / Events / Logs / Observability / Compare parity incl. consumer lag + slow queries
- [ ] Token countdown + dev Generate button; `.env.local` flow; production build excludes `/__token`
- [ ] Internal `__`-prefixed tables hidden; graceful degradation on missing routes
- [ ] Engine offline: no white screens anywhere

## Design review checklist

- [ ] Only tokens/Tailwind-mapped colors (no stray hex); 4/8px spacing grid
- [ ] Hover/focus/disabled on every interactive element; skeletons where fetches are in flight
- [ ] Dark + light themes pass contrast (§7); reduced-motion respected
- [ ] Side-by-side with Supabase dashboard reads as the same family (§9)
