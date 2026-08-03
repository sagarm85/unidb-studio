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
// the header's "Generate token" flow (dev only) and the dev-login "switch
// identity" flow can apply a fresh one without a rebuild. All requests read
// it through here.
//
// Mirrored into sessionStorage so a runtime-applied token (dev-login in
// particular) survives the page reload that switching identity forces —
// every tab fetches its data once on mount with whatever token was active
// then, so nothing re-evaluates under the new identity without a reload,
// and a reload would otherwise fall straight back to the build-time env
// token, undoing the switch it was supposed to complete.
const SESSION_TOKEN_KEY = 'unidb_studio_token_override';
function readSessionToken() {
  try {
    return sessionStorage.getItem(SESSION_TOKEN_KEY) ?? '';
  } catch {
    return ''; // sessionStorage unavailable (e.g. private mode) — env token only
  }
}
let token = readSessionToken() || (ENV.VITE_UNIDB_TOKEN ?? '').trim();

export function getToken() {
  return token;
}

export function setToken(t) {
  token = (t ?? '').trim();
  try {
    if (token) sessionStorage.setItem(SESSION_TOKEN_KEY, token);
    else sessionStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    /* sessionStorage unavailable — in-memory only, same as before */
  }
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

/**
 * POST /auth/preview (item-24 Z6). Runs `sql` as `asRole`, RLS-filtered —
 * the Auth tab's "preview as user" debugger. Superuser-gated by the server;
 * a non-superuser caller gets 403 PERMISSION_DENIED (surfaced as ApiError).
 *
 * @param {string} asRole
 * @param {string} sql
 * @returns {Promise<{type: string, columns: string[], rows: unknown[][]}>}
 */
export async function authPreview(asRole, sql) {
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
  return res.json();
}

/**
 * GET /auth/meta (item 100). No JWT required — the blank-slate discovery
 * route: whether the server is in open mode, the grantable privilege/policy
 * vocabularies, every queryable catalog relation, and whether
 * `POST /auth/login` is available on this server.
 *
 * @returns {Promise<{open_mode: boolean, privilege_types: string[], policy_operations: string[], catalog_tables: string[], dev_login_enabled: boolean}>}
 */
export async function fetchAuthMeta() {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/auth/meta`);
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
  return res.json();
}

/**
 * POST /auth/login (item 100). No JWT required — but only works when the
 * server was started with UNIDB_DEV_LOGIN=1 (check `dev_login_enabled` from
 * fetchAuthMeta() first). Passwordless: identifies an existing user by name
 * and issues a 1h JWT for them. Dev/demo only, never a production auth path.
 * Both "user not found" and "dev login disabled" come back as a normal
 * ApiError (400 SQL_PLAN_ERROR) — there's no special status code to branch
 * on, so callers should just surface `.message`.
 *
 * @param {string} username
 * @returns {Promise<{token: string, expires_in: number}>}
 */
export async function devLogin(username) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
  return res.json();
}

/**
 * GET /auth/whoami (item 100). JWT required. The caller's own identity +
 * authorization summary — `user` is the JWT `sub` (null for the implicit
 * no-sub superuser), plus is_superuser/roles/privileges/open_mode.
 *
 * @returns {Promise<{user: string|null, is_superuser: boolean, roles: string[], privileges: {table: string, ops: string[]}[], open_mode: boolean}>}
 */
export async function fetchWhoami() {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/auth/whoami`, { headers: authHeaders() });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
  return res.json();
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

// ── Storage (item 31) ────────────────────────────────────────────────────────
// Routes: GET/POST /storage/buckets, DELETE /storage/buckets/{name},
//         GET /storage/{bucket}/objects, PUT/DELETE /storage/{bucket}/objects/{*key},
//         GET /storage/{bucket}/presign/{*key}
// Returns { supported: false } on 404 (pre-item-31 engine) or 503
// (item-31 engine with STORAGE_BACKEND not configured).

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
    body: JSON.stringify({ name, public: isPublic }),
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
    xhr.onload  = () => xhr.status < 300 ? resolve() : reject(new Error(`Upload failed: ${xhr.status}`));
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

// ── The remainder of this file was ported from the v1 (Svelte) app's
// src/lib/api.js, which stayed current against unidb main through PR #250
// while this file was frozen at the v2 branch's fork point (2026-07-15).
// Same wire contract, same helper conventions (authHeaders/toApiError/
// transportError/IS_CONFIGURED/catalogRows/CATALOG_ABSENT_CODES above) —
// only the doc comments were reworded where they referenced Svelte-specific
// file names. ─────────────────────────────────────────────────────────────

// ---- auto REST API (item 123, C1) + full Prefer control (item 139) +
// embed filter/order/limit/offset (item 136) ------------------------------
// GET/POST/PATCH/DELETE /rest/v1/<table> + GET /rest/v1 (catalog-derived
// OpenAPI 3 doc). GET /rest/v1 sits under the same require_jwt layer as
// every other data-plane route — NOT public. Every response reuses POST
// /sql's ExecResult JSON shape, not a bare PostgREST-style array of row
// objects: GET -> {type:'rows', columns, rows}; POST -> {type:'inserted',
// count}; PATCH -> {type:'updated', count}; DELETE -> {type:'deleted',
// count}. Filter operators are exactly eq/neq/gt/gte/lt/lte/like/ilike/in/is.

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
 * GET/POST/PATCH/DELETE /rest/v1/<table>, the Prefer header (`count=exact`
 * on GET; `return=representation|minimal` on a mutation), extra raw query
 * params (item 136's dotted `<embed>.<col>=<op>.<val>` / `<embed>.order=` /
 * `<embed>.limit=` / `<embed>.offset=` params, which don't fit a fixed opts
 * shape), and a JSON request body for POST/PATCH.
 */
export async function restRequest(table, method, opts = {}) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  const qs = new URLSearchParams();
  if (opts.select) qs.set('select', opts.select);
  for (const [col, opValue] of opts.filterParams ?? []) qs.append(col, opValue);
  if (opts.order) qs.set('order', opts.order);
  if (opts.limit != null) qs.set('limit', String(opts.limit));
  if (opts.offset != null) qs.set('offset', String(opts.offset));
  for (const [key, value] of opts.extraParams ?? []) qs.append(key, value);
  const query = qs.toString();
  const url = `${BASE_URL}/rest/v1/${encodeURIComponent(table)}${query ? `?${query}` : ''}`;

  const headers = authHeaders();
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

// The three built-in roles (item 122, B3 — Supabase convention). Verified
// against unidb's src/authz/mod.rs::RESERVED_ROLES: `anon` (no verified JWT
// subject), `authenticated` (any verified subject, plus granted roles), and
// `service_role` (token claims carry `"role":"service_role"` — bypasses RLS
// like a superuser, on the audited path). Never rows in `unidb_catalog.roles`.
export const RESERVED_ROLES = ['anon', 'authenticated', 'service_role'];

// ---- credentialed auth flows (item 121, A1–A4) ---------------------------
// POST /auth/{login,signup,refresh} all return the same shape:
// { token, access_token, refresh_token, expires_in }. The refresh token is
// opaque (NOT a JWT) and only ever kept in component state — this module
// never persists it.
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
 * POST /auth/login — password login. When the user has TOTP MFA enabled
 * (item 127), the engine issues **no session** — instead
 * `{mfa_required: true, challenge, expires_in}`, redeemed via
 * `mfaChallenge()` below.
 */
export async function authLogin(username, password) {
  const j = await authFlowPost('/auth/login', { username, password });
  if (j.mfa_required) return { mfaRequired: true, challenge: j.challenge, expiresIn: j.expires_in };
  return { mfaRequired: false, ...toSession(j) };
}

/** POST /auth/signup — self-service signup (item 121 A3). 404s when UNIDB_ALLOW_SIGNUP isn't set. */
export async function authSignup(username, password) {
  return toSession(await authFlowPost('/auth/signup', { username, password }));
}

/** POST /auth/refresh — exchange a refresh token for a new access+refresh pair. */
export async function authRefresh(refreshToken) {
  return toSession(await authFlowPost('/auth/refresh', { refresh_token: refreshToken }));
}

/** POST /auth/logout — revoke a refresh-token session. Idempotent. */
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

// ---- active sessions (item 4) --------------------------------------------
/**
 * `unidb_catalog.sessions` — one row per refresh-token session. Columns are
 * epoch **seconds**. Visibility: a superuser sees every session, a named
 * non-superuser sees only their own. Degrades to `{ supported: false }` on
 * a pre-item-4 server.
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

/** DELETE /auth/sessions/{id} — revoke one session by its opaque session_id. Idempotent. */
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

// ---- TOTP multi-factor authentication (item 127, Workstream D4) ----------
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

/** POST /auth/mfa/challenge — redeem a login's {challenge} + a live code for a real session. Public route. */
export async function mfaChallenge(challenge, code) {
  const j = await authFlowPost('/auth/mfa/challenge', { challenge, code });
  return toSession(j);
}

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

// ---- OAuth 2.0 social login (item 128 D1 + item 143 part 2) --------------
// `GET /auth/oauth/{provider}/authorize` is a real browser redirect — this
// module only *feature-detects* which of the seven preset providers are
// configured, via a `redirect:'manual'` probe (a configured provider
// collapses to an opaque redirect response; an unconfigured one yields a
// readable 404). Neither route is rate-limited, so probing all seven on
// every panel load is safe.
const OAUTH_PROVIDERS = ['google', 'github', 'apple', 'azure', 'gitlab', 'discord', 'facebook'];

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
    return res.type === 'opaqueredirect' || res.status === 0;
  } catch {
    return false;
  }
}

