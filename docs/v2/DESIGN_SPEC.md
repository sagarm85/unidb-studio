# unidb studio v2 — UI Design Specification

**Goal:** Rebuild the Studio UI to the visual quality of the Supabase dashboard
(dark-first, dense, calm, professional) while preserving 100% of existing
functionality and the repo's core rule: **the UI is engine-truthful — never
mock, seed, or invent data** (see `/CLAUDE.md`).

**Stack decision:** v2 is a **rewrite in React** — the same stack family as
Supabase's own dashboard:

- **Vite + React 18+ + TypeScript** (still a pure static SPA — no backend,
  no Next.js; same `.env.local` / `VITE_UNIDB_URL` / `VITE_UNIDB_TOKEN`
  configuration and the same dev-only `/__token` Vite middleware, ported).
- **Tailwind CSS v4** for styling, driven by the CSS-variable tokens in §2.
- **shadcn/ui** (Radix primitives) for buttons, inputs, dialogs, dropdowns,
  tabs, toasts, tooltips — restyled via the tokens, not stock defaults.
- **lucide-react** for icons (16px, 1.5px stroke).
- Charts stay **hand-rolled SVG** ported from `MetricChart.svelte` (it is
  small and engine-truthful); Recharts may be introduced only if a chart
  need exceeds it.

**What is NOT rewritten:** `src/lib/api.js`, `schema.js`, `csv.js`,
`format.js`, `embed.js` are plain framework-agnostic modules — port them
verbatim (optionally with light TS typings) into `src/lib/engine/`. The v1
Svelte components remain on `main` as the **reference implementation** for
behavior: keyset paging, EXPLAIN timing split, batched CSV transactions,
catalog fallback, token lifecycle. v2 must reach behavior parity with them.

---

## 1. Design language at a glance

| Aspect | Direction |
|---|---|
| Mood | Infrastructure tool: dark, dense, quiet. Color is used sparingly and only with meaning. |
| Default theme | Dark (`.theme-dark` on `<html>`). Light theme supported via the same tokens. |
| Accent | Brand green `#3ECF8E` (Supabase-style). A secondary "Claude" warm theme (terracotta `#D97757`) ships as an optional accent variant — one CSS variable swap. |
| Density | Compact. 13px base UI font, 32px control height, 8px spacing grid. |
| Corners | 6px radius on controls/cards, 8px on modals, 4px on badges. |
| Borders | 1px hairline borders everywhere instead of shadows. Shadows only on overlays (modals, dropdowns, toasts). |
| Motion | 120–150ms ease-out on hover/active states; no decorative animation. |
| Labels | Section/stat labels are 11px UPPERCASE, letter-spacing 0.05em, muted color. |

---

## 2. Design tokens (`src/styles/tokens.css` — create this file)

All components consume **only** these variables — via Tailwind utilities
mapped to them (Tailwind v4 `@theme inline` / CSS-first config) and via the
shadcn/ui variable layer. No raw hex values in components. Also map the
shadcn semantic names onto these tokens so shadcn components pick up the
design automatically (`--background: var(--bg-app)`, `--card: var(--bg-panel)`,
`--border: var(--border)`, `--primary: var(--brand)`,
`--primary-foreground: var(--brand-text-on)`,
`--destructive: var(--error)`, `--muted: var(--bg-panel-2)`,
`--muted-foreground: var(--text-light)`, `--accent: var(--bg-hover)`,
`--ring: var(--brand)`, radius `--radius: 6px`, etc.).

