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

## Authorization panels (Roles, Policies, Authentication, API Docs, GraphQL, Users, Webhooks, Channel Authz)

Eight more panels cover Supabase-parity auth/authorization/API surface,
fully live against unidb main's merged auth + auto-REST + GraphQL + realtime
+ webhooks contract (PR #222 through #245). See
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
  and **OAuth sign-in** buttons for all seven built-in preset providers
  (Google/GitHub/Apple/Microsoft/GitLab/Discord/Facebook), each
  independently feature-detected and hidden when its provider isn't
  configured server-side. Tokens shown in the flow tester are kept
  in-memory only, never persisted or swapped into the Studio's own admin
  session token. **Email auth flows** — password recovery
  (`POST /auth/recover` → `POST /auth/verify`) and magic-link sign-in
  (`POST /auth/magiclink` → `POST /auth/magiclink/verify`), both request
  steps showing the real uniform `{ok:true}` no-enumeration response, plus
  a live **dev-inbox viewer** (`GET`/`DELETE /auth/dev-inbox`) that reads
  back real captured recovery/magic-link emails and fills the redemption
  token field for you — superuser-only, absent entirely on a real-SMTP
  deployment.
- **API Docs** — a live schema + curl-snippet viewer generated from the
  engine's own `GET /rest/v1` OpenAPI 3 document, plus a full **GET/POST/
  PATCH/DELETE explorer** exercising the real `select=`/filter (`eq/neq/gt/
  gte/lt/lte/like/ilike/in/is`)/`order=`/`limit`/`offset` query surface over
  `/rest/v1/<table>` and rendering results live — including **embedded
  resources** (`?select=id,customer(name)` forward, `?select=id,
  orders(id,total)` reverse) with per-embed filter/order/limit/offset
  (dotted `<embed>.<col>=` params), embed options derived from real
  foreign-key metadata, and `Prefer: count=exact` / `return=representation|
  minimal` support with the real `Content-Range` total and
  `Preference-Applied` echo shown.
- **GraphQL** — a schema browser over a standard introspection query against
  the engine's `POST /graphql` (schema-derived, read + write), a callout
  surfacing unidb's two differentiators over a relational-only
  Supabase/pg_graphql stack (`edges(type, direction)` graph traversal;
  root `near_<table>(vector, k)` vector similarity), starter queries built
  from the real schema, a query editor that runs real queries and renders
  the real `{data, errors}` response, and **mutations**
  (`insert_/update_/delete_<table>`) with typed starter bodies built from
  each table's real scalar columns, resolving through the same enforced
  write path as `/rest/v1`/`/sql`.
- **Users** — superuser user management over `/auth/admin/users`: paginated
  list with real total counts, create/edit/delete, ban/unban, and JSON
  editors for `app_metadata`/`user_metadata`. Never renders a password hash
  or session token; the last-superuser-lockout guard is enforced
  server-side and surfaced verbatim, not reimplemented client-side.
- **Webhooks** — database webhook management over `/webhooks`: target URL,
  table pattern, event selection, a write-only signing secret, and enable/
  disable, plus a help block documenting the real CDC-envelope body and
  `X-Unidb-Signature` HMAC contract. The secret is never shown back — `GET`
  only ever returns `has_signing_secret: true|false`.
- **Channel Authz** — realtime channel authorization policies over
  `/realtime/policies` (`topic_pattern`, `operation`, `allowed_roles`),
  structurally mirroring the Policies panel's role-chip picker, plus a
  documentation-only note on the `UNIDB_REALTIME_REQUIRE_AUTHZ` posture
  (this is a server env var with no read API, so the Studio explains both
  postures rather than claiming to know which one is live).

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

## Contract notes

Gaps found between the documented/expected contract and what the engine
actually exposes, discovered while building the panels above. These are
flagged here rather than worked around with invented behavior, per this
repo's `CLAUDE.md` rule. **No open gaps as of this writing** — both items
below were flagged in an earlier session against an at-the-time-current
`unidb` clone and have since shipped on `unidb` main; kept here as a
resolved record rather than deleted outright (see
`docs/AUTH_POLICY_PANELS_PLAN.md` for the full live-verification detail of
each fix).

- **Resolved (item 145, PR #248): reading back a sent recovery/magic-link
  email.** The default `UNIDB_EMAIL_TRANSPORT=log` writes the rendered
  email to a server-side file with no HTTP route to read it back — flagged
  as a gap in an earlier session. `GET`/`DELETE /auth/dev-inbox` now
  closes it (superuser-only, `404` on a real-SMTP deployment); the
  Authentication panel's Email auth flows card has a live dev-inbox viewer
  that fills the redemption token for you instead of requiring a
  hand-copied value.
- **Resolved (item 143 part 2, PR #246): OAuth provider presets beyond
  Google/GitHub.** An earlier session found no trace of apple/azure/
  gitlab/discord/facebook presets against its `unidb` clone at the time.
  Item 143 part 2 has since shipped — all seven preset providers are now
  live in the Authentication panel, each independently feature-detected
  exactly like Google/GitHub always were.

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