/** Returns one bool per OAUTH_PROVIDERS entry, e.g. {google, github, apple, ...}. Never throws. */
export async function getOauthProviders() {
  if (!IS_CONFIGURED) return Object.fromEntries(OAUTH_PROVIDERS.map((p) => [p, false]));
  const results = await Promise.all(OAUTH_PROVIDERS.map((p) => oauthProviderConfigured(p)));
  return Object.fromEntries(OAUTH_PROVIDERS.map((p, i) => [p, results[i]]));
}

/** GET /auth/oauth/{provider}/callback?code=&state= — completes the flow. Public route. */
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

// ── GraphQL (item 130, C4; mutations item 133) ────────────────────────────
// POST /graphql — schema-derived. Mounted under the same require_jwt layer
// as every other data-plane route and resolves every field through the
// identical enforced path /sql and /rest/v1 use — same RLS/grants, no
// parallel policy engine. Always 200 with a {data, errors} envelope — a
// GraphQL-level error is data, not a fetch failure.
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
  if (res.status === 404) return { supported: false, data: null, errors: null, roundTripMs };
  if (!res.ok) throw await toApiError(res);
  const j = await res.json();
  return { supported: true, data: j.data ?? null, errors: j.errors ?? null, roundTripMs };
}

// Hand-written standard introspection query (no runtime dep on graphql-js).
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

