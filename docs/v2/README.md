# unidb studio v2 — UI redesign kit

Planning + design documents for rebuilding the Studio UI in the style of the
Supabase dashboard (dark-first, dense, green accent), authored for execution
by an AI coding agent (e.g. in Antigravity IDE) on the `v2` branch.

**Stack:** v2 is a rewrite in **Vite + React + TypeScript + Tailwind v4 +
shadcn/ui** (the same family as Supabase's own dashboard). The engine-facing
modules (`api.js`, `schema.js`, `csv.js`, …) are framework-agnostic and are
ported verbatim; the v1 Svelte components remain the behavior reference
until parity is proven.

| File | Purpose |
|---|---|
| [`DESIGN_SPEC.md`](./DESIGN_SPEC.md) | Stack decision + full design system: tokens (dark/light + optional Claude terracotta accent), app shell, component specs, per-screen notes, a11y bars, hard constraints |
| [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) | 8-phase rewrite plan with per-phase gates, parity checklist (v1 = oracle) and design checklist |
| [`AGENT_PROMPT.md`](./AGENT_PROMPT.md) | Copy-paste kickoff prompt for the agent |

## How to run it

```bash
git clone https://github.com/sagarm85/unidb-studio.git
cd unidb-studio
git checkout v2
```

Open the folder in Antigravity IDE, then paste the prompt from
`AGENT_PROMPT.md` to the agent. It will execute the plan phase by phase,
committing per phase.

## Non-negotiables (summary)

- `/CLAUDE.md` engine-truthful rules apply to every new pixel: no mock data.
- Approved deps only (React, Tailwind, shadcn/ui, lucide) — anything else
  needs a recorded reason.
- All v1 functionality survives, verified against v1 side by side; only
  the stack and the skin change.
