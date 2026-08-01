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

// ── /rest/v1 with full Prefer control (item 139) + embed filter/order/limit/
// offset (item 136) ───────────────────────────────────────────────────────
// GET/POST/PATCH/DELETE /rest/v1/<table>, the Prefer header (`count=exact`
// on GET; `return=representation|minimal` on a mutation), extra raw query
// params (item 136's dotted `<embed>.<col>=<op>.<val>` / `<embed>.order=` /
// `<embed>.limit=` / `<embed>.offset=` params, which don't fit a fixed opts
// shape), and a JSON request body for POST/PATCH.
export async function restRequest(table, method, opts = {}) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  const qs = new URLSearchParams();
  if (opts.select) qs.set('select', opts.select);
  for (const [col, opValue] of opts.filterParams ?? []) qs.append(col, opValue);
  if (opts.order) qs.set('order', opts.order);
  if (opts.limit != null) qs.set('limit', String(opts.limit));
  if (opts.offset != null) qs.set('offset', String(opts.offset));
  // Item 136: dotted per-embed filter/order/limit/offset params — arbitrary
  // keys the fixed opts above don't model, so the caller (the embed-builder
  // UI) hands them over pre-formatted as [key, value] pairs.
  for (const [key, value] of opts.extraParams ?? []) qs.append(key, value);
  const query = qs.toString();
  const url = `${BASE_URL}/rest/v1/${encodeURIComponent(table)}${query ? `?${query}` : ''}`;

  const headers = authHeaders();
  // Item 139: Prefer is a comma-joined list of recognized preferences; the
  // server ignores anything it doesn't recognize rather than erroring, so
  // this never needs to feature-detect before sending it.
  const preferParts = [];
  if (opts.countExact) preferParts.push('count=exact');
  if (opts.return) preferParts.push(`return=${opts.return}`);
  if (preferParts.length) headers['Prefer'] = preferParts.join(', ');
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const start = performance.now();
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    throw transportError(err);
  }
  const roundTripMs = performance.now() - start;
  if (!res.ok) throw await toApiError(res);

  // `return=minimal` (POST 201 / PATCH+DELETE 204) and a plain DELETE with
  // no Prefer at all can both have an empty body — read as text first so
  // JSON.parse is only attempted when there's actually something to parse.
  const text = await res.text();
  const result = text ? JSON.parse(text) : null;
  return {
    result,
    url,
    roundTripMs,
    status: res.status,
    contentRange: res.headers.get('Content-Range'),
    preferenceApplied: res.headers.get('Preference-Applied'),
  };
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
  return res.json();
}

function toSession(j) {
  return { accessToken: j.access_token ?? j.token, refreshToken: j.refresh_token, expiresIn: j.expires_in };
}

/**
 * POST /auth/login — password login (item 121 A1/A2). When the user has
 * TOTP MFA enabled (item 127), the engine issues **no session** — instead
 * `{mfa_required: true, challenge, expires_in}` (5-minute TTL), redeemed via
 * `mfaChallenge()` below. The two response shapes are distinguished by the
 * presence of `mfa_required` (verified against REST_API.md's `POST
 * /auth/login` docs), so callers must check `.mfaRequired` before assuming
 * `.accessToken` is set.
 */
export async function authLogin(username, password) {
  const j = await authFlowPost('/auth/login', { username, password });
  if (j.mfa_required) return { mfaRequired: true, challenge: j.challenge, expiresIn: j.expires_in };
  return { mfaRequired: false, ...toSession(j) };
}

/**
 * POST /auth/signup — self-service signup (item 121 A3). 404s when the
 * server hasn't set UNIDB_ALLOW_SIGNUP=1 (see GET /auth/meta's
 * `signup_enabled`, which the panel checks before offering this).
 */
export async function authSignup(username, password) {
  return toSession(await authFlowPost('/auth/signup', { username, password }));
}

