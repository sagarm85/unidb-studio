# unidb studio

A standalone, dependency-light web UI that demonstrates the [unidb](../unidb)
database engine over its documented HTTP API. It is a **pure static SPA**
(Vite + Svelte) — no backend of its own. Every action is a `fetch` against a
reachable `unidb-server`.

It builds strictly against the engine's REST contract
([`../unidb/docs/REST_API.md`](../unidb/docs/REST_API.md)); it never touches the
engine source.

## What it does

Five panels, all over `POST /sql` and `GET /tables`:

1. **SQL editor** — a textarea + **Run** → `POST /sql`. Renders a results grid
   (rows), an affected-count (`inserted`/`updated`/`deleted`/`truncated`), or a
   DDL status. Failures surface the engine's `{ error, code }` verbatim.
2. **Tables sidebar** — `GET /tables` on load → a clickable list of `name` +
   column summary. One server = one database, presented as *database → tables*.
   Internal tables (`__events__`, …) are hidden. If the server doesn't have the
   `/tables` route yet, the sidebar degrades gracefully instead of erroring.
3. **Record browser** — click a table → `SELECT * FROM <t> ORDER BY <key>
   LIMIT 50`. **Next** does **keyset paging** (`WHERE <key> > $1 ORDER BY <key>
   LIMIT 50`, tracking the last key), preferring an indexed or `id` column. With
   no obvious key it **falls back to `LIMIT`/`OFFSET`**.
4. **Join / filter + timing** — the same editor shows **two clearly separated
   timings** and never conflates them:
   - `round-trip: X ms` — client wall time (`performance.now()` around the fetch).
   - `server exec: Y ms` — true engine execution time, from a **companion
     `EXPLAIN ANALYZE <query>` call** (SELECT/CTE queries only).
5. **CSV import + timing** — pick a `.csv` (row 1 = headers), choose a target
   table → rows are inserted **batched into one transaction per request**
   (many `;`-separated `INSERT`s in a single `POST /sql` body, per the contract's
   only multi-statement-atomicity mechanism). Reports total wall-clock and
   rows/sec.

## Authorization panels (Roles, Policies, Authentication, API Docs, GraphQL)