```css
/* ================= unidb studio v2 design tokens ================= */
:root {
  /* type */
  --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
             "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas,
               "Liberation Mono", monospace;
  --text-xs: 11px;   /* uppercase micro-labels, badges */
  --text-sm: 12px;   /* secondary text, table meta */
  --text-md: 13px;   /* base UI: nav, buttons, inputs, grids */
  --text-lg: 16px;   /* card titles, section headings */
  --text-xl: 24px;   /* page titles */
  --text-num: 28px;  /* big stat numbers */

  /* spacing (8px grid, 4px half-step) */
  --sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px;  --sp-4: 16px;
  --sp-5: 20px; --sp-6: 24px; --sp-8: 32px;  --sp-10: 40px;

  /* radii */
  --r-sm: 4px; --r-md: 6px; --r-lg: 8px; --r-full: 999px;

  /* layout */
  --h-topbar: 48px;
  --w-nav: 224px;          /* primary left nav (expanded) */
  --w-nav-rail: 56px;      /* collapsed icon rail (optional, ≥ Phase 6) */
  --w-subsidebar: 256px;   /* tables sidebar on data screens */
  --h-control: 32px;       /* buttons, inputs, selects */

  /* z-index */
  --z-nav: 40; --z-dropdown: 50; --z-modal: 60; --z-toast: 70;
}

/* ---------- DARK (default) ---------- */
:root, .theme-dark {
  color-scheme: dark;

  --bg-app: #121212;        /* page background */
  --bg-surface: #171717;    /* topbar, left nav, sidebars */
  --bg-panel: #1c1c1c;      /* cards, panels, table headers */
  --bg-panel-2: #232323;    /* nested surfaces: inputs, code, hover rows */
  --bg-hover: #262626;      /* hover on nav items / rows / buttons */
  --bg-selected: #2a2a2a;   /* active nav item, selected row */
  --bg-overlay: rgba(0, 0, 0, 0.6);  /* modal backdrop */

  --border: #2e2e2e;        /* default hairline */
  --border-strong: #3e3e3e; /* hovered/focused control borders */
  --border-muted: #262626;  /* table row separators */

  --text: #ededed;          /* primary */
  --text-light: #a0a0a0;    /* secondary */
  --text-muted: #6b6b6b;    /* placeholders, disabled, micro-labels */

  --brand: #3ecf8e;           /* accent — see §12 for Claude variant */
  --brand-hover: #34b27b;
  --brand-text-on: #06130c;   /* text on brand-filled buttons */
  --brand-subtle: rgba(62, 207, 142, 0.12); /* tints, active nav bg, chart fills */

  --info: #60a5fa;
  --warn: #f5a623;  --warn-subtle: rgba(245, 166, 35, 0.12);
  --error: #f87171; --error-subtle: rgba(248, 113, 113, 0.12);
  --ok: #3ecf8e;    --ok-subtle: rgba(62, 207, 142, 0.12);

  --chart-line: var(--brand);
  --chart-fill: var(--brand-subtle);
  --chart-grid: #262626;

  --shadow-overlay: 0 8px 30px rgba(0, 0, 0, 0.5);
  --focus-ring: 0 0 0 2px rgba(62, 207, 142, 0.4);
}

/* ---------- LIGHT ---------- */
.theme-light {
  color-scheme: light;

  --bg-app: #fcfcfc;
  --bg-surface: #ffffff;
  --bg-panel: #ffffff;
  --bg-panel-2: #f4f4f5;
  --bg-hover: #f0f0f1;
  --bg-selected: #e9e9ea;
  --bg-overlay: rgba(0, 0, 0, 0.35);

  --border: #e4e4e7;
  --border-strong: #cfcfd4;
  --border-muted: #ededf0;

  --text: #18181b;
  --text-light: #52525b;
  --text-muted: #9b9ba3;

  --brand: #24915f;          /* darkened green for AA contrast on white */
  --brand-hover: #1d7a50;
  --brand-text-on: #ffffff;
  --brand-subtle: rgba(36, 145, 95, 0.10);

  --info: #2563eb;
  --warn: #b45309;  --warn-subtle: rgba(180, 83, 9, 0.10);
  --error: #dc2626; --error-subtle: rgba(220, 38, 38, 0.08);
  --ok: #24915f;    --ok-subtle: rgba(36, 145, 95, 0.10);

  --chart-grid: #ededf0;
  --shadow-overlay: 0 8px 30px rgba(0, 0, 0, 0.12);
  --focus-ring: 0 0 0 2px rgba(36, 145, 95, 0.35);
}
```