/** Root Query/Mutation fields + every object type's fields. Degrades to {supported:false} on a pre-item-130 server. */
export async function getGraphqlSchema() {
  const out = await graphqlRequest(INTROSPECTION_QUERY);
  if (!out.supported) return { supported: false, schema: null };
  if (out.errors?.length || !out.data?.__schema) {
    return { supported: false, schema: null, errors: out.errors ?? null };
  }
  return { supported: true, schema: out.data.__schema };
}

// ---- auth admin API — user management (item 142) -------------------------
// Superuser-only /auth/admin/users/* CRUD. A GET response NEVER includes a
// password hash, refresh token, or session detail — the server never sends
// the sensitive value in the first place, so this module adds no
// client-side redaction of its own.
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

/** POST /auth/admin/users — only `username` is required; `password` is optional. */
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

/** PATCH /auth/admin/users/{id} — partial update. Demoting the last superuser is rejected (403). */
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

/** DELETE /auth/admin/users/{id} — dropping the last superuser is rejected (403), never a silent no-op. */
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

// ---- database webhooks (item 141) -----------------------------------------
// Superuser-only outbound-HTTP-on-row-change registration. GET /webhooks
// always redacts the signing secret (`has_signing_secret: bool`).
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

/** POST /webhooks — create or upsert (by `id`). `signing_secret` is optional and write-only. */
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

// ---- realtime channel authorization policies (item 140) ------------------
// Superuser-only allow/deny layer in front of the broadcast/presence routes:
// (topic_pattern, operation, allowed_roles).
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
  // The engine returns each policy's roles under `roles`; the panel reads
  // `allowed_roles`. Normalize here (the wire-contract layer) so a non-empty
  // list can't crash the panel on `p.allowed_roles.map`.
  const raw = await res.json();
  const policies = (Array.isArray(raw) ? raw : []).map((p) => ({
    ...p,
    allowed_roles: p.allowed_roles ?? p.roles ?? [],
  }));
  return { supported: true, policies };
}

/** PUT /realtime/policies — upsert, replacing the role set. operation is publish|subscribe|presence|all. */
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

// ---- email auth flows — recovery + magic link (item 138) -----------------
// POST /auth/recover and POST /auth/magiclink always return 200 regardless
// of whether `email` is a known account (no-account-enumeration contract).
// `email` is looked up directly as a username today (no users.email column).
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
  return res.json();
}

export async function authRecover(email) {
  return authOkPost('/auth/recover', { email });
}

/** POST /auth/verify — redeem a recovery token for a new password; revokes every existing session. */
export async function authVerifyRecovery(token, newPassword) {
  return authOkPost('/auth/verify', { token, new_password: newPassword });
}

export async function authMagicLink(email) {
  return authOkPost('/auth/magiclink', { email });
}

export async function authMagicLinkVerify(token) {
  return toSession(await authFlowPost('/auth/magiclink/verify', { token }));
}

