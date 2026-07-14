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

// ---- change-event stream (Milestone 20) ---------------------------------
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