Theme switching: default to dark; hold the choice in a React context
(in-memory + `?theme=` URL param is fine — do **not** add a backend call),
applied as a class on `<html>`. A small sun/moon toggle lives in the top
bar (§4).

---

## 3. App shell (replaces current 2-column layout in `App.svelte`)

Three fixed regions — top bar spanning full width, left nav below it, content
area fills the rest. On data screens a second sidebar (tables) sits between
nav and content.

```
┌──────────────────────────────────────────────────────────────────────┐
│ TOP BAR (48px): ⚡ logo · unidb / studio / [branch·PRODUCTION badge] │
│                    …spacer… [Connect] [server url] [token] [🌙] [?]  │
├────────────┬──────────────────────────────────────────────────────────┤
│ LEFT NAV   │  CONTENT AREA (scrolls independently)                    │
│ (224px)    │  ┌────────────┬─────────────────────────────────────┐    │
│            │  │ TABLES     │  page content                       │    │
│ Overview   │  │ SIDEBAR    │  (only data screens show the        │    │
│ ──────     │  │ (256px)    │   tables sidebar)                   │    │
│ Table Ed.  │  └────────────┴─────────────────────────────────────┘    │
│ SQL Editor │                                                          │
│ Schema     │                                                          │
│ ──────     │                                                          │
│ Storage    │                                                          │
│ Events     │                                                          │
│ ──────     │                                                          │
│ Observab.  │                                                          │
│ Logs       │                                                          │
│ Compare    │                                                          │
└────────────┴──────────────────────────────────────────────────────────┘
```

### 3.1 Navigation model (maps 1:1 to existing tabs — no feature moves)

| v2 nav item | Group | v1 reference (behavior source) | Notes |
|---|---|---|---|
| Project Overview | (top) | **NEW** `OverviewPanel.svelte` | See §5. Engine-truthful only. |
| Table Editor | Database | `records` → `RecordBrowser` | Shows tables sidebar |
| SQL Editor | Database | `sql` → `SqlEditor` | Shows tables sidebar |
| Schema | Database | `schema` → `SchemaVisualizer` | Shows tables sidebar |
| CSV Import | Database | `csv` → `CsvUpload` | Shows tables sidebar |
| Storage | Platform | `storage` → `StoragePanel` | |
| Events | Platform | `events` → `EventsPanel` | |
| Observability | Monitor | `observability` → `ObservabilityPanel` | |
| Logs | Monitor | `logs` → `LogsPanel` | |
| Compare | Monitor | `compare` → `ComparePanel` | |

Keep the `?tab=` URL param behavior; add `overview` to `VALID_TABS` and make
it the default tab instead of `sql`.

### 3.2 Left nav item spec

- Row: 32px height, 13px text, 16×16 stroke icon (1.5px stroke,
  `currentColor`) + label, padding `0 var(--sp-3)`, radius `--r-md`,
  margin `1px var(--sp-2)`.
- States: default `--text-light`; hover `--bg-hover` + `--text`;
  active `--bg-selected` + `--text` + icon tinted `--brand`.
- Group headers: 11px uppercase `--text-muted`, padding
  `var(--sp-4) var(--sp-3) var(--sp-1)`. Groups separated by 1px
  `--border-muted` divider with `--sp-3` vertical margin.
- Bottom of nav (pinned): connection block — server URL in `--font-mono`
  `--text-xs`, and the `TokenStatus` chip (§6.8).
- Icons: `lucide-react`, 16×16, 1.5px stroke (`size={16}`,
  `strokeWidth={1.5}`) — consistent everywhere.

### 3.3 Top bar spec

