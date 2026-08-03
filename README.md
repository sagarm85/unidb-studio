# unidb studio

A standalone, dependency-light web UI that demonstrates the [unidb](../unidb)
database engine over its documented HTTP API. It is a **pure static SPA**
(Vite + React 19 + TypeScript + Tailwind v4 + shadcn/ui) — no backend of its
own. Every action is a `fetch` against a reachable `unidb-server`.

It builds strictly against the engine's REST contract
([`../unidb/docs/REST_API.md`](../unidb/docs/REST_API.md)); it never touches the
engine source.

This is the v2 rewrite of the original Svelte 5 Studio — same wire contract
(`src/lib/engine/api.js` is the one module that knows it), same
engine-truthful principle (`CLAUDE.md`: never fabricate a value the engine
doesn't actually return), rebuilt on React/TypeScript/shadcn.

## What it does

A left-nav SPA over four groups of tabs, all wired to real engine data —
`GET /tables`, `POST /sql`, and every route documented in
[`../unidb/docs/REST_API.md`](../unidb/docs/REST_API.md):

**Project Overview** — stat cards + a live metrics chart sourced from
`GET /stats`/`GET /stats/history`, quick links into the other tabs.

**Database:**
1. **Table Editor** — browse/page/filter/sort a table's rows, inline cell
   edit, row insert/delete, CSV export.
2. **SQL Editor** — a query editor with saved/pinned queries, history,
   session transactions, `EXPLAIN`/`EXPLAIN ANALYZE` with the same
   round-trip-vs-server-exec timing split the original Studio had, and
   single-`SELECT` results always paged through a server cursor rather than
   fetching an unbounded result set.
3. **Schema** — a drag/pan ERD sourced from real primary keys and foreign
   keys (`information_schema` + `unidb_catalog`), plus a DDL view.
4. **CSV Import** — batched per-row `INSERT`s (see the honesty caveat below).

**Platform:**
- **Storage** — buckets/objects over `/storage/*`, reflecting per-object
  authorization (item 120, F1) — see below.
- **Events** — the WAL-derived change-event stream, live-tailing.
- **Auth** — Roles / Grants / Policies / Preview / Whoami / **Sessions** /
  **Sign-in flows**, described below.
- **Users** — superuser user management over `/auth/admin/users`.
- **Webhooks** — database webhook management over `/webhooks`.
- **Channel Authz** — realtime channel authorization policies over
  `/realtime/policies`.
- **Broadcast & Presence** — a live SSE test client over
  `/realtime/broadcast/*` and `/realtime/presence/*` (item 132): publish/
  subscribe broadcast messages on a topic, track/watch presence with a live
  join/leave/update map. Purely in-memory and ephemeral, per the engine
  contract — a server restart drops all state.
- **Scheduled Jobs** — a Supabase-parity `pg_cron` surface over
  `/cron/jobs` (item 144): register `(name, schedule, sql, run_as?)`,
  toggle/delete, see last-run status (no persisted run history — only
  in-memory state, reset on server restart).

**API:**
- **API Docs** — a live schema + curl-snippet viewer generated from the
  engine's own `GET /rest/v1` OpenAPI 3 document, plus a full **GET/POST/
  PATCH/DELETE explorer** exercising the real `select=`/filter (`eq/neq/gt/
  gte/lt/lte/like/ilike/in/is`)/`order=`/`limit`/`offset` query surface over
  `/rest/v1/<table>`, item 136's per-embed filter/order/limit/offset params,
  and item 139's `Prefer: count=exact` / `return=representation|minimal`
  with the real `Content-Range`/`Preference-Applied` response headers shown.
- **GraphQL** — a schema browser over a standard introspection query
  against the engine's `POST /graphql` (schema-derived, read + write), a
  callout surfacing unidb's two differentiators over a relational-only
  Supabase/pg_graphql stack (`edges(type, direction)` graph traversal; root
  `near_<table>(vector, k)` vector similarity), starter queries/mutations
  built from the real schema, and a query editor that runs real
  queries/mutations and renders the real `{data, errors}` envelope.
- **Functions** — stored SQL functions callable over RPC (item 147,
  Supabase `pg_proc`/`rpc()` parity). Lists every registered function with
  its params, run-as identity, and SQL body (`GET /functions`); creates/
  upserts one (`POST /functions`); calls it with named or positional JSON
  args and renders the last statement's result (`POST /rest/v1/rpc/{fn}`);
  and deletes it (`DELETE /functions/{name}`). Admin surface is superuser-
  only; the call route runs under invoker/`run_as` identity.

**Monitor:** Observability, Logs, Compare (unidb vs Postgres benchmark
viewer).

### Auth tab

The Auth tab's seven subtabs cover unidb's full per-user authorization and
credentialed-auth surface, fully live — no fabricated data, no
feature-detect stubs remaining anywhere in it:

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
- **Preview** — `POST /auth/preview`, a role-impersonation debugger: run any
  query as a chosen user and see the RLS-filtered result.
- **Whoami** — `GET /auth/whoami`: the caller's own identity/privileges.
- **Sessions** — `unidb_catalog.sessions` (session id, user, created,
  expires, revoked status — never a token/hash) with per-session revoke
  (`DELETE /auth/sessions/{id}`).
- **Sign-in flows** — a credential flow tester over the real
  `POST /auth/{login,signup,refresh,logout}` routes (branching on the
  `mfa_required` challenge shape when the account has MFA enabled); **TOTP
  MFA** enroll/verify/disable (`POST /auth/mfa/{enroll,verify,disable}` +
  the login-time `POST /auth/mfa/challenge` redemption — the secret and
  `otpauth://` URI are shown for manual entry; recovery codes shown once);
  **OAuth sign-in** buttons for all seven built-in preset providers
  (Google/GitHub/Apple/Microsoft/GitLab/Discord/Facebook), each
  independently feature-detected and hidden when its provider isn't
  configured server-side; **email auth flows** — password recovery
  (`POST /auth/recover` → `POST /auth/verify`) and magic-link sign-in
  (`POST /auth/magiclink` → `POST /auth/magiclink/verify`), both request
  steps showing the real uniform `{ok:true}` no-enumeration response, plus
  a live **dev-inbox viewer** (`GET`/`DELETE /auth/dev-inbox`) that reads
  back real captured recovery/magic-link emails and fills the redemption
  token field for you — superuser-only, absent entirely on a real-SMTP
  deployment. Tokens shown here are kept in-memory only, never persisted
  or swapped into the Studio's own bearer token.

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
  files, not for large data loads. Cell values are emitted **type-aware** from
  the target table's catalog schema: numeric columns get bare literals, everything
  else a quoted string (empty → `NULL`). This is required because the engine's
  write path is strict — it does **not** coerce a quoted string into a numeric
  column (a quoted `'5'` into an `INTEGER` errors), so the importer must know each
  column's type rather than quoting everything.

## Contract notes

Gaps found between the documented/expected contract and what the engine
actually exposes, discovered while building the panels above. These are
flagged here rather than worked around with invented behavior, per this
repo's `CLAUDE.md` rule. **No open gaps as of this writing** — both items
below were flagged in an earlier session against an at-the-time-current
`unidb` clone and have since shipped on `unidb` main; kept here as a
resolved record rather than deleted outright.

- **Resolved (item 145, PR #248): reading back a sent recovery/magic-link
  email.** The default `UNIDB_EMAIL_TRANSPORT=log` writes the rendered
  email to a server-side file with no HTTP route to read it back — flagged
  as a gap in an earlier session. `GET`/`DELETE /auth/dev-inbox` now
  closes it (superuser-only, `404` on a real-SMTP deployment); the Auth
  tab's Sign-in flows subtab has a live dev-inbox viewer that fills the
  redemption token for you instead of requiring a hand-copied value.
- **Resolved (item 143 part 2, PR #246): OAuth provider presets beyond
  Google/GitHub.** An earlier session found no trace of apple/azure/
  gitlab/discord/facebook presets against its `unidb` clone at the time.
  Item 143 part 2 has since shipped — all seven preset providers are now
  live in the Auth tab, each independently feature-detected exactly like
  Google/GitHub always were.
- **Resolved (this session): the v2 (React) app was missing 8 panels/
  features the v1 (Svelte) app had already shipped, and both apps were
  missing a Cron Jobs panel (item 144) and a Broadcast & Presence panel
  (item 132) despite the engine having full support for both.** v2 is now
  current with everything on `unidb` main through PR #250.

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

Vite + React 19 + TypeScript + Tailwind v4 + shadcn/ui ("new-york" style).
The entire wire contract lives in one module,
[`src/lib/engine/api.js`](src/lib/engine/api.js) — every component speaks in
terms of the normalized shapes it returns, never raw `fetch` responses.
