// Thin client for the unidb REST API. This is the ONLY module that knows the
// wire contract (../unidb/docs/REST_API.md). Components speak in terms of the
// normalized shapes returned here, never raw fetch responses.

import { buildCatalogSchema } from './schema.js';
import { recordQuery, detectKind } from './queryStore.js';

const ENV = import.meta.env ?? {};
const RAW_URL = ENV.VITE_UNIDB_URL ?? '';

// Trailing slash would double up when we append paths.
export const BASE_URL = RAW_URL.replace(/\/+$/, '');
export const IS_CONFIGURED = BASE_URL.length > 0;

// The bearer token starts from the build-time env but is mutable at runtime so
// the header's "Generate token" flow (dev only) can apply a fresh one without
// a rebuild. All requests read it through here.
let token = (ENV.VITE_UNIDB_TOKEN ?? '').trim();

export function getToken() {
  return token;
}

export function setToken(t) {
  token = (t ?? '').trim();
}

// A normalized error the UI can render uniformly: always has {message, code}.
// `code` mirrors the machine-readable codes in REST_API.md's error table, or a
// synthetic one for transport/config failures that never reach the server.
export class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'ApiError';
    this.code = code ?? 'UNKNOWN';
    this.status = status ?? 0;
  }
}

function authHeaders(extra = {}) {
  const h = { ...extra };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

// Parse a non-2xx response into an ApiError. Every unidb error body is
// { "error", "code" }; fall back gracefully if the body isn't that shape.
async function toApiError(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body (e.g. a proxy 502) */
  }
  const message = body?.error ?? res.statusText ?? `HTTP ${res.status}`;
  const code = body?.code ?? `HTTP_${res.status}`;
  return new ApiError(message, code, res.status);
}

// Turn a fetch/network failure (CORS, DNS, connection refused, no config)
// into the same ApiError shape so callers have one catch path.
function transportError(err) {
  if (!IS_CONFIGURED) {
    return new ApiError(
      'VITE_UNIDB_URL is not set — copy .env.example to .env.local and point it at a running unidb-server.',
      'NOT_CONFIGURED',
    );
  }
  return new ApiError(
    `Could not reach ${BASE_URL}: ${err?.message ?? err}. Is unidb-server running and CORS-enabled?`,
    'NETWORK_ERROR',
  );
}

/**
 * POST /sql. Returns { results, roundTripMs } where `results` is the array of
 * per-statement ExecResult objects. `roundTripMs` is the client-measured wall
 * time around the fetch (performance.now) — the honest "how long did the whole
 * request take from the browser" number, NOT server execution time.
 *
 * @param {string} sql
 * @param {Array<*>} [params] positional $n bind values
 */
export async function runSql(sql, params = [], { txnId = null } = {}) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));

  const body = { sql };
  if (params && params.length) body.params = params;

  // Inside a session, carry the X-Txn-Id header so the statement runs in that
  // transaction (no auto-commit) instead of as a one-shot request.
  const headers = authHeaders({ 'Content-Type': 'application/json' });
  if (txnId != null) headers['X-Txn-Id'] = String(txnId);

  const start = performance.now();
  let res;
  try {
    res = await fetch(`${BASE_URL}/sql`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw transportError(err);
  }
  const roundTripMs = performance.now() - start;

  if (!res.ok) {
    const err = await toApiError(res);
    recordQuery(sql, roundTripMs, 'error', 0, detectKind(sql));
    throw err;
  }

  const payload = await res.json();
  const rowCount = (payload.results ?? []).reduce((s, r) => s + (r.rows?.length ?? 0), 0);
  recordQuery(sql, roundTripMs, 'ok', rowCount, detectKind(sql));
  return { results: payload.results ?? [], roundTripMs };
}

/**
 * GET /tables — catalog introspection. Newly added route; if the server
 * doesn't have it yet it 404s, and we degrade to `{ tables: [], supported:
 * false }` rather than throwing, so the rest of the UI still works.
 *
 * @returns {Promise<{tables: Array, supported: boolean}>}
 */
export async function getTables() {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));

  let res;
  try {
    res = await fetch(`${BASE_URL}/tables`, { headers: authHeaders() });
  } catch (err) {
    throw transportError(err);
  }

  if (res.status === 404) return { tables: [], supported: false };
  if (!res.ok) throw await toApiError(res);

  const data = await res.json();
  // Contract: [{ name, columns: [{ name, type, nullable, index }] }].
  // Some servers may wrap it as { tables: [...] }; accept either.
  const tables = Array.isArray(data) ? data : (data?.tables ?? []);
  return { tables, supported: true };
}