- 48px tall, `--bg-surface`, 1px bottom `--border`. Horizontal padding `--sp-4`.
- Left: green bolt/glyph logo mark (20px, `--brand`) · wordmark
  `unidb` (600 weight) + `studio` (`--text-light`) · `/` separators ·
  a `PRODUCTION`-style badge showing the engine connection state:
  `CONNECTED` (`--ok-subtle` bg, `--ok` text) or `OFFLINE` / `NOT CONFIGURED`
  (`--warn-subtle` / `--warn`) — derived from whether the last `GET /tables`
  succeeded. This replaces nothing; it surfaces real state that already exists.
- Right: theme toggle (icon button), server URL (mono, truncated, `title`
  attr), `TokenStatus` (restyled, §6.8). Icon buttons: 28×28, radius
  `--r-md`, hover `--bg-hover`.

### 3.4 Tables sidebar (rebuild; v1 reference: `TablesSidebar.svelte`)

- 256px, `--bg-surface`, 1px right border.
- Header row: "Tables" 11px uppercase label + count badge + refresh icon
  button + **New table** button (small primary, only when `canDDL`).
- Search input filtering the table list client-side (pure client filter of
  already-fetched names — allowed, not mock data).
- Table row: 28px, mono 12px name, muted column-count on the right; hover
  reveals a `⋯` icon button → opens `TableActions`. Selected row uses
  `--bg-selected` + 2px `--brand` left indicator.
- Loading: 3 skeleton rows (shimmer on `--bg-panel-2`). Error/unsupported:
  keep existing graceful-degradation messages, restyled as §6.9 empty state.

---

## 4. Global component specs

**Buttons** (`height: var(--h-control)`, radius `--r-md`, 13px/500,
padding `0 var(--sp-3)`, gap `--sp-2` when icon+label):
- *Primary:* `--brand` bg, `--brand-text-on` text; hover `--brand-hover`.
- *Secondary (default):* `--bg-panel-2` bg, 1px `--border` (hover
  `--border-strong`), `--text`.
- *Ghost/icon:* transparent, `--text-light`; hover `--bg-hover` + `--text`.
- *Danger:* `--error-subtle` bg, `--error` text, 1px `rgba(error,.35)` border.
- Disabled: 45% opacity, no hover. Focus-visible: `--focus-ring`.
- Small variant: 26px height, 12px text (for toolbars/table headers).

**Inputs / selects / textareas:** `--bg-panel-2` bg (dark) / `--bg-surface`
(light), 1px `--border`, radius `--r-md`, 32px height, 13px text,
placeholder `--text-muted`. Focus: `--border-strong` + `--focus-ring`.
SQL/code inputs use `--font-mono`.

**Cards / panels:** `--bg-panel`, 1px `--border`, radius `--r-lg`. Card
header: `--sp-4` padding, `--text-lg` 500 title, optional right-side actions;
1px bottom border only when body is flush (tables/charts).

**Stat card** (Overview + Observability): uppercase 11px muted label,
`--text-num` value (mono for numerics), optional sub-line 12px
`--text-light`, optional 16px icon in a 32×32 rounded `--bg-panel-2` square.
Missing metric → value is `—` (never a made-up number).

**Data grid** (restyle `ResultsGrid` + `RecordBrowser` grid): header row
`--bg-panel` sticky, 11px uppercase muted column names, 1px bottom
`--border-strong`; body rows 32px, 12px mono values, row separator
`--border-muted`; hover `--bg-panel-2`; selected `--bg-selected`; `NULL`
rendered as italic `--text-muted`. Numeric columns right-aligned. Horizontal
scroll inside the card, not the page.

**Badges:** 4px radius, 11px/600, 2px 8px padding, uppercase. Semantic:
ok/warn/error/info subtle bg + strong text. Neutral: `--bg-panel-2` +
`--text-light` (e.g. row counts, `PK`, type chips).