/** POST /auth/refresh — exchange a refresh token for a new access+refresh pair (item 121 A4). */
export async function authRefresh(refreshToken) {
  return toSession(await authFlowPost('/auth/refresh', { refresh_token: refreshToken }));
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

// ---- TOTP multi-factor authentication (item 127, Workstream D4; PR #229) -
// Self-contained TOTP second factor: enroll -> verify (flips MFA on, issues
// one-time recovery codes) -> a later login returns a `challenge` instead of
// a session -> mfaChallenge() redeems it. Every route below is JWT-gated
// EXCEPT mfaChallenge (the challenge token itself is the credential, same
// posture as /auth/refresh — see REST_API.md's "TOTP-based multi-factor
// authentication" section). Never persisted client-side beyond this
// session's in-memory state — the secret/recovery codes are shown once by
// the engine itself and this module doesn't cache them either.

/**
 * POST /auth/mfa/enroll — start enrollment. Returns the fresh TOTP secret +
 * an `otpauth://` URI to render as a QR code. MFA is NOT enabled yet — call
 * mfaVerify() with a live code to confirm.
 */
export async function mfaEnroll() {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/auth/mfa/enroll`, { method: 'POST', headers: authHeaders() });
  } catch (err) {
    throw transportError(err);
  }
  if (res.status === 404) return { supported: false };
  if (!res.ok) throw await toApiError(res);
  const j = await res.json();
  return { supported: true, secret: j.secret, otpauthUrl: j.otpauth_url };
}

/**
 * POST /auth/mfa/verify — confirm a pending enrollment with a live 6-digit
 * code. On success MFA flips to enabled and the engine returns 8 one-time
 * recovery codes — shown to the user exactly once, never re-fetchable.
 */
export async function mfaVerify(code) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/auth/mfa/verify`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ code }),
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
  const j = await res.json();
  return { enabled: !!j.enabled, recoveryCodes: j.recovery_codes ?? [] };
}

/**
 * POST /auth/mfa/challenge — redeem the `{challenge}` a POST /auth/login
 * returned (in place of a session) plus a live TOTP or recovery code, for a
 * real session. Public route (no bearer token — the challenge IS the
 * credential); rate-limited like login/signup/refresh.
 */
export async function mfaChallenge(challenge, code) {
  const j = await authFlowPost('/auth/mfa/challenge', { challenge, code });
  return toSession(j);
}

/**
 * POST /auth/mfa/disable — turn MFA off for the caller's own account.
 * Requires a live TOTP/recovery `code` unless the caller is a superuser
 * (emergency recovery path — no code needed then).
 */