// ---- dev-inbox read route (item 145) --------------------------------------
// Double-gated server-side: 404 when the active transport is real SMTP
// (checked first, so a production deployment never leaks that this admin
// surface exists), then 403 PERMISSION_DENIED for a non-superuser.
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

// ---- scheduled jobs — cron (item 144) -------------------------------------
// Supabase-parity pg_cron: register SQL to run on a schedule. Control-plane
// only — the scheduler is strictly a caller of the same execute_sql path
// every other statement uses. Superuser-only. No run *history* — only
// in-memory last-run status, reset on server restart.

/** GET /cron/jobs — every registered job merged with in-memory last-run status. */
export async function listCronJobs() {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/cron/jobs`, { headers: authHeaders() });
  } catch (err) {
    throw transportError(err);
  }
  if (res.status === 404) return { supported: false, jobs: [] };
  if (!res.ok) throw await toApiError(res);
  return { supported: true, jobs: await res.json() };
}

/**
 * POST /cron/jobs — create or upsert (by `name`). `schedule` is a standard
 * 5-field cron expression, validated server-side (400 INVALID_CRON_SCHEDULE
 * on anything malformed). `run_as` (optional) narrows the job's SQL to that
 * principal's own grants/RLS; omitted = embedded/superuser identity.
 */
export async function upsertCronJob(payload) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/cron/jobs`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
}

/** DELETE /cron/jobs/{name} — idempotent; deleting an unknown name is a no-op. */
export async function deleteCronJob(name) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/cron/jobs/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
}

// ── Realtime Broadcast & Presence (item 132) ──────────────────────────────
// Purely in-memory and ephemeral — no WAL/heap/catalog involvement, a
// server restart drops all state. Transport is SSE (same technique as
// openEventStream above), no WebSocket route. Every authenticated caller
// may publish/subscribe/track on a topic with no matching channel policy
// (item 140's open-by-default posture, unless UNIDB_REALTIME_REQUIRE_AUTHZ
// flips it to fail-closed — see the Channel Authz panel).

/** POST /realtime/broadcast/publish — fan out to current subscribers. Returns real receiver count. */
export async function publishBroadcast(topic, event, payload) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/realtime/broadcast/publish`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ topic, event, payload }),
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
  return res.json(); // { receivers }
}

/**
 * GET /realtime/broadcast/subscribe?topic= — SSE stream of every message
 * published to `topic` from the moment this subscription registers.
 * @param {{topic:string, onEvent:(e:{event:string,payload:object,ts:number})=>void, onError?:(e:Error)=>void, onOpen?:()=>void}} opts
 * @returns {{close:()=>void}}
 */
export function subscribeBroadcast({ topic, onEvent, onError, onOpen }) {
  return openSse(`/realtime/broadcast/subscribe?topic=${encodeURIComponent(topic)}`, { onEvent, onError, onOpen });
}

/**
 * POST /realtime/presence/track — associate/update the caller's presence
 * state under `key` on `topic`. Pushes a join/update delta to subscribers.
 */
export async function trackPresence(topic, key, state) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));
  let res;
  try {
    res = await fetch(`${BASE_URL}/realtime/presence/track`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ topic, key, state }),
    });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw await toApiError(res);
}

/**
 * GET /realtime/presence/subscribe?topic= — SSE stream: first a `sync`
 * frame (full current presence map), then join/leave/update deltas. This
 * connection's own lifetime IS this caller's presence membership on the
 * topic (see REST_API.md's "v1 connection-binding model").
 * @param {{topic:string, onEvent:(e:{event:string,payload:object,ts:number})=>void, onError?:(e:Error)=>void, onOpen?:()=>void}} opts
 * @returns {{close:()=>void}}
 */
export function subscribePresence({ topic, onEvent, onError, onOpen }) {
  return openSse(`/realtime/presence/subscribe?topic=${encodeURIComponent(topic)}`, { onEvent, onError, onOpen });
}

// Shared SSE consumer for the two routes above — same fetch+ReadableStream
// technique as openEventStream (EventSource can't send Authorization).
// Unlike openEventStream's raw `data:` JSON, these two routes' frames carry
// `event: <name>` + `data: <json>`, so onEvent receives {event, ...JSON.parse(data)}.
function openSse(path, { onEvent, onError, onOpen }) {
  const controller = new AbortController();
  (async () => {
    let res;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        headers: authHeaders({ Accept: 'text/event-stream' }),
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
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const parsed = parseSseFrame(frame);
          if (parsed?.data) {
            try {
              onEvent?.({ event: parsed.event, ...JSON.parse(parsed.data) });
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