**Tabs (in-page, e.g. Observability subtabs):** underline style — 32px row,
13px, `--text-light`; active `--text` + 2px `--brand` bottom border.

**Modals** (`TableBuilder`, `TableActions`): centered, max-width 560px,
`--bg-panel`, radius `--r-lg`, `--shadow-overlay`, backdrop `--bg-overlay`.
Header (title + ✕ ghost button) / body / footer (right-aligned buttons,
primary last). Esc closes, focus is trapped. Danger confirmations (DROP
TABLE): red danger button + the table name echoed in mono.

**Toasts:** bottom-right, `--bg-panel` + border + `--shadow-overlay`,
auto-dismiss 4s, semantic left accent bar (2px). Use for DDL success, CSV
import completion, copy-to-clipboard.

**Error display (`ErrorBox`):** `--error-subtle` bg, 1px error-tinted
border, radius `--r-md`; engine `code` in a mono badge + message verbatim.
Never swallow or rewrite engine errors.

**Charts (port `MetricChart.svelte` → `MetricChart.tsx`):** keep the
hand-rolled SVG approach. Line `--chart-line` 1.5px, area fill `--chart-fill`, gridlines
`--chart-grid`, axis labels 11px `--text-muted`. Bars: `--brand` at full
opacity for the latest bucket, 60% for the rest (Supabase-style). Empty →
"Collecting data…" centered 12px muted (existing behavior — keep).

**Token status (`TokenStatus`):** compact chip — dot (`--ok`/`--warn`/
`--error`) + mono countdown + "Generate" ghost button in dev. Same logic,
new skin.

**Empty states:** centered in the panel: 20px muted stroke icon, one 13px
`--text-light` sentence, optional secondary action button. Copy stays
honest: "No tables yet", "Collecting data…", "Not available on this server".

**Skeletons:** `--bg-panel-2` blocks, 1.2s shimmer. Use only where a fetch
is genuinely in flight.

---

## 5. NEW screen: Project Overview (`src/screens/Overview.tsx`)

Supabase-style landing page. **Every value must come from existing live
endpoints already used elsewhere in the app** (`GET /tables`, the catalog,
metrics/observability endpoints in `api.js`, `TokenStatus`). If an endpoint
is unavailable → show `—` / "Not available", never invent.

Layout (max-width 1200px, centered, `--sp-8` padding):
1. Page header: project name `unidb studio` (`--text-xl`), server base URL
   below it in mono 12px with a **Copy** button.
2. Status card row (grid `repeat(auto-fit, minmax(220px, 1fr))`, gap
   `--sp-4`): STATUS (Healthy/Offline from a live `GET /tables` ping) ·
   TABLES (count from catalog) · TOKEN (expiry countdown) · CATALOG
   (`catalog` vs `tables` fallback source — real state that exists today).
3. Metrics section (only if the metrics endpoints `ObservabilityPanel`
   already consumes respond): reuse `MetricChart` for requests/latency with
   the shared `TimeRangePicker`. Otherwise render the section's empty state.
4. Quick-links row: three bordered cards (Table Editor / SQL Editor /
   Schema) with icon + one-line description; click = navigate tab.

---

## 6. Per-screen build notes (port from the named v1 component — behavior parity required)

- **SqlEditor** — toolbar (Run primary + ⌘↵ hint, params toggle, timing
  chips as neutral badges: `round-trip: X ms` / `server exec: Y ms`) above a
  full-width mono editor card; results grid in its own card below with row
  count + elapsed in header. Keep EXPLAIN companion-call logic untouched.
- **RecordBrowser** — header: table name (mono, 15px) + PK/type chips +
  row toolbar (Refresh, Insert row, Open in SQL editor as secondary
  buttons). Grid per §4. Pager: First/Next small secondary buttons +
  "keyset paging on `<col>`" as a neutral badge (real info, keep).
  Inline edit cells get `--focus-ring` and dirty-cell tint `--brand-subtle`.