Five more panels cover Supabase-parity auth/authorization/API surface,
fully live against unidb main's merged auth + auto-REST + GraphQL contract
(PR #222 through #234). See
[`docs/AUTH_POLICY_PANELS_PLAN.md`](docs/AUTH_POLICY_PANELS_PLAN.md) for the
full plan and per-panel verification notes. There are no remaining
feature-detect stubs in any of these panels.

- **Roles** — users + roles list, transitive role-membership editor, a
  per-table GRANT/REVOKE checkbox matrix, and the three built-in roles
  (`anon`/`authenticated`/`service_role`) shown read-only. Live over the
  item-24 RBAC engine (`unidb_catalog.{users,roles,grants,role_members}` +
  auth DDL).
- **Policies** — `CREATE POLICY … FOR <op> [TO <role,…>] USING (…) [WITH
  CHECK (…)]` / `DROP POLICY`, with a role-target chip picker and
  helper-insert buttons for `current_user`, `auth.uid()`, and
  `auth.jwt() ->> 'claim'` (always parenthesised, per the documented `->>`
  precedence caveat), plus **Preview as role** (`POST /auth/preview`). Each
  existing policy now shows its actual `target_roles` (from
  `unidb_catalog.policies`) — a role-chip list when `TO`-scoped, or
  "(all roles)" for the unscoped `"*"` case.
- **Authentication** — real `GET /auth/meta` / `GET /auth/whoami` (also
  showing the JWKS discovery URL and signup status), a users list with
  create-with-password/delete, a **live** reset-password control
  (`ALTER USER <name> PASSWORD '…'`, superuser-gated), an **active
  sessions** table (`unidb_catalog.sessions`: session id, user, created,
  expires, revoked status — never a token/hash) with per-session revoke
  (`DELETE /auth/sessions/{id}`), a flow tester over the real
  `POST /auth/{login,signup,refresh,logout}` routes (branching on the
  `mfa_required` challenge shape when the account has MFA enabled), **TOTP
  MFA** enroll/verify/disable (`POST /auth/mfa/{enroll,verify,disable}` +
  the login-time `POST /auth/mfa/challenge` redemption — the secret and
  `otpauth://` URI are shown for manual entry; recovery codes shown once),
  and **OAuth sign-in** buttons for Google/GitHub, each independently
  feature-detected and hidden when its provider isn't configured server-side.
  Tokens shown in the flow tester are kept in-memory only, never persisted
  or swapped into the Studio's own admin session token.
- **API Docs** — a live schema + curl-snippet viewer generated from the
  engine's own `GET /rest/v1` OpenAPI 3 document, plus a **GET explorer**
  exercising the real `select=`/filter (`eq/neq/gt/gte/lt/lte/like/ilike/
  in/is`)/`order=`/`limit`/`offset` query surface over `/rest/v1/<table>`
  and rendering results live — including **embedded resources**
  (`?select=id,customer(name)` forward, `?select=id,orders(id,total)`
  reverse), with embed options derived from real foreign-key metadata, not
  guessed.
- **GraphQL** — a schema browser over a standard introspection query against
  the engine's `POST /graphql` (schema-derived, read-only v1), a callout
  surfacing unidb's two differentiators over a relational-only
  Supabase/pg_graphql stack (`edges(type, direction)` graph traversal;
  root `near_<table>(vector, k)` vector similarity), starter queries built
  from the real schema, and a query editor that runs real queries and
  renders the real `{data, errors}` response.

## Storage panel

The object-storage browser (buckets/objects over `/storage/*`) now reflects
per-object authorization (item 120, F1), fully live:

- Buckets carry a **public/private** flag (`is_public`), shown as a badge in
  both the bucket list and the open bucket's toolbar; creating a bucket
  exposes the same toggle.
- Objects show their **owner** (the JWT `sub` that uploaded them) in a
  dedicated column.
- Reads, writes, deletes, and presigned-URL issuance are authorized per
  caller: private buckets are owner-only, public buckets are
  readable-by-anyone (writes/deletes stay owner-only), and a superuser or
  `service_role` token bypasses both. The object list simply omits objects
  the caller can't read (no 403 on list); a blocked write/delete/download
  surfaces the engine's `STORAGE_FORBIDDEN` as a plain-language message.

## Configure it (point it at a server)

Config is read from `.env.local` at build/dev time and is **never hardcoded**:

```bash
cp .env.example .env.local
```

Set two variables:

| Variable            | Meaning                                             |
| ------------------- | --------------------------------------------------- |
| `VITE_UNIDB_URL`    | Base URL of a running `unidb-server` (e.g. `http://127.0.0.1:8080`) |
| `VITE_UNIDB_TOKEN`  | A dev-only HS256 JWT (see below)                    |

Then:

```bash
npm install
npm run dev      # dev server (Vite)
npm run build    # production build to dist/
npm run preview  # serve the production build
```

`.env.local` is gitignored (it matches `*.local`); `.env.example` is committed.

> Vite only exposes `.env.local` values at build time — after editing it,
> restart `npm run dev`.

## Mint a dev JWT

The engine ships a pure-bash + `openssl` helper (no Python/PyJWT needed). Use
the **same secret the server was started with** (`UNIDB_JWT_SECRET`):

```bash
TOKEN=$(UNIDB_JWT_SECRET=dev-secret ../unidb/scripts/gen_jwt.sh dev 3600)
echo "VITE_UNIDB_TOKEN=$TOKEN" >> .env.local
```

Arguments are `[subject] [ttl_seconds]` (defaults `dev` / `3600`).

Or skip the shell entirely: under `npm run dev` the header has a **Generate
token** button (backed by a dev-only `GET /__token` Vite middleware). If the
token in `.env.local` is still active it is reused as-is; otherwise a fresh
1-hour JWT is minted with `UNIDB_JWT_SECRET` (default `dev-secret`) and
written back to `.env.local`. The header also shows a live countdown to the
token's expiry. The endpoint exists only in the dev server, never in builds.

## Two honesty caveats

- **The dev token is dev-only.** It embeds trust in the shared HS256 secret. A
  token minted this way must **never** ship to a browser in production — anyone
  with the bundle could forge tokens. In production a *backend-for-frontend*
  holds the secret server-side and mints short-lived tokens per authenticated
  user. This UI puts the token in the browser purely for local demoing.
- **CSV import is per-row `INSERT`, not bulk `COPY`.** unidb has no `COPY`
  path over REST, so import issues one `INSERT` statement per row (batched into
  one transaction per request to cut round-trips). It is fine for demo-sized
  files, not for large data loads. Values are inserted as quoted string literals
  and coerced to each column's type by the engine.

## Notes / known limitations

- **Column names.** `POST /sql`'s `rows` result carries a `columns` array
  (output names in order — resolved names for projections, joins and
  aggregates; `"QUERY PLAN"` for `EXPLAIN`), which the grid uses directly for
  every query, editor included. For older servers that predate this enrichment
  the grid falls back to `GET /tables` names (record browser) or positional
  headers (`col 0`, `col 1`, …).
- **CORS.** The browser calls the server directly, so `unidb-server` must allow
  this origin. If requests fail with a network error, check CORS/binding.
- Requires a reachable server for live data. With no/invalid config the UI still
  loads and shows a clear "not configured" state rather than crashing.

## Stack

Vite + Svelte 5, no component library, no runtime dependencies beyond Svelte.
The entire wire contract lives in one module, [`src/lib/api.js`](src/lib/api.js).
