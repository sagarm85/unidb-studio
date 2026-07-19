// Client-side ring buffer of the last 200 SQL calls. Each entry:
//   { id, sql, durationMs, status ('ok'|'error'), rowCount, kind, timestamp }
//
// Framework-agnostic pub/sub (no Svelte `writable`, no state library) so it
// can back a `useSyncExternalStore`-based React hook in Phase 5's
// QueryPerformancePanel — same ring-buffer behavior as v1's queryStore.js.

const MAX = 200;
let history = [];
const listeners = new Set();

function notify() {
  for (const l of listeners) l();
}

export function subscribeQueryHistory(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getQueryHistory() {
  return history;
}

export function recordQuery(sql, durationMs, status, rowCount, kind) {
  const entry = {
    id: performance.now(),
    sql: sql.length > 300 ? sql.slice(0, 297) + '…' : sql,
    durationMs: Math.round(durationMs),
    status,
    rowCount,
    kind,
    timestamp: new Date().toISOString(),
  };
  const next = [entry, ...history];
  history = next.length > MAX ? next.slice(0, MAX) : next;
  notify();
}

export function clearQueryHistory() {
  history = [];
  notify();
}

export function detectKind(sql) {
  const t = sql.trimStart().toLowerCase();
  if (t.startsWith('select') || t.startsWith('with') || t.startsWith('explain')) return 'select';
  if (t.startsWith('insert')) return 'insert';
  if (t.startsWith('update')) return 'update';
  if (t.startsWith('delete')) return 'delete';
  if (t.startsWith('create') || t.startsWith('drop') || t.startsWith('alter')) return 'ddl';
  return 'other';
}
