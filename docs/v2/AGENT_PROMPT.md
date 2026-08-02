# Prompt for the Antigravity IDE agent

Copy-paste the block below as your first message to the agent after opening
the repo on the `v2` branch.

---

You are rebuilding the UI of **unidb studio**, currently a Vite + Svelte 5
static SPA that fronts the unidb database engine over REST. v2 is a
**rewrite in Vite + React + TypeScript + Tailwind v4 + shadcn/ui** to the
visual quality of the Supabase dashboard (dark-first, dense, hairline
borders, one green accent, uppercase micro-labels, mono data). The existing
Svelte app is the behavior reference — the rewrite must reach exact
behavior parity with it.

Authoritative documents, in priority order:

1. `/CLAUDE.md` — engine-truthful rules. Absolute: never mock, seed, or
   invent data anywhere, including the new Overview page, charts, and
   empty states.
2. `docs/v2/DESIGN_SPEC.md` — stack decision, design tokens, app shell,
   component specs, per-screen notes, accessibility bars, hard
   constraints (§8).
3. `docs/v2/IMPLEMENTATION_PLAN.md` — phased execution order with gates,
   plus the parity and design checklists.

Rules of engagement:

- Work through the plan phase by phase, in order. After each phase,
  `npm run dev` must run clean with everything built so far functional;
  commit as `v2(phase-N): <summary>`.
- Phase 0 moves the Svelte source to `src-v1/` — keep it until Phase 7 and
  read it whenever a behavior is in question. Port
  `src-v1/lib/{api,schema,csv,format,embed}.js` verbatim into
  `src/lib/engine/` — no logic changes.
- Styling comes ONLY from the token layer in `src/styles/tokens.css`
  (create exactly per DESIGN_SPEC §2) through Tailwind and the shadcn
  variable mapping. No raw hex in components. Restyle shadcn components to
  the spec — stock shadcn look is not the target.
- Approved dependencies only: react, react-dom, tailwindcss, shadcn/ui +
  Radix companions, lucide-react. No router, no state library, no chart or
  table library without recording a reason in `docs/v2/CHANGES.md`.
- Behaviors that must survive exactly: keyset paging with OFFSET fallback,
  the EXPLAIN-ANALYZE round-trip vs server-exec timing split, batched
  single-transaction CSV import, catalog → `/tables` fallback, dev-token
  flow incl. the `/__token` Vite middleware (dev-only), `?tab=` deep
  links, graceful degradation on missing routes.
- Finish by running both checklists at the bottom of
  IMPLEMENTATION_PLAN.md, comparing against v1 on `main` side by side, and
  fixing everything found.

Start with Phase 0 now. Show me `package.json`, `src/styles/tokens.css`,
and the restyled shadcn button/input/card before moving to Phase 1.

---

## Tips

- If the agent supports a "plan/spec" mode, feed it `DESIGN_SPEC.md` there
  and keep `IMPLEMENTATION_PLAN.md` as the task list.
- Review after Phases 1, 3, and 4 — the shell, the database screens, and
  the new Overview page are where drift (visual or behavioral) is most
  likely. For Phase 3, run v1 (`git worktree add ../v1 main` + `npm run
  dev` there) and compare timings and paging side by side.
- To try the warm "Claude" terracotta accent, ask for DESIGN_SPEC §12
  after Phase 6.
