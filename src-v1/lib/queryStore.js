import { writable } from 'svelte/store';

// Client-side ring buffer of the last 200 SQL calls. Each entry:
//   { id, sql, durationMs, status ('ok'|'error'), rowCount, kind, timestamp }
export const queryHistory = writable([]);

const MAX = 200;

export function recordQuery(sql, durationMs, status, rowCount, kind) {
  queryHistory.update((h) => {
    const entry = {
      id: performance.now(),
      sql: sql.length > 300 ? sql.slice(0, 297) + '…' : sql,
      durationMs: Math.round(durationMs),
      status,
      rowCount,
      kind,
      timestamp: new Date().toISOString(),
    };
    const next = [entry, ...h];
    return next.length > MAX ? next.slice(0, MAX) : next;
  });
}

function detectKind(sql) {
  const t = sql.trimStart().toLowerCase();
  if (t.startsWith('select') || t.startsWith('with') || t.startsWith('explain')) return 'select';
  if (t.startsWith('insert')) return 'insert';
  if (t.startsWith('update')) return 'update';
  if (t.startsWith('delete')) return 'delete';
  if (t.startsWith('create') || t.startsWith('drop') || t.startsWith('alter')) return 'ddl';
  return 'other';
}

export { detectKind };
