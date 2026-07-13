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

## What the studio does today (Milestone 18 has landed)

Milestone 18 shipped the queryable catalog, so `getSchema()` now reads **real**
primary/foreign keys by `SELECT`ing over `POST /sql` — there is **no** `GET
/schema` route, by design. The visualizer still degrades gracefully in three
tiers (`src/lib/api.js` → `getSchema()`, assembled by `buildCatalogSchema()` in
`src/lib/schema.js`):

1. **`server`** — query the catalog and build the graph from real metadata:
   `information_schema.columns` (nodes), `unidb_catalog.indexes` (VEC/ANN badges),
   `table_constraints`/`key_column_usage` (primary keys), and the 4-way
   `referential_constraints` join (foreign-key edges, composite-key aware).
   Edges are solid; no banner.
2. **`inferred`** — a pre-M18 server that lacks the catalog: fall back to
   `GET /tables` and infer foreign keys from column-name conventions
   (`user_id → users.id`); drawn as dashed edges with an amber banner.
3. **`demo`** — no tables at all → a built-in sample schema so the canvas is
   never blank.

The exact relation/column contract and the reconstruct-DDL-from-metadata rules
this studio relies on live in the engine repo:
`../unidb/docs/engine_access_guide.md` (§4 Introspect, §6 the schema-explorer
recipe the studio is the production version of).