// ---- server cursors (R4) -----------------------------------------------
// Open a cursor over a single rows-producing statement (SELECT/CTE/EXPLAIN).
// Returns { cursorId, columns, rowCount }. Page it with cursorPage / close it
// with cursorClose. This bounds each response instead of one giant JSON array.
export async function runSqlCursor(sql, params = []) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  const body = { sql, cursor: true };
  if (params && params.length) body.params = params;
  let res;
  try {
    res = await fetch(`${BASE_URL}/sql`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
  const d = await res.json();
  return { cursorId: d.cursor_id, columns: d.columns ?? [], rowCount: d.row_count ?? null };
}

/** Fetch one page of a cursor. Returns { columns, rows, done, remaining }. */
export async function cursorPage(cursorId, limit = 200) {
  let res;
  try {
    res = await fetch(`${BASE_URL}/sql/cursor/${cursorId}?limit=${limit}`, { headers: authHeaders() });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
  const d = await res.json();
  return { columns: d.columns ?? [], rows: d.rows ?? [], done: !!d.done, remaining: d.remaining ?? 0 };
}

/** Drop a cursor early. Best-effort (ignores errors). */
export async function cursorClose(cursorId) {
  try {
    await fetch(`${BASE_URL}/sql/cursor/${cursorId}`, { method: 'DELETE', headers: authHeaders() });
  } catch {
    /* best-effort */
  }
}

// ---- transaction sessions (R1) -----------------------------------------
async function txnPost(path, body) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: authHeaders(body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
  return res.json();
}

/** Begin a session transaction. Returns { txnId, isolation, expiresAt }. */
export async function txnBegin(isolation = 'read_committed') {
  const data = await txnPost('/txn/begin', { isolation });
  return { txnId: data.txn_id ?? data.xid, isolation: data.isolation, expiresAt: data.expires_at };
}
/** Commit a session. Returns { txnId, state }. */
export async function txnCommit(txnId) {
  const data = await txnPost(`/txn/${txnId}/commit`, null);
  return { txnId: data.txn_id, state: data.state };
}
/** Roll back a session. Returns { txnId, state }. */
export async function txnRollback(txnId) {
  const data = await txnPost(`/txn/${txnId}/rollback`, null);
  return { txnId: data.txn_id, state: data.state };
}

// Run a single catalog SELECT and return its rows as array-of-objects, zipping
// the result's `columns` names against each row's positional values.
async function catalogRows(sql) {
  const { results } = await runSql(sql);
  const r = results.find((x) => x.type === 'rows') ?? { columns: [], rows: [] };
  const cols = r.columns ?? [];
  return (r.rows ?? []).map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

// Error codes that mean "this server predates the Milestone 18 catalog" — the
// introspection relations don't exist, so we degrade to inference/demo rather
// than surfacing a hard error. Transport/auth failures still propagate.
const CATALOG_ABSENT_CODES = new Set([
  'TABLE_NOT_FOUND',
  'SQL_UNSUPPORTED',
  'SQL_PARSE_ERROR',
  'HTTP_404',
  'HTTP_400',
]);

/**
 * Full-database schema for the visualizer — every table's columns PLUS real
 * primary keys and foreign-key relationships. Sourced from the engine's
 * Milestone-18 system catalog by SELECTing over `POST /sql` (there is NO
 * `GET /schema` route by design — the engine ships a generic queryable catalog,
 * not app-shaped REST). See `../unidb/docs/engine_access_guide.md` §4.
 *
 *   - catalog present -> { tables, relationships, supported: true } with REAL FKs.
 *   - pre-M18 server  -> { supported: false }; caller falls back to inference/demo.
 *
 * `tables` matches the /tables shape (name, columns[{name,type,nullable,index,
 * primaryKey}], primaryKey[]); `relationships` are real, composite-key aware.
 *
 * @returns {Promise<{tables: Array, relationships: Array, supported: boolean}>}
 */
export async function getSchema() {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));

  // Probe with the columns query; its failure tells us the catalog is absent.
  let colRows;
  try {
    colRows = await catalogRows(
      `SELECT table_name, column_name, data_type, is_nullable, ordinal_position, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public'`,
    );
  } catch (e) {
    if (CATALOG_ABSENT_CODES.has(e.code)) {
      return { tables: [], relationships: [], supported: false };
    }
    throw e;
  }

  // Enrichment queries are best-effort: a failure here still yields tables +
  // columns (just without indexes / a primary key / an edge).
  const [idxRows, pkRows, fkRows] = await Promise.all([
    catalogRows(
      `SELECT table_name, column_name, index_type, is_unique FROM unidb_catalog.indexes`,
    ).catch(() => []),
    catalogRows(
      `SELECT tc.table_name AS table_name, kcu.column_name AS column_name,
              kcu.ordinal_position AS ordinal_position
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
       WHERE tc.constraint_type = 'PRIMARY KEY'`,
    ).catch(() => []),
    // Real foreign keys — the access guide's 4-way ON-form join (unidb has no
    // JOIN USING). The composite-key alignment conjunct pairs each FK column
    // with its referenced column.
    catalogRows(
      `SELECT tc.constraint_name AS constraint_name,
              tc.table_name  AS from_table, kcu.column_name AS from_col,
              kcu.ordinal_position AS from_pos,
              ccu.table_name AS to_table,   ccu.column_name AS to_col
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
       JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name
       JOIN information_schema.key_column_usage ccu ON ccu.constraint_name = rc.unique_constraint_name
             AND ccu.ordinal_position = kcu.position_in_unique_constraint
       WHERE tc.constraint_type = 'FOREIGN KEY'`,
    ).catch(() => []),
  ]);

  const { tables, relationships } = buildCatalogSchema(colRows, idxRows, pkRows, fkRows);
  return { tables, relationships, supported: true };
}

// ---- auto REST API (item 123, C1) — API-docs panel (G4) -------------------
// GET/POST/PATCH/DELETE /rest/v1/<table> + GET /rest/v1 (catalog-derived
// OpenAPI 3 doc). Verified against src/server/rest_resource.rs on unidb main
// (PR #223) rather than docs/REST_API.md, which does not yet document this
// route at all despite the code shipping — a real doc-staleness gap, flagged
// in AUTH_POLICY_PANELS_PLAN.md rather than guessed around. Confirmed from
// source, not assumed:
//   - GET /rest/v1 (the OpenAPI doc) sits under the same require_jwt layer
//     as every other data-plane route — NOT public — so it needs the bearer
//     token like any other authenticated fetch here.
//   - Every response reuses POST /sql's ExecResult JSON shape, not a bare
//     PostgREST-style array of row objects: GET -> {type:'rows', columns,
//     rows}; POST -> {type:'inserted', count}; PATCH -> {type:'updated',
//     count}; DELETE -> {type:'deleted', count}.
//   - Filter operators are exactly eq/neq/gt/gte/lt/lte/like/ilike/in/is
//     (fixed allow-list, rest_resource.rs::parse_op) — `select=`, `order=
//     col.asc|col.desc` (comma-separated), `limit=`, `offset=`.

/**
 * GET /rest/v1 — catalog-derived OpenAPI 3 document (item 123, C3).
 * Degrades to `{ supported: false, doc: null }` on a pre-item-123 server
 * (404) rather than throwing, so the panel can show a clear empty state.
 */
export async function getRestOpenApi() {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/rest/v1`, { headers: authHeaders() });
  } catch (err) {
    throw transportError(err);
  }
  if (res.status === 404) return { supported: false, doc: null };
  if (!res.ok) throw await toApiError(res);
  return { supported: true, doc: await res.json() };
}

/**
 * GET /rest/v1/<table>?select=...&<filters>&order=...&limit=...&offset=...
 * `filterParams` is an array of `[column, "<op>.<value>"]` pairs — already
 * formatted by the caller (the op/value encoding is filter-shape-specific,
 * e.g. `in` wraps its value in parens, `is` takes a bare null/true/false —
 * kept in the component next to the filter-builder UI, mirroring how
 * RolesPanel/PoliciesPanel build their own SQL text next to their forms).
 *
 * @param {string} table
 * @param {{select?:string, filterParams?:Array<[string,string]>, order?:string, limit?:number, offset?:number}} [opts]
 * @returns {Promise<{result:object, url:string}>} `result` is the raw
 *   `{type:'rows', columns, rows}` body — pass straight to ResultsGrid.
 */
export async function restGet(table, opts = {}) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  const qs = new URLSearchParams();
  if (opts.select) qs.set('select', opts.select);
  for (const [col, opValue] of opts.filterParams ?? []) qs.append(col, opValue);
  if (opts.order) qs.set('order', opts.order);
  if (opts.limit != null) qs.set('limit', String(opts.limit));
  if (opts.offset != null) qs.set('offset', String(opts.offset));
  const query = qs.toString();
  const url = `${BASE_URL}/rest/v1/${encodeURIComponent(table)}${query ? `?${query}` : ''}`;

  const start = performance.now();
  let res;
  try {
    res = await fetch(url, { headers: authHeaders() });
  } catch (err) {
    throw transportError(err);
  }
  const roundTripMs = performance.now() - start;
  if (!res.ok) throw await toApiError(res);
  return { result: await res.json(), url, roundTripMs };
}

// ---- authorization: roles, users, grants (item 24 + item 122 B3) --------
// The three built-in roles (item 122, B3 — Supabase convention). Verified
// against unidb's src/authz/mod.rs::RESERVED_ROLES: `anon` (no verified JWT
// subject), `authenticated` (any verified subject, plus granted roles), and
// `service_role` (token claims carry `"role":"service_role"` — bypasses RLS
// like a superuser, on the audited path). They are assigned automatically by
// the engine and are NEVER rows in `unidb_catalog.roles` — `CREATE ROLE`/
// `DROP ROLE` reject these names, and `GRANT ... TO <reserved>` /
// `GRANT <reserved> TO <user>` both fail too (`require_grantee` only accepts
// a known user or a row in `unidb_catalog.roles`). They ARE valid as a
// `CREATE POLICY ... TO <role>` target. This constant is therefore real,
// documented engine behavior — not a fabricated value.
export const RESERVED_ROLES = ['anon', 'authenticated', 'service_role'];

// ---- authorization: roles, users, grants (item 24) -----------------------
/**
 * Snapshot of the authorization catalog backing the Roles/Grants panel (G3):
 * users, roles, table-level grants, and role memberships — the four
 * `unidb_catalog.*` virtual relations item 24 ships (see
 * ../unidb/docs/REST_API.md#authorization--roles-grants-and-rls-item-24).
 * Degrades to `{ supported: false }` on a pre-item-24 server (the relations
 * don't exist yet), same pattern as `getSchema`.
 *
 * @returns {Promise<{supported:boolean, users:Array<{name,isSuperuser}>,
 *   roles:Array<string>, grants:Array<{grantee,table,op}>,
 *   roleMembers:Array<{role,member}>}>}
 */
export async function getAuthzSnapshot() {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));

  let userRows;
  try {
    userRows = await catalogRows('SELECT name, is_superuser FROM unidb_catalog.users ORDER BY name');
  } catch (e) {
    if (CATALOG_ABSENT_CODES.has(e.code)) {
      return { supported: false, users: [], roles: [], grants: [], roleMembers: [] };
    }
    throw e;
  }

  const [roleRows, grantRows, memberRows] = await Promise.all([
    catalogRows('SELECT name FROM unidb_catalog.roles ORDER BY name'),
    // `role` is the grants relation's column name for the grantee (user or role).
    catalogRows('SELECT role, table_name, operation FROM unidb_catalog.grants'),
    catalogRows('SELECT role, member FROM unidb_catalog.role_members'),
  ]);

  return {
    supported: true,
    users: userRows.map((u) => ({ name: u.name, isSuperuser: !!u.is_superuser })),
    roles: roleRows.map((r) => r.name),
    grants: grantRows.map((g) => ({ grantee: g.role, table: g.table_name, op: g.operation })),
    roleMembers: memberRows.map((m) => ({ role: m.role, member: m.member })),
  };
}

// ---- row-level security policies (item 24 Z1/R-a; G2 Policies editor) ----
/**
 * `unidb_catalog.policies` — every named RLS policy across every table.
 * Columns: name, table_name, operation, using_expr, with_check_expr, enforced.
 * Degrades to `{ supported: false }` on a pre-item-24 server.
 */
// `target_roles` on `unidb_catalog.policies` shipped in PR #225 (item 4):
// a comma-joined, alphabetically-sorted role list, or the literal `"*"` for
// a policy with no `TO` clause (applies to every caller) — verified against
// `src/sql/information_schema.rs::policies_rows` on unidb main. Still
// feature-detected (not assumed) so the Studio keeps working against an
// older server that predates this column: the widened `SELECT` is tried
// first, and a confirmed `COLUMN_NOT_FOUND` is remembered for the session
// rather than re-probed on every load.
let targetRolesColumnKnownAbsent = false;

function normalizeTargetRoles(raw) {
  if (raw == null || raw === '' || raw === '*') return [];
  if (Array.isArray(raw)) return raw;
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

export async function listPolicies() {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  const baseCols = 'name, table_name, operation, using_expr, with_check_expr, enforced';
  const withTargetRoles = !targetRolesColumnKnownAbsent;

  async function query(includeTargetRoles) {
    const cols = includeTargetRoles ? `${baseCols}, target_roles` : baseCols;
    return catalogRows(`SELECT ${cols} FROM unidb_catalog.policies ORDER BY table_name, name`);
  }

  let rows;
  let hasTargetRoles = withTargetRoles;
  try {
    rows = await query(withTargetRoles);
  } catch (e) {
    if (withTargetRoles && e.code === 'COLUMN_NOT_FOUND') {
      // Confirmed absent this session — remember it so every subsequent
      // load skips straight to the fallback query instead of re-probing.
      targetRolesColumnKnownAbsent = true;
      hasTargetRoles = false;
      try {
        rows = await query(false);
      } catch (e2) {
        if (CATALOG_ABSENT_CODES.has(e2.code)) return { supported: false, policies: [] };
        throw e2;
      }
    } else if (CATALOG_ABSENT_CODES.has(e.code)) {
      return { supported: false, policies: [] };
    } else {
      throw e;
    }
  }

  return {
    supported: true,
    // Whether `target_roles` was actually readable this call — lets the UI
    // show its "engine doesn't expose this yet" notice precisely, including
    // when the policy list itself is empty (where per-row `null` gives no
    // signal either way).
    targetRolesSupported: hasTargetRoles,
    policies: rows.map((r) => ({
      name: r.name,
      table: r.table_name,
      op: r.operation,
      usingExpr: r.using_expr,
      withCheckExpr: r.with_check_expr,
      enforced: !!r.enforced,
      // `null` = engine doesn't expose this yet (show "(all roles)", not a
      // false claim of zero scoping); `[]` = column present, genuinely unscoped.
      targetRoles: hasTargetRoles ? normalizeTargetRoles(r.target_roles) : null,
    })),
  };
}

/**
 * POST /auth/preview (item-24 Z6) — run `sql` as though authenticated as
 * `asRole`, so an admin can see exactly which rows that role's RLS policies
 * let through. Superuser-only on the server; a non-superuser caller gets a
 * normal ApiError the UI can surface.
 *
 * @returns {Promise<{columns:Array<string>, rows:Array<Array<*>>}>}
 */
export async function previewAsRole(asRole, sql) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/auth/preview`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ as_role: asRole, sql }),
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
  const j = await res.json();
  return { columns: j.columns ?? [], rows: j.rows ?? [] };
}

