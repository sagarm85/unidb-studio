# Studio auth / policies / roles / API-docs panels (Workstream G)

**Status:** NOT STARTED
**Tracks:** engine roadmap `../unidb/docs/backlog/120_supabase_parity_roadmap.md`
(Workstream G), which depends on engine workstreams A (121), B (122), C (123).

> Plan for the four unidb-studio panels that are still missing versus Supabase
> Studio. Every *other* Studio panel already ships (SQL editor, table editor,
> schema/ERD, CSV, storage browser, events/realtime inspector, observability,
> logs, compare). The four below are missing only because their **engine backend
> does not exist yet** — so each panel lands when its engine workstream lands.

## Panels

### G1 — Authentication panel (needs engine A / item 121)
- Users list + create/delete, set/reset password, mark superuser, invite, ban.
- Sessions view + revoke (once refresh tokens land, A4).
- Backs onto the new auth endpoints from 121 (`/auth/signup`, `/auth/login`,
  `/auth/refresh`, `/auth/logout`) plus the existing `/auth/whoami`, `/auth/meta`,
  and the authz DDL over `/sql` (`CREATE USER … PASSWORD …`).
- New tab in `src/App.svelte` `VALID_TABS`; `src/lib/AuthPanel.svelte`;
  `src/lib/api.js` gains `listUsers/createUser/deleteUser/setPassword/…`.

### G2 — Policies editor (needs engine B / item 122)
- Per-table RLS policy list + create/edit/drop, with role targeting
  (`FOR <op> TO <role>`), `USING` and `WITH CHECK` editors, and helper insertion
  of `current_user`, `auth.uid()`, `auth.jwt()->>'claim'`.
- Reads existing policies from `unidb_catalog.*` (already queryable over `/sql`);
  writes via `CREATE/DROP POLICY`. `src/lib/PoliciesPanel.svelte`.

### G3 — Roles / grants UI (engine already ships; UI missing)
- Roles list + membership editor (transitive), per-table GRANT/REVOKE matrix
  (SELECT/INSERT/UPDATE/DELETE). RBAC engine exists today (item 24) — this is a
  pure UI over `GRANT`/`REVOKE` + the `role_members`/`users` catalog relations.
- Can start ahead of G1/G2 since its backend is done. `src/lib/RolesPanel.svelte`.

### G4 — API-docs panel (needs engine C3 / item 123)
- Render the catalog-derived OpenAPI doc (`GET /rest/v1/`) with copy-paste request
  snippets (curl + the future `unidb-js` SDK). `src/lib/ApiDocsPanel.svelte`.

## Sequencing
- **Now (ahead of engine):** G3 (backend ready) + G1/G2 UI scaffolding against the
  121/122 contracts (mock the endpoints; wire when they land).
- **When A lands:** finish G1. **When B lands:** finish G2. **When C3 lands:** G4.

## Conventions
- Pure static SPA, no backend of its own — every action is a `fetch` against a
  reachable `unidb-server` (see `README.md`). Build strictly against the engine's
  documented REST contract (`../unidb/docs/REST_API.md`); never assume undocumented
  routes. Degrade gracefully when a route is absent (as `TablesSidebar` already does
  for pre-M18 servers), so the studio keeps working against older engines.