export async function mfaDisable(code) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/auth/mfa/disable`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(code ? { code } : {}),
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
}

// ---- OAuth 2.0 social login (item 128, Workstream D1; PR #230) -----------
// `GET /auth/oauth/{provider}/authorize` is a real browser redirect (302 to
// the provider) — clicking "Sign in with <Provider>" navigates the whole
// tab there directly, it is never fetched. The only thing this module does
// is *feature-detect* which of the seven known preset provider names
// (`google`/`github`/`apple`/`azure`/`gitlab`/`discord`/`facebook` — the
// last five added by item 143, part 2) are actually configured, so the
// panel can hide a button that would otherwise 404. Per REST_API.md: an
// unconfigured provider's authorize/callback routes both return a plain
// `404`, indistinguishable from a non-existent route — there is no
// `GET /auth/meta` field listing configured providers. Detection technique:
// fetch the authorize URL with `redirect: 'manual'` so the browser does NOT
// follow a real redirect (no navigation, no request ever reaches the
// provider) — a configured provider yields an opaque redirect response
// (immediately discarded), an unconfigured one yields a normal, readable
// 404. Both authorize/callback are explicitly NOT rate-limited
// (REST_API.md), so probing all seven provider names on every panel load
// is safe. Any *other* provider name an operator configures via the
// `_AUTHORIZE_URL`/etc. env overrides works too (REST_API.md), but has no
// preset display name — out of scope for this fixed button row.

const OAUTH_PROVIDERS = ['google', 'github', 'apple', 'azure', 'gitlab', 'discord', 'facebook'];

// Display labels for the seven presets — cosmetic only, matches REST_API.md's
// preset table naming ("Microsoft / Azure AD" shortened to fit a button).
export const OAUTH_PROVIDER_LABELS = {
  google: 'Google',
  github: 'GitHub',
  apple: 'Apple',
  azure: 'Microsoft',
  gitlab: 'GitLab',
  discord: 'Discord',
  facebook: 'Facebook',
};

export function oauthAuthorizeUrl(provider) {
  return `${BASE_URL}/auth/oauth/${encodeURIComponent(provider)}/authorize`;
}

async function oauthProviderConfigured(provider) {
  try {
    const res = await fetch(oauthAuthorizeUrl(provider), { redirect: 'manual' });
    // A same-origin fetch with redirect:'manual' never exposes the redirect
    // target — a real 302 collapses to an opaque response (status 0, type
    // 'opaqueredirect'). Anything else (a normal, readable response) means
    // no redirect happened, i.e. the provider isn't configured (404).
    return res.type === 'opaqueredirect' || res.status === 0;
  } catch {
    return false; // transport failure — treat as "can't tell, hide it"
  }
}

/**
 * Feature-detects which OAuth providers are configured on this server (see
 * above for the technique). Returns one bool per `OAUTH_PROVIDERS` entry,
 * e.g. `{google: bool, github: bool, apple: bool, ...}`. Never throws — an
 * unreachable server just reports every provider as unconfigured, matching
 * the panel's existing "degrade gracefully" pattern.
 */
export async function getOauthProviders() {
  if (!IS_CONFIGURED) return Object.fromEntries(OAUTH_PROVIDERS.map((p) => [p, false]));
  const results = await Promise.all(OAUTH_PROVIDERS.map((p) => oauthProviderConfigured(p)));
  return Object.fromEntries(OAUTH_PROVIDERS.map((p, i) => [p, results[i]]));
}

/**
 * GET /auth/oauth/{provider}/callback?code=...&state=... — completes the
 * OAuth flow. Called with a plain `fetch` (not a browser navigation) when
 * the Studio's own origin is configured as the provider's
 * `_REDIRECT_URI` and the tab lands back with `?code=&state=` in its own
 * URL — see AuthPanel.svelte's `checkOauthCallback()`, which is the piece
 * that actually detects that landing. Public route (the provider's
 * redirect itself is the credential, same posture as `/auth/refresh`).
 */
export async function oauthCallback(provider, code, state) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  const qs = new URLSearchParams({ code, state });
  let res;
  try {
    res = await fetch(`${BASE_URL}/auth/oauth/${encodeURIComponent(provider)}/callback?${qs}`);
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
  return toSession(await res.json());
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

// ── GraphQL (item 130, Workstream C4; PR #232) ────────────────────────────
// POST /graphql — schema-derived, read-only (v1) GraphQL endpoint. Mounted
// under the same require_jwt layer as every other data-plane route (NOT
// public) and resolves every field through the identical enforced path
// /sql and /rest/v1 use (authorize_sql_as_principal +
// execute_sql_params_as_principal) — same RLS/grants, no parallel policy
// engine. Verified against docs/REST_API.md's "C4 — GraphQL" section and
// src/server/graphql.rs on unidb main. Standard GraphQL-over-HTTP: always
// 200 with a `{data, errors}` envelope — a GraphQL-level error (unknown
// field, PERMISSION_DENIED, …) is data, not a fetch failure, so this only
// throws for a transport failure or a non-2xx HTTP status.

export async function graphqlRequest(query, variables = null, operationName = null) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  const body = { query };
  if (variables && Object.keys(variables).length) body.variables = variables;
  if (operationName) body.operationName = operationName;
  let res;
  const start = performance.now();
  try {
    res = await fetch(`${BASE_URL}/graphql`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw transportError(err);
  }
  const roundTripMs = performance.now() - start;
  // Pre-item-130 server: no /graphql route at all.
  if (res.status === 404) return { supported: false, data: null, errors: null, roundTripMs };
  if (!res.ok) throw await toApiError(res);
  const j = await res.json();
  return { supported: true, data: j.data ?? null, errors: j.errors ?? null, roundTripMs };
}

// Standard GraphQL introspection query (hand-written — this project has no
// runtime dependency beyond Svelte, so no graphql-js `getIntrospectionQuery`
// helper). 6 levels of `ofType` nesting covers the deepest wrapping this
// schema produces (NonNull(List(NonNull(Scalar)))), same depth graphql-js
// itself uses. Item 130 says introspection (`__schema`/`__type`) is always
// enabled — verified in the "C4 — GraphQL" section of REST_API.md.
const TYPE_REF_FRAGMENT = `
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
            }
          }
        }
      }
    }
  }
`;

const INTROSPECTION_QUERY = `
  query StudioIntrospection {
    __schema {
      queryType { name }
      mutationType { name }
      types {
        kind
        name
        description
        fields(includeDeprecated: true) {
          name
          description
          args { name type { ${TYPE_REF_FRAGMENT} } defaultValue }
          type { ${TYPE_REF_FRAGMENT} }
        }
        enumValues(includeDeprecated: true) { name }
      }
    }
  }