// EXPLAIN ANALYZE returns a `rows` result: one single-string column per plan
// line, with a trailing `execution_time_ms=<n>` line under ANALYZE. Pull that
// number out — it's the true SERVER execution time, distinct from round-trip.
function parseExecMs(rowsResult) {
  const rows = rowsResult?.rows ?? [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const cell = rows[i]?.[0];
    if (typeof cell !== 'string') continue;
    const m = cell.match(/execution_time_ms\s*=\s*([0-9.]+)/i);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Run `EXPLAIN ANALYZE <sql>` and return { serverMs, planLines } — the
 * server-measured execution time plus the raw plan text. Only meaningful for
 * read queries; callers gate this to SELECT/WITH statements.
 */
export async function explainAnalyze(sql, params = []) {
  const { results } = await runSql(`EXPLAIN ANALYZE ${sql}`, params);
  const rowsResult = results.find((r) => r.type === 'rows');
  const planLines = (rowsResult?.rows ?? []).map((r) => r[0]);
  return { serverMs: parseExecMs(rowsResult), planLines };
}

/**
 * Run `EXPLAIN <sql>` (plan only, no execution) and return the plan lines. Each
 * line is one string in the single-column `QUERY PLAN` result, already indented
 * by the engine to show the operator tree.
 */
export async function explain(sql, params = []) {
  const { results } = await runSql(`EXPLAIN ${sql}`, params);
  const rowsResult = results.find((r) => r.type === 'rows');
  return (rowsResult?.rows ?? []).map((r) => r[0]);
}

// Is this SQL a single read query we can safely EXPLAIN ANALYZE? (EXPLAIN
// ANALYZE actually executes, so we only run it on read-only shapes, and only
// when there's a single statement.)
export function isSingleSelect(sql) {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (trimmed.includes(';')) return false; // multiple statements
  return /^(select|with)\b/i.test(trimmed);
}

// ---- auth discovery / identity (item 100) --------------------------------
/**
 * GET /auth/meta — public discovery endpoint (item 100), now also reporting
 * `signup_enabled` (item 121 A3). Degrades to `{ supported: false }` on a
 * very old pre-item-100 server.
 */
export async function getAuthMeta() {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/auth/meta`);
  } catch (err) {
    throw transportError(err);
  }
  if (res.status === 404) return { supported: false };
  if (!res.ok) throw await toApiError(res);
  return { supported: true, ...(await res.json()) };
}

/**
 * GET /auth/whoami — the caller's own identity/privileges (item 100).
 * Requires a valid JWT; degrades to `{ supported: false }` on a server that
 * predates the route.
 */
export async function getWhoami() {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/auth/whoami`, { headers: authHeaders() });
  } catch (err) {
    throw transportError(err);
  }
  if (res.status === 404) return { supported: false };
  if (!res.ok) throw await toApiError(res);
  return { supported: true, ...(await res.json()) };
}