- **SchemaVisualizer** — canvas card on `--bg-app` with dotted grid
  (`radial-gradient` dots `--border-muted`); table nodes = mini cards
  (header: table name + PK badge; rows: 12px mono column + muted type); FK
  edges `--text-muted` 1px with `--brand` on hover/select. Zoom controls
  bottom-right as icon-button cluster.
- **CsvUpload** — two-step card: drop zone (dashed `--border-strong`,
  brand tint on dragover) → mapping preview grid → Import primary button;
  progress bar `--brand`; result toast with rows/sec (real timing, keep).
- **StoragePanel / EventsPanel / LogsPanel / ObservabilityPanel /
  ComparePanel / QueryPerformancePanel** — same data & subtab logic;
  re-skin with §4 cards, tabs, grids, badges, charts. Logs rows: mono 12px,
  level badge, hover reveal Copy; keep histogram behavior.
- **TimeRangePicker** — compact select-style trigger ("Last 60 minutes" +
  chevron) opening a dropdown card (`--z-dropdown`, `--shadow-overlay`).

---

## 7. Accessibility & quality bars

- Text contrast ≥ 4.5:1 (11px labels ≥ 4.5:1 too — that's why light theme
  darkens the green).
- All interactive elements keyboard-reachable; `:focus-visible` ring
  everywhere; modals trap focus and restore it on close.
- `prefers-reduced-motion: reduce` → disable shimmer/transitions.
- Hit targets ≥ 24×24 even for icon buttons.
- No layout shift when data arrives: reserve heights via skeletons.
- Content column max-width 1400px on wide screens (except grids/canvas
  which may go full-bleed inside their card).
- Minimum supported width 1024px; below that the left nav may collapse to
  the icon rail (`--w-nav-rail`) — optional, Phase 6.

## 8. Hard constraints (do not violate)

1. **Engine-truthful:** no mock/seed/placeholder data anywhere — including
   the new Overview page and empty charts (`/CLAUDE.md` rules apply to v2).
2. **Approved dependencies only:** react, react-dom, tailwindcss,
   shadcn/ui + its Radix/`class-variance-authority`/`clsx` companions,
   lucide-react. Anything beyond that (router, state library, chart or
   table library) requires an explicit reason recorded in
   `docs/v2/CHANGES.md` — default is to not add it (the app is one screen
   switcher; React state + context suffices).
3. **No API changes.** Port `api.js` request/response handling verbatim;
   the REST contract is `unidb/docs/REST_API.md`.
4. **All v1 features must survive:** keyset paging + fallback, EXPLAIN
   timing split, batched CSV transactions, catalog fallback, dev token
   flow, graceful degradation on missing routes, `?tab=` deep links. The
   v1 Svelte components on `main` are the behavior spec — when in doubt,
   read them.
5. TypeScript throughout new code; function components + hooks only;
   shadcn components restyled via the token layer, never stock defaults.

## 9. Definition of "modern" for review

A screen passes when: it uses only tokens (no stray hex), spacing lands on
the 4/8px grid, every interactive element has hover/focus/disabled states,
empty/loading/error states exist and are honest, both themes render
correctly, and a side-by-side with the Supabase dashboard reads as the same
family: hairline borders, muted uppercase labels, one green accent, dense
mono data.

---

## 12. Accent variants (free-hand option)

The whole personality lives in 4 variables. Optional "Claude" warm variant —
expose as a third choice in the theme toggle if trivial, otherwise ship
green only:

```css
.accent-claude {
  --brand: #d97757;           /* terracotta */
  --brand-hover: #c05f3f;
  --brand-text-on: #1a0f0a;
  --brand-subtle: rgba(217, 119, 87, 0.14);
  --focus-ring: 0 0 0 2px rgba(217, 119, 87, 0.4);
}
```

In light mode pair it with warm neutrals (`--bg-app: #faf9f5`,
`--bg-panel-2: #f0eee6`) for the full Claude look.
