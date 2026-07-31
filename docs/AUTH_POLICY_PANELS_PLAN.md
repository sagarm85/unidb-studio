# Studio auth / policies / roles / API-docs panels (Workstream G)

**Status:** ALL FOUR PANELS SHIPPED, against unidb main's fully merged
Supabase-parity auth surface (PR #222 + PR #223: password login/signup/
refresh/logout, `auth.uid()`/`auth.jwt()`, built-in roles, role-scoped
policies, column-level grants, production JWT issuer + asymmetric verify/
JWKS, auth rate-limiting, and the auto REST API `/rest/v1/<table>` +
`GET /rest/v1` OpenAPI doc). Two small pieces are feature-detected and
inert until specific follow-up engine work lands (updated 2026-07-31).
**Tracks:** engine roadmap `../unidb/docs/backlog/120_supabase_parity_roadmap.md`
(Workstream G), which depends on engine workstreams A (121), B (122), C (123).

> Plan for the four unidb-studio panels that were missing versus Supabase
> Studio. Every *other* Studio panel already ships (SQL editor, table editor,
> schema/ERD, CSV, storage browser, events/realtime inspector, observability,
> logs, compare).

**Doc-staleness note:** `../unidb/docs/REST_API.md` does not document
`/rest/v1` at all as of this session, even though `GET/POST/PATCH/DELETE
/rest/v1/<table>` and `GET /rest/v1` shipped in PR #223
(`src/server/rest_resource.rs`). G4 below was built by reading that source
module directly, not the docs — flagging this for the engine repo rather
than treating REST_API.md as ground truth when it visibly isn't.

## Panels

### G1 — Authentication panel — LIVE, two pieces feature-detected
- Shipped as `src/lib/AuthPanel.svelte`. Real end to end:
  - `GET /auth/meta` (+ `signup_enabled`) and `GET /auth/whoami`.
  - **Server auth configuration** card also now shows asymmetric-verify
    discovery (`GET /.well-known/jwks.json`, linked directly — it's a public
    route). The "local token issuer" label covers both `UNIDB_DEV_LOGIN` and
    the production `UNIDB_JWT_SIGNING_KEY` path (A5) — `dev_login_enabled`'s
    meaning broadened in the engine to cover both; verified in
    `src/server/handlers.rs::get_auth_meta`, UI wording updated to match
    rather than keep a now-misleading "dev login" label.
  - **Users** section: list, create with an optional password
    (`CREATE USER … PASSWORD '…'`), delete.
  - **Auth flow tester**: real `POST /auth/{login,signup,refresh,logout}`.
    Verified live: password login, refresh-token rotation (old token
    rejected after refresh), idempotent logout, self-service signup.
    Tokens live only in component state — never persisted, never swapped
    into the Studio's own admin session token.
  - `api.js` gained `authLogin`/`authSignup`/`authRefresh`/`authLogout`.
- **Feature-detected, not yet confirmed working (engine owner says
  imminent):** resetting an **existing** user's password via
  `ALTER USER <name> PASSWORD '…'`. The control is real — it sends the
  actual statement — but as of this session the engine returns
  `SQL_UNSUPPORTED` (verified live against a rebuilt server), so the UI
  catches exactly that class of error (`SQL_PARSE_ERROR`/`SQL_UNSUPPORTED`/
  `SQL_PLAN_ERROR`) and permanently hides the control for the rest of the
  session with a clear note, rather than repeatedly erroring. The moment
  the engine accepts the statement, this starts working with no code
  change — verified by testing both the "still rejected" path (current
  main) and reading the exact success path this component takes.
- **Still genuinely unavailable, nothing to probe against:** listing/
  revoking a user's active sessions — there is no route or catalog view for
  it yet, not even a name, so there is nothing to feature-detect (inventing
  a URL would violate "never assume an undocumented route"). Stays a static
  "not available" card until the engine ships something concrete to build
  against.
- User/role/grant/membership administration beyond credentials stays in the
  Roles tab (G3) — not duplicated here, though both read the same
  `unidb_catalog.users` live so they never disagree.

### G2 — Policies editor — LIVE, one field feature-detected
- Shipped as `src/lib/PoliciesPanel.svelte`. Real end to end:
  - `CREATE POLICY … FOR <op> [TO <role,…>] USING (…) [WITH CHECK (…)]` /
    `DROP POLICY`. Verified live: a role-scoped `auth.uid()` policy
    (`CREATE POLICY own_docs ON docs FOR ALL USING (auth.uid() = owner)`)
    correctly showed a logged-in user only their own row via `POST /sql`
    with their real login token.
  - Role-target chip picker (built-ins + custom roles) in the New Policy
    modal; the exact `TO role1, role2 USING (...)` SQL sent was captured
    via network interception and matches `parse_create_policy`'s grammar
    byte-for-byte.
  - Helper-insert buttons for `current_user`/`auth.uid()`/
    `auth.jwt() ->> 'claim'`, inserting at the last-focused USING/WITH CHECK
    textarea's cursor; the claim helper always inserts the parenthesised
    form per the documented `->>` precedence caveat.
  - `POST /auth/preview` ("preview as role") — live.