// ---- credentialed auth flows (item 121, A1–A4; merged via PR #222) -------
// POST /auth/{login,signup,refresh} all return the same shape:
// { token, access_token, refresh_token, expires_in }. `token` is a
// deprecated alias for `access_token`, kept only for pre-A4 clients — we
// read `access_token`/`refresh_token` directly. The refresh token is opaque
// (NOT a JWT); per REST_API.md it is meant to be stored client-side and
// exchanged at /auth/refresh / revoked at /auth/logout, so callers keep it
// in memory (component state) — this module never persists it.
async function authFlowPost(path, body) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
  const j = await res.json();
  return { accessToken: j.access_token ?? j.token, refreshToken: j.refresh_token, expiresIn: j.expires_in };
}

/** POST /auth/login — password login (item 121 A1/A2). */
export async function authLogin(username, password) {
  return authFlowPost('/auth/login', { username, password });
}

/**
 * POST /auth/signup — self-service signup (item 121 A3). 404s when the
 * server hasn't set UNIDB_ALLOW_SIGNUP=1 (see GET /auth/meta's
 * `signup_enabled`, which the panel checks before offering this).
 */
export async function authSignup(username, password) {
  return authFlowPost('/auth/signup', { username, password });
}

/** POST /auth/refresh — exchange a refresh token for a new access+refresh pair (item 121 A4). */
export async function authRefresh(refreshToken) {
  return authFlowPost('/auth/refresh', { refresh_token: refreshToken });
}

