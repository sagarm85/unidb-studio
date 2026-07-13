# ~~Proposed API: `GET /schema`~~ — SUPERSEDED

> **Status: superseded (2026-07-13).** This document originally proposed a
> dedicated `GET /schema` REST endpoint on `unidb-server` to feed the studio's
> schema visualizer.
>
> That approach was **retired** after an architecture review: adding
> application-shaped REST resources (`/schema`, `/relationships`, …) to the engine
> is the engine doing the *application's* job — the PostgREST/Supabase pattern the
> engine deliberately avoids. Instead, the engine should expose a **generic,
> SQL-queryable `information_schema`-style catalog** (tables, columns, primary
> keys, foreign keys, indexes, object DDL), and each application builds its own
> access layer on top.
>
> **The contract now lives in the engine repo** as a backlog milestone:
> `../unidb/docs/backlog/18_engine_access_contract.md`
> (Milestone 18 — "Engine access & introspection contract"). See Epic C for the
> catalog relations and the worked introspection queries that will drive this
> studio's ERD.

## What the studio does today (until Milestone 18 lands)

The schema visualizer degrades gracefully in three tiers (see
`src/lib/api.js` → `getSchema()` and `src/lib/schema.js`):

1. **`server`** — if a `/schema`-style payload is ever available, use it as-is.
2. **`inferred`** — fall back to `GET /tables` and infer foreign keys from
   column-name conventions (`user_id → users.id`); drawn as dashed edges with an
   amber banner.
3. **`demo`** — no tables at all → a built-in sample schema so the canvas is
   never blank.

Once the engine exposes the Milestone 18 catalog, the studio queries it over
`POST /sql` (e.g. `SELECT … FROM information_schema.referential_constraints`) and
the inferred/dashed edges become real/solid — **no new engine REST route needed.**
