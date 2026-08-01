# Studio auth / policies / roles / API-docs panels (Workstream G)

**Status:** SIX PANELS FULLY LIVE, against unidb main's fully merged
Supabase-parity surface (PR #222 through #234): password
login/signup/refresh/logout + session listing/revoke, `ALTER USER …
PASSWORD`, `auth.uid()`/`auth.jwt()`, built-in roles, role-scoped policies
with a readable `target_roles`, column-level grants, production JWT issuer +
asymmetric verify/JWKS, auth rate-limiting, realtime per-subscriber RLS
(E1), the auto REST API `/rest/v1/<table>` + `GET /rest/v1` OpenAPI doc +
C2 embedded-resource expansion, per-object storage authorization (F1), TOTP
MFA (item 127, D4), OAuth 2.0 social login (item 128, D1), and a
schema-derived GraphQL API (item 130, C4). No feature-detect stubs remain
in any of the six panels (updated 2026-08-01).

**Tracks:** engine roadmap `../unidb/docs/backlog/120_supabase_parity_roadmap.md`
(Workstream G), which depended on engine workstreams A (121), B (122), C
(123), E (realtime), F (storage authz), and the "Studio-unblocker" item 4.

> Plan for the four unidb-studio panels that were missing versus Supabase
> Studio, plus the Storage panel's authorization surface once F1 shipped.
> Every *other* Studio panel already ships (SQL editor, table editor,
> schema/ERD, CSV, events/realtime inspector, observability, logs, compare).

**Doc-staleness note (still relevant):** `../unidb/docs/REST_API.md` did not
document `/rest/v1` at all when G4 was built (PR #223) — it shipped in code
first. G4 was built by reading `src/server/rest_resource.rs` directly. By
this session `REST_API.md` had caught up for the auth/sessions/storage
surface, but the lesson stands: verify against source when in doubt, and say
so when the two disagree.

**Two engine bugs found and reported in an earlier session** (both in
`unidb-server-full` specifically, not `unidb-server`; both reproduced live
— `unidb` is read-only for this workstream, so filed rather than fixed
here. **Both are now fixed upstream, PR #238 — see the correction below.**):

1. **`try_init_storage` ignores `STORAGE_BACKEND=memory`.** It unconditionally
   calls `S3ObjectStore::from_config`, so the Docker-free `MemoryObjectStore`
   test double (used by `cargo test`, per `unidb-storage/src/store/mod.rs`)
   is unreachable from this binary — `STORAGE_BACKEND=memory` still demands
   `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` and tries a real S3 call.
2. **`axum::serve(listener, router)` never wires `ConnectInfo<SocketAddr>`.**
   The new auth rate-limiter (item 121 I1) extracts `ConnectInfo<SocketAddr>`
   per request (`src/server/rate_limit.rs`) — `src/bin/unidb-server.rs`
   correctly serves via
   `.into_make_service_with_connect_info::<SocketAddr>()`, but
   `unidb-server-full/src/main.rs` still calls plain `axum::serve(listener,
   router)`. Result: **every** `POST /auth/login` (and presumably
   `/signup`/`/refresh`) 500s on `unidb-server-full` with "Missing request
   extension: Extension of type `ConnectInfo<SocketAddr>` was not found" —
   the storage-capable binary can't authenticate a single password login.

Both were verified against a throwaway **local, uncommitted, never-pushed**
patch to `unidb-server-full/src/main.rs` (branch on `cfg.backend ==
Backend::Memory` → `MemoryObjectStore`; switch to
`into_make_service_with_connect_info`), used only to unblock live-verifying
this session's Studio changes, then discarded (`git checkout --`) —
`unidb`'s working tree is back to a clean `origin/main` with nothing
committed or pushed. File these as real backlog items; the fixes are small
(a few lines each) but they block the *storage-capable* binary specifically,
which is what the Studio's own setup docs point people to.

**Correction — both fixed upstream, PR #238 (item 135).** Still unfixed as
of PR #234 (re-checked that session); `unidb-server-full/src/main.rs` now
selects the object store by `cfg.backend` (so `Backend::Memory` reaches
`MemoryObjectStore` directly, matching the fix this doc's throwaway local
patch used) and serves via
`.into_make_service_with_connect_info::<SocketAddr>()`, matching
`src/bin/unidb-server.rs`. **Re-verified live this session** (not just read
against the diff): rebuilt `unidb-server-full`, started it with
`STORAGE_BACKEND=memory` and no S3 credentials — `storage service ready,
backend=memory` logged, `POST /storage/buckets` + `GET /storage/buckets`
both succeeded; `POST /auth/login` against a real password user returned
`200` with a real token pair instead of the prior 500. No further Studio
workaround needed — `unidb-server-full` is now a clean target for every
panel in this doc, storage included.

## Panels

### G1 — Authentication panel — FULLY LIVE
Shipped as `src/lib/AuthPanel.svelte`. Everything below verified live
against a rebuilt engine (through PR #226), not just read against docs:

- `GET /auth/meta` (+ `signup_enabled`) and `GET /auth/whoami`.
- **Server auth configuration** card: mode, local token issuer (label covers
  both `UNIDB_DEV_LOGIN` and the production `UNIDB_JWT_SIGNING_KEY` path —
  `dev_login_enabled`'s meaning broadened server-side; the UI label was
  updated to match rather than keep a now-misleading "dev login" name),
  asymmetric-verify JWKS link (`GET /.well-known/jwks.json`, public route),
  signup status.
- **Users**: list, create with an optional password
  (`CREATE USER … PASSWORD '…'`), delete, and **reset password for an
  existing user** via `ALTER USER <name> PASSWORD '…'` — a normal action
  with normal error handling now (the DDL shipped in PR #225; no more
  feature-detect wrapper).
- **Active sessions** (new this session, item 4): lists
  `unidb_catalog.sessions` (`session_id, username, created_at, expires_at,
  revoked` — created_at/expires_at are epoch **seconds**, verified against
  `authz::now_secs()`, not the milliseconds storage timestamps use
  elsewhere) with a per-row **Revoke** button over
  `DELETE /auth/sessions/{id}`. Verified live: a superuser sees every
  session; revoking one flips it to a dimmed "revoked" row immediately.
  Degrades to "not available" on a pre-item-4 server.
- **Auth flow tester**: real `POST /auth/{login,signup,refresh,logout}`.
  Verified live: password login, refresh-token rotation (old token rejected
  after refresh), idempotent logout, self-service signup. Tokens live only
  in component state — never persisted, never swapped into the Studio's own
  admin session token.
- `api.js` gained `authLogin`/`authSignup`/`authRefresh`/`authLogout`/
  `listSessions`/`revokeSession`.
- **TOTP MFA** (new this session, item 127, D4): enroll (`POST
  /auth/mfa/enroll` → secret + `otpauth://` URI) → verify (`POST
  /auth/mfa/verify` with a live code → flips `whoami.mfa_enabled`, returns 8
  one-time recovery codes shown exactly once) → disable (`POST
  /auth/mfa/disable`, code-gated unless the caller is a superuser). The
  login flow tester now branches on `POST /auth/login`'s two response
  shapes: a normal session, or `{mfa_required, challenge, expires_in}` for
  an MFA-enabled account, redeemed inline via `POST /auth/mfa/challenge`.
  **QR rendering deliberately not built** — see the code comment at the top
  of `AuthPanel.svelte` for the full reasoning; short version: hand-rolling
  a QR encoder risks a silent, unscannable-but-plausible-looking bug this
  sandbox can't scan-test, and calling a third-party QR image API would leak
  the TOTP secret off-device. The secret and full `otpauth://` URI are shown
  instead, both copy-able — every authenticator app accepts manual entry.
  Verified live end-to-end (enroll → compute a real TOTP code → verify →
  recovery codes shown → login → MFA challenge redeemed with a fresh code →
  disable as superuser with no code).
- **OAuth 2.0 social login** (new this session, item 128, D1): "Sign in with
  Google/GitHub" buttons, each feature-detected independently — `GET
  /auth/oauth/{provider}/authorize` fetched with `redirect: 'manual'` so a
  configured provider's 302 never actually navigates the probe (collapses to
  an opaque response) while an unconfigured provider's readable 404 hides
  the button. A click is a REAL browser redirect (not a fetch) to the
  provider. Because this is a backend-less static SPA, completing the flow
  requires the deployment's `UNIDB_OAUTH_<PROVIDER>_REDIRECT_URI` to point
  back at the Studio's own origin (e.g. `<studio-origin>/?tab=auth`, which
  `App.svelte`'s existing `?tab=` restore already lands on this panel); on
  that landing, `checkOauthCallback()` forwards the provider's `?code=&state=`
  to the engine's own `GET /auth/oauth/{provider}/callback` as a plain fetch
  to finish the flow. **Verified live end-to-end** with a local mock OAuth
  provider (authorize/token/userinfo) standing in for Google: button
  correctly hidden with no provider configured, correctly shown once
  configured, full click-through created a real
  `oauth_google_<provider_user_id>` account and a real session, tokens
  rendered in the flow tester.
- `api.js` gained `mfaEnroll`/`mfaVerify`/`mfaChallenge`/`mfaDisable`,
  `getOauthProviders`/`oauthAuthorizeUrl`/`oauthCallback`.

User/role/grant/membership administration beyond credentials stays in the
Roles tab (G3) — not duplicated here, though both read the same
`unidb_catalog.users` live so they never disagree.

### G2 — Policies editor — FULLY LIVE
Shipped as `src/lib/PoliciesPanel.svelte`:

- `CREATE POLICY … FOR <op> [TO <role,…>] USING (…) [WITH CHECK (…)]` /
  `DROP POLICY`. Verified live: a role-scoped `auth.uid()` policy correctly
  restricted a logged-in user to their own row via a real login token.
- Role-target chip picker (built-ins + custom roles); the exact `TO role1,
  role2 USING (...)` SQL sent was captured via network interception and
  matches `parse_create_policy`'s grammar byte-for-byte.
- Helper-insert buttons for `current_user`/`auth.uid()`/
  `auth.jwt() ->> 'claim'`, always inserting the parenthesised claim form
  per the documented `->>` precedence caveat.
- `POST /auth/preview` ("preview as role") — live.
- **Role-scope display** (new this session, item 4): `unidb_catalog.policies`
  now has a real `target_roles` column — comma-joined, alphabetically
  sorted, or the literal `"*"` for an unscoped policy
  (`information_schema.rs::policies_rows`). `listPolicies()` reads it and
  `normalizeTargetRoles()` treats `"*"` as unscoped. Verified live: an
  unscoped policy shows "(all roles)"; a `TO authenticated` policy shows an
  `authenticated` badge. The widened `SELECT` still falls back gracefully
  to a `COLUMN_NOT_FOUND`-triggered unscoped display on an older server, so
  the Studio keeps working there too.
- `api.js` gained `getAuthzSnapshot` reuse (role-target list) and the
  `target_roles`-aware `listPolicies()`.

**Not built this round (available, not requested):** a UI for column-level
grants (`GRANT SELECT (col1, col2) ON t TO r`, item 112/B5 — shipped
server-side, `unidb_catalog.grants` already has a `columns` field to read it
back). The Roles tab's grant matrix is still whole-table only.

### G3 — Roles / grants UI — SHIPPED
Shipped as `src/lib/RolesPanel.svelte`: users + roles list, transitive
membership editor, per-table GRANT/REVOKE checkbox matrix, verified live
end-to-end. Built-in roles (`anon`/`authenticated`/`service_role`): a
read-only section sourced from `RESERVED_ROLES` in `api.js`, mirroring the
engine's own constant — no delete/grants/membership controls, since
`require_grantee` rejects them as a target. `api.js` gained
`getAuthzSnapshot`, `RESERVED_ROLES`. Column-level grants: see G2 above, not
built this round.

### G4 — API-docs panel — SHIPPED (item 123, C1+C3)
Shipped as `src/lib/ApiDocsPanel.svelte`, built directly against
`src/server/rest_resource.rs`. Confirmed from source: `GET /rest/v1` sits
under the same `require_jwt` layer as every data route (not public), and
every `/rest/v1/<table>` response reuses `POST /sql`'s `ExecResult` JSON
shape (`{type:'rows',columns,rows}` etc.), not a bare PostgREST array.

- **Schema viewer**: per-table columns from `GET /rest/v1`'s
  `components.schemas`.
- **Request snippets**: copy-paste curl for list/filtered/insert/update/
  delete, using a `$TOKEN` shell-variable placeholder rather than embedding
  a real token in a copyable block.
- **Live GET explorer**: `select=`/filter (`eq/neq/gt/gte/lt/lte/like/ilike/
  in/is`)/`order=`/`limit`/`offset`, executing real requests. Verified live:
  a filtered query round-tripped correctly and matched a hand-built curl
  equivalent.
- Mutating (POST/PATCH/DELETE) requests are snippets only — matches what was
  asked for.
- **Bug found and fixed on the Studio side** (not an engine change):
  `GET /rest/v1`'s `x-primary-key` extension only covers a table-level
  `PRIMARY KEY (...)` constraint, missing the common column-level
  `id BIGINT PRIMARY KEY` form. Each column's own `description: "primary
  key"` is set correctly either way, so `columnsFor()` unions both signals.
- `api.js` gained `getRestOpenApi`, `restGet`.
- **Embedded resource expansion, done this session (item 123, C2, PR #227):**
  forward (many-to-one) and reverse (one-to-many) `name(col,col,...)` embeds
  in both the request-snippet builder and the live GET explorer. Embed
  options are derived from REAL foreign-key metadata — the same
  `relationships` array `App.svelte`'s `getSchema()` already loads for the
  Schema ERD (now passed down as a prop), not guessed or hardcoded. When two
  forward FKs on one table target the same table (bare-name alias would be
  `400 AMBIGUOUS_RELATIONSHIP`), the alias falls back to the FK column's own
  name (or that column with a trailing `_id` stripped) — the alternate form
  C2 documents. Verified live: `orders?select=customers(id,name)` correctly
  nested each order's real customer object; `customers?select=orders(id,total)`
  correctly nested each customer's real order array.

### GraphQL explorer — NEW, FULLY LIVE (item 130, Workstream C4, PR #232)
Shipped as `src/lib/GraphqlPanel.svelte`, a new sixth panel/tab. Built
against `POST /graphql` — schema-derived, read-only (v1), mounted under the
same `require_jwt` layer as every other data-plane route and resolving every
field through the identical enforced `/sql`/`/rest/v1` path (same RLS/
grants, no parallel policy engine — confirmed against `src/server/graphql.rs`
and REST_API.md's "C4 — GraphQL" section).

- **Schema browser**: a standard GraphQL introspection query (hand-written —
  this project has zero runtime dependencies beyond Svelte, so no
  `graphql-js` helper) renders root query fields and every object type's
  fields, each annotated with real relationship kind (forward FK / reverse
  FK / graph edges) derived from the introspected types themselves, not
  guessed.
- **Differentiators callout**: explicitly surfaces the two fields a
  relational-only Supabase/pg_graphql stack doesn't have — `edges(type,
  direction)` graph traversal (any table with a single `Int64` PK) and root
  `near_<table>(vector, k)` vector similarity (any table with a `VECTOR`
  column) — listing which real tables in the connected schema qualify for
  each, or an honest "none on this schema yet" when neither applies.
- **Starter queries**: clicking a root field or a type's "edges" row
  generates a real, runnable query using that field/type's actual scalar
  columns (never fabricated column names) and drops it straight into the
  query editor.
- **Query editor**: POSTs `{query, variables}` to `/graphql` and renders the
  real `{data, errors}` envelope — a GraphQL-level error (e.g.
  `PERMISSION_DENIED`) is data, not a thrown exception, so it renders
  alongside any partial `data` rather than replacing the panel with an error
  state.
- `api.js` gained `graphqlRequest`, `getGraphqlSchema`.
- Verified live end-to-end: schema loaded against a real `customers`/`orders`
  schema (FK `orders.customer_id → customers.id`); root-field starter query
  for `orders` ran and returned real rows; the `customers` type's
  `edges`-starter query ran (empty `edges: []` array — correct, since no
  `POST /edges` writes had been made against this test schema); the
  `orders` reverse-FK field and `edges` field both showed with correct
  badges on the `customers` type detail view.

### Storage panel — authorization surface added (item 120, F1)
`src/lib/StoragePanel.svelte` / `api.js` updated for the newly-enforced
per-object model, plus one pre-existing Studio bug fixed along the way:

- **Bug found and fixed:** `createBucket` sent `{ name, public: isPublic }`
  in the request body, and the bucket list read `b.public` — but the wire
  field has always been `is_public` (`CreateBucketRequest`/`BucketDto` in
  `src/server/storage.rs`). The public-bucket checkbox has silently never
  worked (every bucket was created private regardless of the checkbox, and
  the list badge never reflected reality). Fixed both sides.
- **Public/private badge** on every bucket (sidebar) and the selected bucket
  (toolbar), sourced from `is_public` — real data, not inferred.
- **Object owner column** in the browser table, sourced from `ObjectDto`'s
  new `owner` field (`—` for a pre-F1 object with no owner recorded).
- **Authorization note** under the toolbar, worded per the bucket's actual
  `is_public` value (not generic boilerplate): explains that a private
  bucket's listing is already filtered (unreadable objects are absent, not
  shown-then-blocked) and that writes/deletes stay owner-only regardless of
  bucket visibility.
- **403 `STORAGE_FORBIDDEN` handling**: `uploadObject`'s `XMLHttpRequest`
  path now parses the JSON error body for a real `code`/`message` instead of
  a bare status code; a shared `friendlyStorageError()` prefixes an
  explanation for that specific code (derived from the real code, not
  invented) on upload/delete/copy-URL/download failures.
- Verified live end-to-end with two users against a private and a public
  bucket: superuser upload → owner shows correctly; a second user's listing
  of the private bucket correctly omits the object (F1's silent-filter
  behavior, not a 403 on list); that user's attempt to overwrite the same
  key correctly 403s with the friendlier message.

## Sequencing

- **Done, prior session:** all four original Workstream-G panels fully live,
  plus the Storage panel's F1 authorization surface.
- **Done, this session (PR #227–#234):** the deferred G4 embedded-resources
  example (C2), TOTP MFA in G1 (D4), OAuth social login in G1 (D1), and a
  brand-new GraphQL explorer panel (C4). No feature-detect stubs remain in
  any of the six panels.
- **Available but not requested:** column-level grants UI in the Roles tab
  (item 112/B5); GraphQL mutations/subscriptions/aggregations (explicitly
  out of the engine's v1 GraphQL scope per REST_API.md, not a Studio gap).
- **Deliberately not built, documented as a decision (not a silent gap):**
  QR-code rendering for MFA enrollment — see `AuthPanel.svelte`'s header
  comment for the full reasoning (unverifiable hand-rolled QR encoder vs.
  leaking the TOTP secret to a third-party image API; both rejected). The
  secret and `otpauth://` URI are shown instead, both copy-able for manual
  entry.
- **Filed as engine bugs earlier, now fixed upstream (PR #238, item 135):**
  the two `unidb-server-full`-specific bugs at the top of this doc (memory
  storage backend unreachable; auth routes 500 due to missing `ConnectInfo`
  wiring). Re-verified live this session against the rebuilt binary — see
  the correction note near the top of this doc.

## Conventions
- Pure static SPA, no backend of its own — every action is a `fetch` against
  a reachable `unidb-server` (see `README.md`). Build strictly against the
  engine's real contract — prefer reading source over docs when the two
  disagree, and say so; never assume an undocumented, uncoded route.
  Degrade gracefully when a route or catalog column is absent (as
  `TablesSidebar` already does for pre-M18 servers), so the Studio keeps
  working against older engines.
- Where an engine capability is genuinely absent, or its presence can't be
  known without a live probe, the UI shows an explicit status — never a
  fabricated value or a control that silently does nothing.
- When live-verifying against a reference binary turns up a bug in that
  binary (not in the contract itself), a throwaway local patch used only to
  unblock verification is fine — as long as it's never committed or pushed
  to a read-only-for-this-workstream repo, and the bug is reported instead
  of silently worked around in the Studio.