/**
 * POST /auth/logout — revoke a refresh-token session (item 121 A4).
 * Idempotent: 204 even for an unknown/already-revoked token.
 */
export async function authLogout(refreshToken) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
}

// ---- active sessions (item 4; G1 "active sessions" panel) ----------------
/**
 * `unidb_catalog.sessions` — one row per refresh-token session (item 4,
 * shipped PR #225). Columns: session_id, username, created_at, expires_at
 * (both epoch **seconds** — verified against `authz::now_secs()` on unidb
 * main, not milliseconds like the storage timestamps), revoked. Never the
 * raw refresh token or its hash. Visibility mirrors item 111: a superuser
 * (or open/bootstrap mode) sees every session; a named non-superuser sees
 * only their own. Degrades to `{ supported: false }` on a pre-item-4 server.
 */
export async function listSessions() {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  try {
    const rows = await catalogRows(
      `SELECT session_id, username, created_at, expires_at, revoked
       FROM unidb_catalog.sessions ORDER BY created_at DESC`,
    );
    return {
      supported: true,
      sessions: rows.map((r) => ({
        sessionId: r.session_id,
        username: r.username,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        revoked: !!r.revoked,
      })),
    };
  } catch (e) {
    if (CATALOG_ABSENT_CODES.has(e.code)) return { supported: false, sessions: [] };
    throw e;
  }
}

