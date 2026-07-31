# Studio auth / policies / roles / API-docs panels (Workstream G)

**Status:** G1/G2/G3 all live against unidb main's merged auth contract
(PR #222 — password login/signup/refresh/logout, `auth.uid()`/`auth.jwt()`,
role-scoped policies, built-in roles). G4 blocked (updated 2026-07-31).
**Tracks:** engine roadmap `../unidb/docs/backlog/120_supabase_parity_roadmap.md`
(Workstream G), which depends on engine workstreams A (121), B (122), C (123).

> Plan for the four unidb-studio panels that are still missing versus Supabase
> Studio. Every *other* Studio panel already ships (SQL editor, table editor,
> schema/ERD, CSV, storage browser, events/realtime inspector, observability,
> logs, compare). The four below are missing only because their **engine backend
> does not exist yet** — so each panel lands when its engine workstream lands.

## Panels

### G1 — Authentication panel (engine A / item 121) — LIVE
- Shipped as `src/lib/AuthPanel.svelte`. Real end to end against the merged
  item-121 contract:
  - `GET /auth/meta` (+ `signup_enabled`) and `GET /auth/whoami` — server
    config + caller identity.
  - **Users** section: list (`unidb_catalog.users`), create with an optional
    password (`CREATE USER … PASSWORD '…'` — quoted/escaped client-side,
    `''`-doubling to match the engine's SQL-standard string-literal parsing),
    delete (`DROP USER …`).
  - **Auth flow tester**: real `POST /auth/{login,signup,refresh,logout}`
    calls, showing the returned access/refresh tokens (copy-to-clipboard,
    truncated display). Signup is disabled in the UI when
    `meta.signup_enabled` is false, with a tooltip explaining why, rather
    than a request that would 404.
  - Tokens from the flow tester live only in this component's in-memory
    state — never persisted (no localStorage/cookies) and never swapped into
    the Studio's own admin session token.
  - `api.js` gained `authLogin` / `authSignup` / `authRefresh` / `authLogout`.
- **Verified still NOT available** (checked against `unidb` main source, not
  assumed) — shown as explicit "not available" cards, not dead controls:
  - Resetting an **existing** user's password: `Engine::set_password` exists
    but is Rust-only — no `ALTER USER … PASSWORD` DDL and no REST route.
  - Listing/revoking a user's active sessions: only single-token
    refresh/logout exist; there's no enumeration route.
  - A5 (production token issuer, currently gated behind `UNIDB_DEV_LOGIN`)
    and A6 (asymmetric JWT / JWKS) — neither shipped in PR #222.
- User/role/grant/membership administration beyond credentials (mark
  superuser via the Roles tab too, table grants, role membership) stays in
  the Roles tab (G3) — not duplicated here, though both read the same
  `unidb_catalog.users` live so they never disagree.

### G2 — Policies editor (engine B / item 122) — LIVE
- Shipped as `src/lib/PoliciesPanel.svelte`. Real end to end against the
  merged item-122 contract:
  - `CREATE POLICY … FOR <op> [TO <role,…>] USING (…) [WITH CHECK (…)]` and
    `DROP POLICY`, verified against `parse_create_policy` on unidb main
    (the `TO` clause is comma-separated, positioned between the operation
    and `USING`).
  - Role-target picker in the New Policy modal: the three built-in roles
    (`anon`/`authenticated`/`service_role`) plus any custom roles, as
    toggle chips; no selection = no `TO` clause (applies to every caller,
    unchanged prior behavior).
  - Helper-insert buttons for `current_user`, `auth.uid()`, and
    `auth.jwt() ->> 'claim'` next to both the USING and WITH CHECK
    textareas, inserting at the last-focused field's cursor position. The
    claim helper always inserts the parenthesised form
    `(auth.jwt() ->> 'claim')` with `claim` pre-selected for the admin to
    type over — REST_API.md's documented precedence caveat (`->>` binds
    looser than `=`) is handled by construction, not left as a footgun.
  - `POST /auth/preview` ("preview as role") — unchanged, already live.
  - `api.js` gained `getAuthzSnapshot` reuse (for the role-target list).