`;

/**
 * Runs the standard introspection query and returns the raw `__schema`
 * object (types + the root Query type's fields — root fields ARE the
 * `<table>(...)`/`near_<table>(...)` queryable entry points per item 130).
 * Degrades to `{ supported: false }` on a pre-item-130 server (404) or one
 * with introspection unexpectedly disabled (a GraphQL error instead of
 * data) — the contract says it's always on, but this never assumes that.
 */
export async function getGraphqlSchema() {
  const out = await graphqlRequest(INTROSPECTION_QUERY);
  if (!out.supported) return { supported: false, schema: null };
  if (out.errors?.length || !out.data?.__schema) {
    return { supported: false, schema: null, errors: out.errors ?? null };
  }
  return { supported: true, schema: out.data.__schema };
}
// ---- auth admin API — user management (item 142, PR #245) -----------------
// Supabase-parity `auth.admin`: superuser-only /auth/admin/users/* for
// listing, inspecting, creating, updating, and deleting users, plus two
// new pieces of per-user state — `banned` and split `app_metadata`/
// `user_metadata` — without hand-rolling CREATE/DROP/ALTER USER SQL. Every
// route is superuser-gated server-side (403 PERMISSION_DENIED otherwise);
// a GET response NEVER includes a password hash, refresh token, or session
// detail (verified against REST_API.md's "Auth admin API" section) — this
// module doesn't add any client-side redaction because the server never
// sends the sensitive value in the first place.

/**
 * GET /auth/admin/users?limit=&offset= — paginated user list. `total` is
 * always the full unpaginated count (mirrors item 139's Content-Range
 * posture), never just the returned page length.
 */
export async function adminListUsers({ limit = 50, offset = 0 } = {}) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  let res;
  try {
    res = await fetch(`${BASE_URL}/auth/admin/users?${qs}`, { headers: authHeaders() });
  } catch (err) {
    throw transportError(err);
  }
  if (res.status === 404) return { supported: false, users: [], total: 0 };
  if (!res.ok) throw await toApiError(res);
  const j = await res.json();
  return { supported: true, users: j.users ?? [], total: j.total ?? 0 };
}

/** GET /auth/admin/users/{id} — {id} is the username (unidb has no separate user-id column). */
export async function adminGetUser(username) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/auth/admin/users/${encodeURIComponent(username)}`, { headers: authHeaders() });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
  return res.json();
}

/**
 * POST /auth/admin/users — create a user. Only `username` is required;
 * `password` is optional (a passwordless account can still be reached via
 * OAuth/magic-link later).
 */
export async function adminCreateUser(payload) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/auth/admin/users`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
  return res.json();
}

/**
 * PATCH /auth/admin/users/{id} — partial update; only supplied fields
 * change. `banned: true` revokes every session for that user server-side;
 * `superuser: false` demoting the last remaining superuser is rejected
 * (403 PERMISSION_DENIED), same lockout guard as adminDeleteUser below.
 */
export async function adminUpdateUser(username, payload) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/auth/admin/users/${encodeURIComponent(username)}`, {
      method: 'PATCH',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
  return res.json();
}

/**
 * DELETE /auth/admin/users/{id} — reuses DROP USER's exact cleanup
 * (memberships, grants, credentials, MFA, OAuth links, ban/metadata state).
 * Dropping the last remaining superuser is rejected (403 PERMISSION_DENIED,
 * not a silent no-op); an unknown username is 404, never a silent 204.
 */
export async function adminDeleteUser(username) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/auth/admin/users/${encodeURIComponent(username)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
}

// ---- database webhooks (item 141, PR #244) --------------------------------
// Superuser-only outbound-HTTP-on-row-change registration. GET /webhooks
// always redacts the signing secret (`has_signing_secret: bool`, never the
// value) — this module never fabricates or attempts to display one.

/** GET /webhooks — list every registered webhook (secrets redacted server-side). */
export async function listWebhooks() {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/webhooks`, { headers: authHeaders() });
  } catch (err) {
    throw transportError(err);
  }
  if (res.status === 404) return { supported: false, webhooks: [] };
  if (!res.ok) throw await toApiError(res);
  return { supported: true, webhooks: await res.json() };
}

/**
 * POST /webhooks — create or upsert (by `id`) a webhook. `events` must be a
 * non-empty subset of insert/update/delete; `signing_secret` is optional
 * and write-only (never read back).
 */
export async function upsertWebhook(payload) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/webhooks`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
}

/** DELETE /webhooks/{id} — idempotent; deleting an unknown id is a no-op. */
export async function deleteWebhook(id) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/webhooks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
}