/**
 * DELETE /auth/sessions/{id} — revoke one session by its opaque session_id
 * (item 4). Self/superuser gated server-side; idempotent and always 204
 * (unknown id or someone else's session are both a silent no-op, by design —
 * see REST_API.md).
 */
export async function revokeSession(sessionId) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/auth/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
}

// ---- observability (item 21) --------------------------------------------
/**
 * GET /stats — the `EngineStats` activity snapshot (per-statement latency,
 * WAL-fsync cost, buffer-pool efficiency, lock contention, the vacuum-horizon
 * gauge, per-table pages, worker governance, server sessions). Poll it for the
 * Observability tab. Degrades to `{ supported: false }` on a pre-item-21 server
 * that lacks the route, so the tab can show a hint instead of throwing.
 *
 * @returns {Promise<{stats: object|null, supported: boolean}>}
 */
export async function getStats() {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));

  let res;
  try {
    res = await fetch(`${BASE_URL}/stats`, { headers: authHeaders() });
  } catch (err) {
    throw transportError(err);
  }

  if (res.status === 404) return { stats: null, supported: false };
  if (!res.ok) throw await toApiError(res);

  return { stats: await res.json(), supported: true };
}

// ---- logs surface (item 22) ---------------------------------------------
/**
 * GET /logs — a bounded, cursor-paged, newest-first tail over the server's
 * rotated JSON log files. Superuser-gated on the server. All filters optional;
 * `limit` is clamped to 500 server-side.
 *
 * @param {{level?:string, since?:string, until?:string, q?:string,
 *          cursor?:string, limit?:number}} [opts]
 * @returns {Promise<{logs:Array, returned:number, scanned:number,
 *          truncated:boolean, next_cursor:(string|null), supported:boolean}>}
 */
export async function getLogs(opts = {}) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));

  const qs = new URLSearchParams();
  for (const k of ['level', 'since', 'until', 'q', 'cursor', 'limit']) {
    const v = opts[k];
    if (v != null && v !== '') qs.set(k, String(v));
  }
  const query = qs.toString();

  let res;
  try {
    res = await fetch(`${BASE_URL}/logs${query ? `?${query}` : ''}`, {
      headers: authHeaders(),
    });
  } catch (err) {
    throw transportError(err);
  }

  if (res.status === 404) return { logs: [], supported: false };
  if (!res.ok) throw await toApiError(res);

  const data = await res.json();
  return {
    logs: data.logs ?? [],
    returned: data.returned ?? 0,
    scanned: data.scanned ?? 0,
    truncated: data.truncated ?? false,
    next_cursor: data.next_cursor ?? null,
    supported: true,
  };
}

// ---- change-event stream (Milestone 20 + item 33) -----------------------

/** GET /tables/{table}/events → { enabled: bool }  (item 33) */
export async function getCdcStatus(table) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/tables/${encodeURIComponent(table)}/events`, {
      headers: authHeaders(),
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
  return res.json(); // { enabled: bool }
}

/** DELETE /tables/{table}/events — disable CDC on a table  (item 33) */
export async function disableTableEvents(table) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/tables/${encodeURIComponent(table)}/events`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
}

