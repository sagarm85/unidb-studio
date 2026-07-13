// Thin client for the unidb REST API. This is the ONLY module that knows the
// wire contract (../unidb/docs/REST_API.md). Components speak in terms of the
// normalized shapes returned here, never raw fetch responses.

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
export async function runSql(sql, params = []) {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));

  const body = { sql };
  if (params && params.length) body.params = params;

  const start = performance.now();
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
  const roundTripMs = performance.now() - start;

  if (!res.ok) throw await toApiError(res);

  const payload = await res.json();
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

/**
 * GET /schema — full-database schema for the visualizer: every table's columns
 * PLUS primary keys and foreign-key relationships (which `/tables` does not
 * carry). This route is PROPOSED and not yet implemented in the engine, so:
 *   - 200  -> use the server payload as-is ({ supported: true, inferred: false }).
 *   - 404  -> not built yet; signal callers to fall back to inference/demo data.
 *
 * Proposed response contract (see the schema-endpoint doc):
 *   {
 *     "tables": [
 *       { "name": "users",
 *         "columns": [
 *           { "name": "id", "type": "INT", "nullable": false,
 *             "index": true, "primaryKey": true }
 *         ],
 *         "primaryKey": ["id"] }
 *     ],
 *     "relationships": [
 *       { "name": "orders_user_id_fkey",
 *         "fromTable": "orders", "fromColumns": ["user_id"],
 *         "toTable": "users",   "toColumns": ["id"] }
 *     ]
 *   }
 *
 * @returns {Promise<{tables: Array, relationships: Array, supported: boolean}>}
 */
export async function getSchema() {
  if (!IS_CONFIGURED) throw transportError(new Error('unconfigured'));

  let res;
  try {
    res = await fetch(`${BASE_URL}/schema`, { headers: authHeaders() });
  } catch (err) {
    throw transportError(err);
  }

  if (res.status === 404) return { tables: [], relationships: [], supported: false };
  if (!res.ok) throw await toApiError(res);

  const data = await res.json();
  return {
    tables: data?.tables ?? [],
    relationships: data?.relationships ?? [],
    supported: true,
  };
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

// Is this SQL a single read query we can safely EXPLAIN ANALYZE? (EXPLAIN
// ANALYZE actually executes, so we only run it on read-only shapes, and only
// when there's a single statement.)
export function isSingleSelect(sql) {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (trimmed.includes(';')) return false; // multiple statements
  return /^(select|with)\b/i.test(trimmed);
}