// ---- realtime channel authorization policies (item 140, PR #243) ---------
// Superuser-only allow/deny layer in front of the four broadcast/presence
// routes: (topic_pattern, operation, allowed_roles). Mirrors the RLS
// PoliciesPanel's shape/conventions on the Studio side.

/** GET /realtime/policies — list every stored channel policy. */
export async function listChannelPolicies() {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/realtime/policies`, { headers: authHeaders() });
  } catch (err) {
    throw transportError(err);
  }
  if (res.status === 404) return { supported: false, policies: [] };
  if (!res.ok) throw await toApiError(res);
  return { supported: true, policies: await res.json() };
}

/**
 * PUT /realtime/policies — upsert a (topic_pattern, operation) policy,
 * replacing its role set. `operation` is one of publish|subscribe|
 * presence|all (case-insensitive on the wire).
 */
export async function putChannelPolicy(topicPattern, operation, roles) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/realtime/policies`, {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ topic_pattern: topicPattern, operation, roles }),
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
}

/** DELETE /realtime/policies — idempotent; removing an unknown pair is a no-op. */
export async function deleteChannelPolicy(topicPattern, operation) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/realtime/policies`, {
      method: 'DELETE',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ topic_pattern: topicPattern, operation }),
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
}

// ---- email auth flows — recovery + magic link (item 138, PR #241) --------
// POST /auth/recover and POST /auth/magiclink always return 200 regardless
// of whether `email` is a known account (no-account-enumeration contract) —
// this module surfaces that response as-is rather than trying to infer
// account existence from it. `email` is looked up directly as a username
// today (no users.email column yet — see this module's README contract
// note). Redemption (verify/magiclink-verify) tokens are single-use and
// short-lived server-side.

async function authOkPost(path, body) {
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
  return res.json(); // { ok: true }
}

/** POST /auth/recover — request a password-reset email. Always 200. */
export async function authRecover(email) {
  return authOkPost('/auth/recover', { email });
}

/** POST /auth/verify — redeem a recovery token for a new password; revokes every existing session. */
export async function authVerifyRecovery(token, newPassword) {
  return authOkPost('/auth/verify', { token, new_password: newPassword });
}

/** POST /auth/magiclink — request a magic sign-in link email. Always 200. */
export async function authMagicLink(email) {
  return authOkPost('/auth/magiclink', { email });
}

/** POST /auth/magiclink/verify — redeem a magic-link token for a real session. */
export async function authMagicLinkVerify(token) {
  return toSession(await authFlowPost('/auth/magiclink/verify', { token }));
}

// ---- dev-inbox read route (item 145) --------------------------------------
// Studio's Inbucket/Mailpit-equivalent: reads/clears the exact dev-inbox
// JSONL the `log` email transport writes, so the recovery/magic-link token
// pasted into the redemption form above (see AuthPanel's header comment)
// doesn't have to come from a filesystem `tail`. Double-gated server-side
// (REST_API.md item 145): `404` when the active transport is real SMTP
// (checked first, so a production deployment never leaks that this admin
// surface exists at all), then `403 PERMISSION_DENIED` for a non-superuser.
// This module surfaces both distinctly — `supported:false` for the 404 (a
// real "not applicable here" state, same posture as every other
// feature-detected route), while a 403 is re-thrown so the caller can show
// the real permission error rather than silently hiding a superuser-only
// feature.

/** GET /auth/dev-inbox?limit= — newest-first captured emails (dev transport + superuser only). */
export async function getDevInbox({ limit = 50 } = {}) {
  if (!IS_CONFIGURED) return { supported: false, emails: [] };
  const qs = new URLSearchParams({ limit: String(limit) });
  let res;
  try {
    res = await fetch(`${BASE_URL}/auth/dev-inbox?${qs}`, { headers: authHeaders() });
  } catch (err) {
    throw transportError(err);
  }
  if (res.status === 404) return { supported: false, emails: [] };
  if (!res.ok) throw await toApiError(res);
  return { supported: true, emails: await res.json() };
}

/** DELETE /auth/dev-inbox — truncate the dev inbox in place. */
export async function clearDevInbox() {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/auth/dev-inbox`, { method: 'DELETE', headers: authHeaders() });
  } catch (err) {
    throw transportError(err);
  }
  if (res.status === 404) return { supported: false };
  if (!res.ok) throw await toApiError(res);
  return { supported: true };
}