/** GET /events/head → { seq: N }  (item 33) */
export async function getEventsHead() {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/events/head`, { headers: authHeaders() });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
  return res.json(); // { seq: number }
}

/** POST /events/ack — durably advance a named consumer's offset  (item 33) */
export async function ackEvents(consumer, upToSeq) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/events/ack`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ consumer, up_to_seq: upToSeq }),
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
}

/**
 * GET /stats/history → { interval_ms, points: [{t, commits_per_sec,
 * wal_bytes_per_sec, active_transactions, bufferpool_hit_ratio, ...}] }
 * (item 34)
 */
export async function getStatsHistory({ points = 60, intervalMs = 5000 } = {}) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  const qs = new URLSearchParams({ points: String(points), interval_ms: String(intervalMs) });
  let res;
  try {
    res = await fetch(`${BASE_URL}/stats/history?${qs}`, { headers: authHeaders() });
  } catch (err) {
    throw transportError(err);
  }
  if (res.status === 404) return { interval_ms: intervalMs, points: [] };
  if (!res.ok) throw await toApiError(res);
  return res.json();
}

/**
 * Opt a table into event capture: POST /tables/{table}/events. Idempotent —
 * once enabled, every committed INSERT/UPDATE/DELETE also appends a change
 * event in the same commit.
 */
export async function enableTableEvents(table) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));

  let res;
  try {
    res = await fetch(`${BASE_URL}/tables/${encodeURIComponent(table)}/events`, {
      method: 'POST',
      headers: authHeaders(),
    });
  } catch (err) {
    throw transportError(err);
  }

  if (!res.ok) throw await toApiError(res);
}

/**
 * Open the ephemeral live-tail SSE stream (GET /events/subscribe with no
 * `consumer`): at-most-once browser tail, no durable offset written.
 *
 * We consume it with `fetch` + a ReadableStream reader rather than the native
 * `EventSource`, because EventSource cannot send an `Authorization` header and
 * every route except `/metrics` is Bearer-gated. This also lets us set the
 * `Last-Event-ID` resume header explicitly.
 *
 * @param {object} opts
 * @param {string} [opts.table]     filter to one table (`?table=`)
 * @param {number} [opts.fromSeq]   start strictly after this offset (`?from_seq=`)
 * @param {string} [opts.lastEventId] SSE reconnect cursor (wins over fromSeq)
 * @param {(evt:{seq:number,xid:number,table_name:string,op:string,payload:object})=>void} opts.onEvent
 * @param {(err:Error)=>void} [opts.onError]
 * @param {()=>void} [opts.onOpen]
 * @returns {{close:()=>void}} handle — call close() to abort the stream
 */
export function openEventStream({
  table,
  fromSeq,
  lastEventId,
  onEvent,
  onError,
  onOpen,
} = {}) {
  const controller = new AbortController();

  const qs = new URLSearchParams();
  if (table) qs.set('table', table);
  if (fromSeq != null) qs.set('from_seq', String(fromSeq));
  const query = qs.toString();

  const headers = authHeaders({ Accept: 'text/event-stream' });
  if (lastEventId != null) headers['Last-Event-ID'] = String(lastEventId);

  (async () => {
    let res;
    try {
      res = await fetch(`${BASE_URL}/events/subscribe${query ? `?${query}` : ''}`, {
        headers,
        signal: controller.signal,
      });
    } catch (err) {
      if (!controller.signal.aborted) onError?.(transportError(err));
      return;
    }
    if (!res.ok) {
      onError?.(await toApiError(res));
      return;
    }
    onOpen?.();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line.
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const parsed = parseSseFrame(frame);
          if (parsed?.data) {
            try {
              onEvent?.(JSON.parse(parsed.data));
            } catch {
              /* heartbeat/comment frame with non-JSON data — ignore */
            }
          }
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) onError?.(transportError(err));
    }
  })();

  return { close: () => controller.abort() };
}

// Parse one SSE frame (lines of `field: value`) into { id, event, data }.
// Comment lines (starting `:`) are heartbeats and yield no data.
function parseSseFrame(frame) {
  const out = { id: null, event: null, data: '' };
  const dataLines = [];
  for (const line of frame.split('\n')) {
    if (!line || line.startsWith(':')) continue; // heartbeat/comment
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
    if (field === 'id') out.id = value;
    else if (field === 'event') out.event = value;
    else if (field === 'data') dataLines.push(value);
  }
  out.data = dataLines.join('\n');
  return out;
}