- **Known engine gap, flagged rather than worked around:**
  `unidb_catalog.policies` does not expose a policy's `TO` target roles —
  verified against `src/sql/information_schema.rs` on unidb main, whose
  `policies` column list is `(name, table_name, operation, using_expr,
  with_check_expr, enforced)` only, even though `PolicyDef::target_roles`
  exists server-side (`src/authz/mod.rs`). So the panel can **author**
  role-scoped policies but **cannot show** which existing policies are
  role-scoped, or to which roles — there's a persistent, honest notice
  in the UI instead of a client-side guess. **Action for the engine repo:**
  file a backlog item under `unidb/docs/backlog/` to add a `target_roles`
  (or similar) column to the `policies` virtual relation.

### G3 — Roles / grants UI (item 24 + item 122 B3) — SHIPPED
- Shipped as `src/lib/RolesPanel.svelte`: users + roles list, transitive
  membership editor (`GRANT/REVOKE <role> TO/FROM <grantee>`), and a per-table
  GRANT/REVOKE checkbox matrix (SELECT/INSERT/UPDATE/DELETE), all reading
  `unidb_catalog.{users,roles,grants,role_members}` and writing via the item-24
  auth DDL over `POST /sql`. Verified live end-to-end against a running
  `unidb-server-full` (create user/role, grant/revoke a table privilege, add/
  remove role membership all round-trip correctly to `unidb_catalog.grants`).
- **Built-in roles** (item 122, B3): `anon`/`authenticated`/`service_role` are
  shown in a dedicated, read-only third section — sourced from a hardcoded
  `RESERVED_ROLES` constant in `api.js` that mirrors the identical constant
  in `src/authz/mod.rs::RESERVED_ROLES` (real, documented, fixed engine
  behavior, not a fabricated value; they're never rows in
  `unidb_catalog.roles`, so there is nothing to fetch). No delete button, no
  grants matrix, no membership editor: the engine's own `require_grantee`
  check rejects them as a `GRANT`/role-membership target (verified in
  source), so those controls would only produce a confusing `AUTHZ_ERROR`.
  They're only addressable in a policy's `TO` clause — the detail view
  says so and points at the Policies tab.
- `api.js` gained `getAuthzSnapshot`, `RESERVED_ROLES`.

### G4 — API-docs panel (needs engine C3 / item 123) — BLOCKED, not started
- Engine item 123 (`GET /rest/v1/` OpenAPI generation) is still **NOT STARTED**
  on the `unidb` side. There is no partial contract to scaffold against yet (no
  route, no draft response shape) — building a UI now would mean inventing the
  shape of data that doesn't exist, which the Studio's engine-truthful rule
  forbids. Deferred until item 123 lands; then: render the catalog-derived
  OpenAPI doc with copy-paste curl (+ future `unidb-js`) snippets in
  `src/lib/ApiDocsPanel.svelte`.

## Sequencing

- **Done:** G3 (full UI + built-ins) + G2 (full UI incl. role-scoped policies
  and the `auth.*` helpers; catalog gap flagged, not worked around) + G1
  (full UI incl. users w/ password + the full login/signup/refresh/logout
  flow; the two genuinely-missing engine capabilities flagged).
- **When C3 (123) lands:** build G4 from scratch against the real contract.
- **Follow-ups tracked, not scheduled:** `ALTER USER … PASSWORD` (password
  reset for existing users), a session-listing route, A5/A6 (production
  issuer, asymmetric JWT/JWKS), and the `unidb_catalog.policies.target_roles`
  read gap above — all engine-side, filed as notes here pending an
  `unidb/docs/backlog/` item.

## Conventions
- Pure static SPA, no backend of its own — every action is a `fetch` against a
  reachable `unidb-server` (see `README.md`). Build strictly against the engine's
  documented REST contract (`../unidb/docs/REST_API.md`); never assume undocumented
  routes. Degrade gracefully when a route is absent (as `TablesSidebar` already does
  for pre-M18 servers), so the studio keeps working against older engines.
- Where an engine capability is genuinely absent (not just old-server-absent),
  the UI shows an explicit "not available yet" status, never a fabricated value
  or a control that silently does nothing — see G1/G2 above.
