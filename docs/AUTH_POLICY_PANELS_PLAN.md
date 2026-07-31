# Studio auth / policies / roles / API-docs panels (Workstream G)

**Status:** IN PROGRESS — G3 shipped, G2 live for everything item 24 supports,
G1 scaffolded as a real-data status panel, G4 blocked (updated 2026-07-31).
**Tracks:** engine roadmap `../unidb/docs/backlog/120_supabase_parity_roadmap.md`
(Workstream G), which depends on engine workstreams A (121), B (122), C (123).

> Plan for the four unidb-studio panels that are still missing versus Supabase
> Studio. Every *other* Studio panel already ships (SQL editor, table editor,
> schema/ERD, CSV, storage browser, events/realtime inspector, observability,
> logs, compare). The four below are missing only because their **engine backend
> does not exist yet** — so each panel lands when its engine workstream lands.

## Panels

### G1 — Authentication panel (needs engine A / item 121) — SCAFFOLDED
- Shipped as `src/lib/AuthPanel.svelte`: a **real-data** status panel over the
  already-shipped `GET /auth/meta` + `GET /auth/whoami` (item 100) — server auth
  mode, dev-login flag, and the caller's own identity/roles/privileges. Per
  `CLAUDE.md` ("never show mock/hardcoded/placeholder data") this panel shows
  **no fabricated content**: everything not yet backed by a live route (password
  credentials, real login, signup, refresh/session revocation, production
  issuer, asymmetric JWT) is listed as an explicit "not available yet" status
  card referencing its `121_auth_core.md` sub-item (A1–A6), not an interactive
  form that would silently no-op.
- User CRUD (create/drop user, mark superuser) is **not duplicated here** — it's
  already real via the item-24 RBAC surface and lives in the Roles tab (G3).
- `api.js` gained `getAuthMeta` / `getWhoami`.
- **Remaining work when item 121 ships:** wire `POST /auth/signup`, real
  `POST /auth/login` (password verify), `POST /auth/refresh` / `POST
  /auth/logout` + a sessions list, and `CREATE USER … PASSWORD …` (set/reset
  password) into this panel, replacing the "not available yet" cards one by one.

### G2 — Policies editor (needs engine B / item 122) — LIVE for what item 24 ships
- Shipped as `src/lib/PoliciesPanel.svelte`, and **not mocked** — the whole
  CRUD surface it covers is real today: `CREATE POLICY`/`DROP POLICY`, the
  `USING`/`WITH CHECK` editors, `current_user` substitution, and — as a bonus
  over the original scope — a live **"Preview as role"** tool wired to the
  already-shipped `POST /auth/preview` (item-24 Z6), letting an admin see
  exactly which rows a given user's policies let through.
- Role targeting (`FOR <op> TO <role>`) and the `auth.uid()` /
  `auth.jwt()->>'claim'` helpers are **not** in the shipped `CREATE POLICY`
  grammar (verified against `src/authz/mod.rs::parse_create_policy` — no `TO`
  clause exists yet) — the UI says so inline rather than offering a control
  that would send SQL the engine can't parse.
- `api.js` gained `listPolicies` / `previewAsRole`.
- **Remaining work when item 122 ships:** add the role-target picker to the
  New Policy modal, and `auth.uid()`/`auth.jwt()->>'…'` helper-insert buttons
  next to the USING/WITH CHECK textareas.

### G3 — Roles / grants UI (engine already ships; UI missing) — SHIPPED
- Shipped as `src/lib/RolesPanel.svelte`: users + roles list, transitive
  membership editor (`GRANT/REVOKE <role> TO/FROM <grantee>`), and a per-table
  GRANT/REVOKE checkbox matrix (SELECT/INSERT/UPDATE/DELETE), all reading
  `unidb_catalog.{users,roles,grants,role_members}` and writing via the item-24
  auth DDL over `POST /sql`. Verified live end-to-end against a running
  `unidb-server-full` (create user/role, grant/revoke a table privilege, add/
  remove role membership all round-trip correctly to `unidb_catalog.grants`).
- `api.js` gained `getAuthzSnapshot`.

### G4 — API-docs panel (needs engine C3 / item 123) — BLOCKED, not started
- Engine item 123 (`GET /rest/v1/` OpenAPI generation) is still **NOT STARTED**
  on the `unidb` side. There is no partial contract to scaffold against yet (no
  route, no draft response shape) — building a UI now would mean inventing the
  shape of data that doesn't exist, which the Studio's engine-truthful rule
  forbids. Deferred until item 123 lands; then: render the catalog-derived
  OpenAPI doc with copy-paste curl (+ future `unidb-js`) snippets in
  `src/lib/ApiDocsPanel.svelte`.

## Sequencing

- **Done:** G3 (full UI, backend was ready) + G2 (full UI for the item-24
  subset; role-scoping stubbed out honestly) + G1 (real-data status panel;
  credentialed-auth actions stubbed out honestly).
- **When A (121) lands:** wire the pending G1 cards to real signup/login/
  refresh/logout/sessions.
- **When B (122) lands:** add role-targeting + `auth.*` helpers to G2.
- **When C3 (123) lands:** build G4 from scratch against the real contract.

## Conventions
- Pure static SPA, no backend of its own — every action is a `fetch` against a
  reachable `unidb-server` (see `README.md`). Build strictly against the engine's
  documented REST contract (`../unidb/docs/REST_API.md`); never assume undocumented
  routes. Degrade gracefully when a route is absent (as `TablesSidebar` already does
  for pre-M18 servers), so the studio keeps working against older engines.
- Where an engine capability is genuinely absent (not just old-server-absent),
  the UI shows an explicit "not available yet" status, never a fabricated value
  or a control that silently does nothing — see G1/G2 above.