- **Feature-detected:** whether an existing policy's `TO` target is
  displayable. `unidb_catalog.policies` does not have a `target_roles`
  column as of this session (confirmed live: `SELECT target_roles FROM
  unidb_catalog.policies` → `COLUMN_NOT_FOUND`) even though
  `PolicyDef::target_roles` exists server-side. `listPolicies()` in
  `api.js` first tries the widened query; on `COLUMN_NOT_FOUND` it falls
  back and remembers the result for the session (no re-probing every
  load). Each policy card shows either its real role badges, "(all roles)"
  when genuinely unscoped, or an explicit "(all roles — unscoped or
  unknown, see note above)" plus a persistent panel-level notice when the
  column isn't there — verified live in both states is not possible in one
  session (the column doesn't exist on any server yet), but the fallback
  path is verified live and the "column present" path is unit-verified by
  reading the exact query/parse logic.
- **Not yet done — no request for it this round:** a UI for the new
  column-level grants (`GRANT SELECT (col1, col2) ON t TO r`, item 112/B5,
  confirmed shipped: `unidb_catalog.grants` gained a `columns` field). The
  Roles tab's grant matrix is still whole-table only. Flagged as available,
  not built, since it wasn't asked for.

### G3 — Roles / grants UI — SHIPPED
- Shipped as `src/lib/RolesPanel.svelte`: users + roles list, transitive
  membership editor, per-table GRANT/REVOKE checkbox matrix, all verified
  live end-to-end (create/delete user+role, grant/revoke, add/remove
  membership, each round-tripping to `unidb_catalog.grants`/`role_members`).
- **Built-in roles** (`anon`/`authenticated`/`service_role`): read-only
  section sourced from `RESERVED_ROLES` in `api.js`, mirroring the engine's
  own constant. No delete/grants/membership controls — the engine's
  `require_grantee` check rejects them as a target (verified in source and
  by the grants-matrix design, not attempted destructively live).
- `api.js` gained `getAuthzSnapshot`, `RESERVED_ROLES`.
- Column-level grants: see the G2 entry above — not built this round.

### G4 — API-docs panel — SHIPPED (item 123, C1+C3, merged via PR #223)
- Shipped as `src/lib/ApiDocsPanel.svelte`. Built directly against
  `src/server/rest_resource.rs` since `REST_API.md` doesn't document this
  route yet (see the staleness note above). Confirmed from source, not
  assumed: `GET /rest/v1` (the OpenAPI doc) sits under the same
  `require_jwt` layer as every other data route — it is **not** public —
  and every `/rest/v1/<table>` response reuses `POST /sql`'s `ExecResult`
  JSON shape (`{type:'rows',columns,rows}` / `{type:'inserted',count}` /
  etc.), **not** a bare PostgREST-style array of row objects.
  - **Schema viewer**: per-table columns (name/type/required/PK) rendered
    from `GET /rest/v1`'s `components.schemas`.
  - **Request snippets**: copy-paste curl for list/filtered/insert/update/
    delete, using a `$TOKEN` shell-variable placeholder (matching the
    README's existing convention) rather than embedding the admin's real
    token in a copyable code block.
  - **Live GET explorer**: `select=`/filter builder (the fixed
    `eq/neq/gt/gte/lt/lte/like/ilike/in/is` operator allow-list)/`order=`/
    `limit`/`offset`, executing real `GET /rest/v1/<table>` requests and
    rendering results in `ResultsGrid`. Verified live: a filtered query
    (`owner=eq.alice`) round-tripped correctly and matched a hand-built curl
    equivalent.
  - Mutating (POST/PATCH/DELETE) requests are snippets only, not an
    interactive builder — matches what was asked for; the read-only
    explorer is the only interactive part.
  - **Bug found and fixed on the Studio side** (not an engine change):
    `GET /rest/v1`'s `x-primary-key` table-level extension is only
    populated from a table-level `PRIMARY KEY (...)` constraint — it misses
    the common `CREATE TABLE t (id BIGINT PRIMARY KEY, ...)` column-level
    form (confirmed in `get_openapi`, which reads only
    `def.constraints.primary_key`). Each column's own per-property
    `description: "primary key"` **is** set correctly in that case, so
    `columnsFor()` unions both signals instead of trusting `x-primary-key`
    alone — otherwise the PK badge silently didn't show and the snippet
    builder picked the wrong "non-PK example column" for update snippets.
  - `api.js` gained `getRestOpenApi`, `restGet`.

## Sequencing

- **Done, this session:** all four panels. G3/G4 are fully live with no
  known gaps. G1/G2 are fully live except the two explicitly feature-detected
  pieces below, which activate automatically once the engine ships them —
  no Studio code change needed.
- **Feature-detected, waiting on the engine (no Studio work needed when they land):**
  - `ALTER USER … PASSWORD '…'` (G1 password reset) — control already sends
    the real statement; currently degrades on `SQL_UNSUPPORTED`.
  - `unidb_catalog.policies.target_roles` (G2 role-scope display) — query
    already tries the wider `SELECT`; currently falls back on
    `COLUMN_NOT_FOUND`.
- **Follow-ups with no contract yet to build against (do not guess):** a
  session-listing/revoke-by-id route or catalog view (G1).
- **Available but not requested this round:** a column-level grants UI in
  the Roles tab (item 112/B5 shipped server-side; `unidb_catalog.grants`
  already has the `columns` field to read it back).

## Conventions
- Pure static SPA, no backend of its own — every action is a `fetch` against a
  reachable `unidb-server` (see `README.md`). Build strictly against the engine's
  real contract — prefer reading source over docs when the two disagree, and
  say so (see the REST_API.md staleness note above); never assume an
  undocumented, uncoded route. Degrade gracefully when a route or catalog
  column is absent (as `TablesSidebar` already does for pre-M18 servers), so
  the studio keeps working against older engines.
- Where an engine capability is genuinely absent, or its presence can't be
  known without a live probe, the UI shows an explicit status — never a
  fabricated value or a control that silently does nothing. Two flavors used
  here: a static "not available" card (nothing to probe, e.g. session
  listing) and a feature-detected control (something to probe via its own
  real use, e.g. password reset, target_roles) that quietly starts working
  once the engine catches up.