// ── Storage (item 31; per-object authorization item 120/F1, PR #226) ─────────
// Routes: GET/POST /storage/buckets, DELETE /storage/buckets/{name},
//         GET /storage/{bucket}/objects, PUT/DELETE /storage/{bucket}/objects/{*key},
//         GET /storage/{bucket}/presign/{*key}
// Returns { supported: false } on 404 (pre-item-31 engine) or 503
// (item-31 engine with STORAGE_BACKEND not configured).
//
// F1: every object route now authorizes against the caller's identity —
// ownership (`created_by`/`owner`, stamped from the caller's JWT `sub` at
// PUT time), a bucket's `is_public` read-exemption, or a superuser/
// `service_role` bypass. Listing filters silently (never 403s); write/delete/
// presign 403 STORAGE_FORBIDDEN when the caller isn't the owner and no
// exemption applies — see REST_API.md's "Per-object authorization" section.
// This module doesn't re-implement any of that; it just surfaces the fields
// (`is_public`, `owner`) and lets a 403 propagate as a normal ApiError.

export async function listBuckets() {
  let res;
  try {
    res = await fetch(`${BASE_URL}/storage/buckets`, { headers: authHeaders() });
  } catch (e) { throw transportError(e); }
  // 404 = pre-item-31 engine; 503 = item-31 but storage not configured
  if (res.status === 404 || res.status === 503) return { supported: false, buckets: [] };
  if (!res.ok) throw await toApiError(res);
  const j = await res.json();
  return { supported: true, buckets: j.buckets ?? [] };
}

export async function createBucket(name, { isPublic = false } = {}) {
  const res = await fetch(`${BASE_URL}/storage/buckets`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    // Wire field is `is_public` (verified against src/server/storage.rs's
    // CreateBucketRequest on unidb main) — NOT `public`. Repeating
    // create_bucket for an existing name is a no-op and does not update
    // this flag (no route exists to change it after creation).
    body: JSON.stringify({ name, is_public: isPublic }),
  });
  if (!res.ok) throw await toApiError(res);
}

export async function deleteBucket(bucket) {
  const res = await fetch(`${BASE_URL}/storage/buckets/${encodeURIComponent(bucket)}`, {
    method: 'DELETE', headers: authHeaders(),
  });
  if (!res.ok) throw await toApiError(res);
}

export async function listObjects(bucket, prefix = '') {
  const qs = new URLSearchParams({ delimiter: '/' });
  if (prefix) qs.set('prefix', prefix);
  // Engine route: GET /storage/{bucket}/objects (no /buckets/ segment)
  const res = await fetch(
    `${BASE_URL}/storage/${encodeURIComponent(bucket)}/objects?${qs}`,
    { headers: authHeaders() },
  );
  if (!res.ok) throw await toApiError(res);
  const j = await res.json();
  // Engine returns object_key + created_at_ms; normalize to key + last_modified for the UI.
  const objects = (j.objects ?? []).map((o) => ({
    ...o,
    key: o.object_key,
    last_modified: o.created_at_ms != null ? new Date(o.created_at_ms).toISOString() : null,
  }));
  return { prefixes: j.prefixes ?? [], objects };
}

export async function uploadObject(bucket, key, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    // Engine route: PUT /storage/{bucket}/objects/{*key} — key may contain slashes,
    // so encode the bucket only and leave the key's slashes as literal path segments.
    xhr.open('PUT', `${BASE_URL}/storage/${encodeURIComponent(bucket)}/objects/${key}`);
    const h = authHeaders({ 'Content-Type': file.type || 'application/octet-stream' });
    Object.entries(h).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    if (onProgress) xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status < 300) { resolve(); return; }
      // F1 (item 120): overwriting another caller's object is a real,
      // expected 403 STORAGE_FORBIDDEN now — surface the server's own
      // message/code (same shape every other route's ApiError carries)
      // instead of a bare status code.
      let message = `Upload failed: ${xhr.status}`;
      let code = `HTTP_${xhr.status}`;
      try {
        const body = JSON.parse(xhr.responseText);
        if (body?.error) message = body.error;
        if (body?.code) code = body.code;
      } catch { /* non-JSON error body */ }
      const err = new Error(message);
      err.code = code;
      err.status = xhr.status;
      reject(err);
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(file);
  });
}

export async function deleteObject(bucket, key) {
  // Engine route: DELETE /storage/{bucket}/objects/{*key}
  const res = await fetch(
    `${BASE_URL}/storage/${encodeURIComponent(bucket)}/objects/${key}`,
    { method: 'DELETE', headers: authHeaders() },
  );
  if (!res.ok) throw await toApiError(res);
}

export async function getObjectUrl(bucket, key, expirySecs = 3600) {
  // Engine route: GET /storage/{bucket}/presign/{*key} — response: { presigned_get_url }
  const res = await fetch(
    `${BASE_URL}/storage/${encodeURIComponent(bucket)}/presign/${key}`,
    { headers: authHeaders() },
  );
  if (!res.ok) throw await toApiError(res);
  const j = await res.json();
  return j.presigned_get_url;
}
