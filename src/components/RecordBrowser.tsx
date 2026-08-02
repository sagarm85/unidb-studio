import { useEffect, useState } from 'react';
import { runSql } from '@/lib/engine/api.js';
import { quoteIdent, isVectorType, bindForColumn } from '@/lib/engine/format.js';
import { DataGrid, type DataGridResult, type HeaderMeta } from './DataGrid';
import { ErrorBox } from './ErrorBox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from './ui/dialog';
import type { CatalogTable, CatalogRelationship, CatalogError } from '@/hooks/useCatalog';

const PAGE = 100;

interface Operator {
  id: string;
  label: string;
  sql?: string;
  valueless?: boolean;
}

// Filter operators the engine actually supports. `valueless` ops (IS NULL /
// IS NOT NULL) bind no value. unidb has no LIKE — its text search is the
// FULLTEXT index, not LIKE — so contains/starts-with/ends-with are
// deliberately absent rather than emitting a query the engine rejects.
const OPERATORS: Operator[] = [
  { id: 'eq', label: '=', sql: '=' },
  { id: 'neq', label: '≠', sql: '!=' },
  { id: 'gt', label: '>', sql: '>' },
  { id: 'gte', label: '≥', sql: '>=' },
  { id: 'lt', label: '<', sql: '<' },
  { id: 'lte', label: '≤', sql: '<=' },
  { id: 'isnull', label: 'is null', valueless: true },
  { id: 'notnull', label: 'is not null', valueless: true },
];
const opById = (id: string) => OPERATORS.find((o) => o.id === id);

interface Filter {
  column: string;
  op: string;
  value: string;
}

interface QueryState {
  page: number;
  lastKey: unknown;
  atEnd: boolean;
  sortCol: string | null;
  sortDir: 'asc' | 'desc';
  appliedFilters: Filter[];
  simMode: boolean;
  simVector: number[] | null;
  simFrom: string | null;
}

const initialQueryState: QueryState = {
  page: 0,
  lastKey: null,
  atEnd: false,
  sortCol: null,
  sortDir: 'asc',
  appliedFilters: [],
  simMode: false,
  simVector: null,
  simFrom: null,
};

function buildFilterClauses(
  appliedFilters: Filter[],
  columnMeta: Map<string, { type?: string; nullable: boolean; default: unknown }>,
  start: number,
  { skipValueless = false } = {},
) {
  const conds: string[] = [];
  const params: unknown[] = [];
  let n = start;
  for (const f of appliedFilters) {
    if (!f.column) continue;
    const op = opById(f.op)!;
    const col = quoteIdent(f.column);
    if (op.valueless) {
      if (skipValueless) continue;
      conds.push(`${col} ${op.id === 'isnull' ? 'IS NULL' : 'IS NOT NULL'}`);
      continue;
    }
    conds.push(`${col} ${op.sql} $${n}`);
    const colType = columnMeta.get(f.column)?.type;
    try {
      const bind = bindForColumn(colType, f.value);
      params.push('literal' in bind ? f.value : bind.param);
    } catch {
      params.push(f.value);
    }
    n += 1;
  }
  return { conds, params };
}

function vecLiteral(vec: number[]) {
  return `[${vec.filter((n) => Number.isFinite(n)).join(', ')}]`;
}

// Place a bound value into a mutation: a `$n` param, or an inline literal for
// types the engine won't bind (DECIMAL). Mutates `params`; returns the SQL slot.
function slot(bind: { literal?: string; param?: unknown }, params: unknown[]) {
  if ('literal' in bind) return bind.literal;
  params.push(bind.param);
  return `$${params.length}`;
}

export function RecordBrowser({
  table,
  relationships = [],
  editable = false,
}: {
  table: CatalogTable;
  relationships?: CatalogRelationship[];
  editable?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<CatalogError | null>(null);
  const [result, setResult] = useState<DataGridResult | null>(null);
  const [roundTripMs, setRoundTripMs] = useState<number | null>(null);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [lastSql, setLastSql] = useState<string | null>(null);
  const [lastParams, setLastParams] = useState<unknown[]>([]);

  const [draftFilters, setDraftFilters] = useState<Filter[]>([]);
  const [queryState, setQueryState] = useState<QueryState>(initialQueryState);
  const [k, setK] = useState(5);

  const colNames = (table?.columns ?? []).map((c) => c.name);
  const colTypes = (table?.columns ?? []).map((c) => c.type ?? null);
  const columnMeta = new Map(
    (table?.columns ?? []).map((c) => [c.name, { type: c.type, nullable: c.nullable !== false, default: c.default ?? null }]),
  );

  const vectorCol = (table?.columns ?? []).find((c) => isVectorType(c.type)) ?? null;
  const vectorIndexed = !!vectorCol && vectorCol.index === 'hnsw';
  const vectorIndex = vectorCol ? colNames.indexOf(vectorCol.name) : -1;

  const pkCols = Array.isArray(table?.primaryKey) ? table.primaryKey : [];
  const canEdit = editable && pkCols.length === 1;
  const pkCol = pkCols.length === 1 ? pkCols[0] : null;

  const keyCol = (() => {
    const cols = table?.columns ?? [];
    if (pkCols.length === 1) return pkCols[0];
    return cols.find((c) => c.index)?.name ?? cols.find((c) => c.name.toLowerCase() === 'id')?.name ?? null;
  })();
  const keyIndex = keyCol ? colNames.indexOf(keyCol) : -1;
  const mode: 'keyset' | 'offset' = keyCol ? 'keyset' : 'offset';
  const effectiveMode = queryState.sortCol ? 'offset' : mode;
  const sortState = queryState.sortCol ? { col: queryState.sortCol, dir: queryState.sortDir } : null;

  const headerMeta: HeaderMeta[] = (table?.columns ?? []).map((c) => ({
    isPk: pkCols.includes(c.name),
    isFk: relationships.some((r) => r.fromTable === table?.name && r.fromColumns?.includes(c.name)),
  }));

  const droppedInSimilar = queryState.appliedFilters.filter((f) => f.column && opById(f.op)?.valueless).length;
  const activeCount = queryState.appliedFilters.length;
  const rowCount = result?.rows?.length ?? 0;
  const fmt = (ms: number | null) => (ms == null ? '' : `${ms.toFixed(2)} ms`);

  async function fetchCount(qs: QueryState) {
    if (!table) return;
    const t = quoteIdent(table.name);
    const { conds, params } = buildFilterClauses(qs.appliedFilters, columnMeta, 1);
    const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    try {
      const out = await runSql(`SELECT COUNT(*) FROM ${t} ${whereSql}`.trim(), params);
      const r = out.results.find((x: DataGridResult) => x.type === 'rows');
      const n = r?.rows?.[0]?.[0];
      let tc: number | null = typeof n === 'number' ? n : Number(n);
      if (!Number.isFinite(tc)) tc = null;
      setTotalCount(tc);
    } catch {
      setTotalCount(null);
    }
  }

  async function fetchPage(qs: QueryState, direction: 'first' | 'next' | 'prev') {
    if (!table) return;
    setLoading(true);
    setError(null);

    const t = quoteIdent(table.name);
    const usingSort = !!qs.sortCol;
    const pagingMode = usingSort ? 'offset' : mode;
    const orderExpr = usingSort
      ? `${quoteIdent(qs.sortCol!)} ${qs.sortDir === 'desc' ? 'DESC' : 'ASC'}`
      : mode === 'keyset'
        ? quoteIdent(keyCol!)
        : '1';
    const { conds, params } = buildFilterClauses(qs.appliedFilters, columnMeta, 1);
    let sql: string;

    if (pagingMode === 'keyset') {
      const key = quoteIdent(keyCol!);
      const where = [...conds];
      if (direction === 'next' && qs.lastKey != null) {
        where.push(`${key} > $${params.length + 1}`);
        params.push(qs.lastKey);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      sql = `SELECT * FROM ${t} ${whereSql} ORDER BY ${orderExpr} LIMIT ${PAGE}`;
    } else {
      const nextPage = direction === 'next' ? qs.page + 1 : direction === 'prev' ? Math.max(0, qs.page - 1) : 0;
      const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      sql = `SELECT * FROM ${t} ${whereSql} ORDER BY ${orderExpr} LIMIT ${PAGE} OFFSET ${nextPage * PAGE}`;
    }

    try {
      const finalSql = sql.replace(/\s+/g, ' ').trim();
      setLastSql(finalSql);
      setLastParams(params);
      const out = await runSql(finalSql, params);
      setRoundTripMs(out.roundTripMs);
      const r = out.results.find((x: DataGridResult) => x.type === 'rows') ?? { type: 'rows', rows: [] };
      setResult(r);
      const rows = r.rows ?? [];
      const atEnd = rows.length < PAGE;

      let finalPage = qs.page;
      if (direction === 'next') finalPage = qs.page + 1;
      else if (direction === 'prev') finalPage = Math.max(0, qs.page - 1);
      else finalPage = 0;

      let finalLastKey = qs.lastKey;
      if (!qs.sortCol && mode === 'keyset' && rows.length) {
        finalLastKey = rows[rows.length - 1][keyIndex];
      }

      setQueryState({ ...qs, page: finalPage, lastKey: finalLastKey, atEnd });
    } catch (e: any) {
      setError({ code: e?.code, message: e?.message ?? String(e), status: e?.status });
    } finally {
      setLoading(false);
    }
  }

  async function runSimilar(qs: QueryState, kOverride?: number) {
    if (!table || !vectorCol || !qs.simVector) return;
    setLoading(true);
    setError(null);

    const t = quoteIdent(table.name);
    const col = quoteIdent(vectorCol.name);
    const kk = Math.max(1, Math.floor(kOverride ?? k) || 1);
    const { conds, params } = buildFilterClauses(qs.appliedFilters, columnMeta, 1, { skipValueless: true });
    const where = [`NEAR(${col}, ${vecLiteral(qs.simVector)}, ${kk})`, ...conds];
    const sql = `SELECT * FROM ${t} WHERE ${where.join(' AND ')}`;

    try {
      const out = await runSql(sql.replace(/\s+/g, ' ').trim(), params);
      setRoundTripMs(out.roundTripMs);
      setResult(out.results.find((x: DataGridResult) => x.type === 'rows') ?? { type: 'rows', rows: [] });
      setQueryState({ ...qs, atEnd: true });
    } catch (e: any) {
      setError({ code: e?.code, message: e?.message ?? String(e), status: e?.status });
    } finally {
      setLoading(false);
    }
  }

  async function reloadCurrent(qs: QueryState) {
    if (qs.simMode) return runSimilar(qs);
    if (!lastSql) return fetchPage(qs, 'first');
    setLoading(true);
    try {
      const out = await runSql(lastSql, lastParams);
      setRoundTripMs(out.roundTripMs);
      const r = out.results.find((x: DataGridResult) => x.type === 'rows') ?? { type: 'rows', rows: [] };
      setResult(r);
      setQueryState({ ...qs, atEnd: (r.rows ?? []).length < PAGE });
    } catch (e: any) {
      setError({ code: e?.code, message: e?.message ?? String(e), status: e?.status });
    } finally {
      setLoading(false);
    }
  }

  // Reload from the top whenever the selected table changes; drop stale filters.
  useEffect(() => {
    if (!table) return;
    setDraftFilters([]);
    setTotalCount(null);
    setResult(null);
    setQueryState(initialQueryState);
    fetchPage(initialQueryState, 'first');
    fetchCount(initialQueryState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table]);

  function handleSort(col: string) {
    let nextSortCol: string | null;
    let nextSortDir: 'asc' | 'desc';
    if (queryState.sortCol !== col) {
      nextSortCol = col;
      nextSortDir = 'asc';
    } else if (queryState.sortDir === 'asc') {
      nextSortCol = col;
      nextSortDir = 'desc';
    } else {
      nextSortCol = null;
      nextSortDir = 'asc';
    }
    const next: QueryState = { ...queryState, sortCol: nextSortCol, sortDir: nextSortDir, page: 0, lastKey: null, atEnd: false };
    setQueryState(next);
    fetchPage(next, 'first');
  }

  function addFilter() {
    setDraftFilters((d) => [...d, { column: colNames[0] ?? '', op: 'eq', value: '' }]);
  }
  function removeFilter(i: number) {
    setDraftFilters((d) => d.filter((_, idx) => idx !== i));
  }
  function applyFilters() {
    const nextApplied = draftFilters.filter((f) => f.column && (opById(f.op)!.valueless || f.value !== ''));
    const next: QueryState = { ...queryState, appliedFilters: nextApplied, page: 0, lastKey: null, atEnd: false };
    setQueryState(next);
    if (next.simMode) runSimilar(next);
    else fetchPage(next, 'first');
    fetchCount(next);
  }
  function clearFilters() {
    setDraftFilters([]);
    const next: QueryState = { ...queryState, appliedFilters: [], page: 0, lastKey: null, atEnd: false };
    setQueryState(next);
    if (next.simMode) runSimilar(next);
    else fetchPage(next, 'first');
    fetchCount(next);
  }

  function findSimilar(row: unknown[], ri: number) {
    if (vectorIndex < 0) return;
    const vec = row[vectorIndex];
    if (!Array.isArray(vec)) return;
    const idCol = keyIndex >= 0 ? row[keyIndex] : ri + 1;
    const simFrom = keyIndex >= 0 ? `${keyCol}=${idCol}` : `row ${ri + 1}`;
    const next: QueryState = { ...queryState, simMode: true, simVector: vec, simFrom };
    setQueryState(next);
    runSimilar(next);
  }
  function exitSimilar() {
    const next: QueryState = { ...queryState, simMode: false, simVector: null, simFrom: null, page: 0, lastKey: null, atEnd: false };
    setQueryState(next);
    fetchPage(next, 'first');
    fetchCount(next);
  }

  // ---- row mutations (Table Editor) --------------------------------------
  async function handleCellEdit(rowIndex: number, column: string, raw: string) {
    if (!canEdit || !pkCol) return;
    const rows = result?.rows ?? [];
    const row = rows[rowIndex];
    if (!row) return;
    const meta = columnMeta.get(column);
    const pkVal = row[colNames.indexOf(pkCol)];

    setError(null);
    try {
      const params: unknown[] = [];
      const isNullVal = raw === '' && meta?.nullable;
      const setSlot = slot(bindForColumn(meta?.type, raw, isNullVal), params);
      const pkSlot = slot(bindForColumn(columnMeta.get(pkCol)?.type, String(pkVal)), params);
      const sql = `UPDATE ${quoteIdent(table.name)} SET ${quoteIdent(column)} = ${setSlot} WHERE ${quoteIdent(pkCol)} = ${pkSlot}`;
      await runSql(sql, params);
      await reloadCurrent(queryState);
    } catch (e: any) {
      setError({ code: e?.code ?? 'EDIT_ERROR', message: e?.message, status: e?.status ?? 0 });
    }
  }

  const [deleteConfirm, setDeleteConfirm] = useState<{ row: unknown[]; pkVal: unknown } | null>(null);

  function requestRowDelete(row: unknown[]) {
    if (!canEdit || !pkCol) return;
    setDeleteConfirm({ row, pkVal: row[colNames.indexOf(pkCol)] });
  }

  async function confirmRowDelete() {
    if (!deleteConfirm) return;
    const { row } = deleteConfirm;
    setDeleteConfirm(null);
    setError(null);
    try {
      const params: unknown[] = [];
      const pkSlot = slot(bindForColumn(columnMeta.get(pkCol!)?.type, String(row[colNames.indexOf(pkCol!)])), params);
      await runSql(`DELETE FROM ${quoteIdent(table.name)} WHERE ${quoteIdent(pkCol!)} = ${pkSlot}`, params);
      await reloadCurrent(queryState);
      fetchCount(queryState);
    } catch (e: any) {
      setError({ code: e?.code ?? 'DELETE_ERROR', message: e?.message, status: e?.status ?? 0 });
    }
  }

  // ---- insert-row form -----------------------------------------------------
  const [showInsert, setShowInsert] = useState(false);
  const [insertDraft, setInsertDraft] = useState<Record<string, string>>({});
  const [insertError, setInsertError] = useState<string | null>(null);

  function openInsert() {
    setInsertDraft(Object.fromEntries(colNames.map((c) => [c, ''])));
    setInsertError(null);
    setShowInsert(true);
  }

  async function submitInsert() {
    setInsertError(null);
    const cols: string[] = [];
    const slots: (string | undefined)[] = [];
    const params: unknown[] = [];
    try {
      for (const name of colNames) {
        const raw = insertDraft[name] ?? '';
        const meta = columnMeta.get(name);
        if (raw === '') {
          if (meta?.default != null) continue;
          if (meta?.nullable) {
            cols.push(quoteIdent(name));
            slots.push(slot(bindForColumn(meta.type, '', true), params));
            continue;
          }
          throw new Error(`"${name}" is required`);
        }
        cols.push(quoteIdent(name));
        slots.push(slot(bindForColumn(meta?.type, raw), params));
      }
      if (!cols.length) throw new Error('nothing to insert');
      const sql = `INSERT INTO ${quoteIdent(table.name)} (${cols.join(', ')}) VALUES (${slots.join(', ')})`;
      await runSql(sql, params);
      setShowInsert(false);
      await reloadCurrent(queryState);
      fetchCount(queryState);
    } catch (e: any) {
      setInsertError(e?.message ?? String(e));
    }
  }

  // Supabase-style filter search: a single box that suggests the table's
  // columns; picking one opens a filter for it.
  const [colQuery, setColQuery] = useState('');
  const [showColMenu, setShowColMenu] = useState(false);
  const colMatches = (() => {
    const q = colQuery.trim().toLowerCase();
    return q ? colNames.filter((c) => c.toLowerCase().includes(q)) : colNames;
  })();
  const searchPlaceholder = colNames.length
    ? `Filter by ${colNames.slice(0, 3).join(', ')}${colNames.length > 3 ? '…' : ''}`
    : 'Filter…';

  function pickColumn(c: string) {
    setDraftFilters((d) => [...d, { column: c, op: 'eq', value: '' }]);
    setColQuery('');
    setShowColMenu(false);
  }
  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      if (showColMenu && colQuery.trim() && colMatches.length) pickColumn(colMatches[0]);
      else applyFilters();
    } else if (e.key === 'Escape') {
      setShowColMenu(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <strong className="font-mono text-lg font-medium">{table?.name}</strong>
          <span className="font-mono text-xs text-text-muted">
            {queryState.sortCol
              ? `sorted by ${queryState.sortCol} ${queryState.sortDir === 'asc' ? '↑' : '↓'}`
              : mode === 'keyset'
                ? `keyset on ${keyCol}`
                : 'LIMIT/OFFSET (no key)'}
          </span>
          {vectorCol && (
            <span
              className="inline-flex items-center gap-0.5 rounded-sm bg-info/15 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-info"
              title={`${vectorCol.name} ${vectorCol.type}${vectorIndexed ? ' · ANN indexed' : ''}`}
            >
              VEC
              {vectorIndexed && <span className="rounded-sm bg-info px-1 text-background">ANN</span>}
            </span>
          )}
          {editable && !canEdit && (
            <span className="self-center text-xs text-text-muted italic" title="Editing needs a single-column primary key">
              read-only (no PK)
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {roundTripMs != null && <span className="font-mono text-xs text-text-muted">round-trip: {fmt(roundTripMs)}</span>}
          {canEdit && !queryState.simMode && (
            <button className="h-[26px] rounded-md bg-brand px-3 text-sm text-brand-text-on hover:bg-brand-hover disabled:opacity-45" onClick={openInsert} disabled={loading}>
              + Insert
            </button>
          )}
          {!queryState.simMode && (
            <>
              {totalCount != null && <span className="text-sm tabular-nums text-foreground">{totalCount.toLocaleString()} rows</span>}
              <span className="text-sm text-text-light">page {queryState.page + 1}</span>
              <button
                className="h-[26px] rounded-md border border-border bg-secondary px-3 text-sm hover:border-border-strong disabled:opacity-45"
                onClick={() => fetchPage(queryState, 'first')}
                disabled={loading || queryState.page === 0}
              >
                First
              </button>
              {effectiveMode === 'offset' && (
                <button
                  className="h-[26px] rounded-md border border-border bg-secondary px-3 text-sm hover:border-border-strong disabled:opacity-45"
                  onClick={() => fetchPage(queryState, 'prev')}
                  disabled={loading || queryState.page === 0}
                >
                  ← Prev
                </button>
              )}
              <button
                className="h-[26px] rounded-md border border-border bg-secondary px-3 text-sm hover:border-border-strong disabled:opacity-45"
                onClick={() => fetchPage(queryState, 'next')}
                disabled={loading || queryState.atEnd}
              >
                Next →
              </button>
            </>
          )}
        </div>
      </div>

      {queryState.simMode && (
        <div className="flex items-center gap-3 rounded-lg border border-info/35 bg-info/[0.07] px-3 py-1.5">
          <span className="text-sm font-semibold text-info">≈ similar to {queryState.simFrom}</span>
          <label className="flex items-center gap-1.5 text-sm text-text-light">
            k
            <input
              className="h-[26px] w-14 rounded-md border border-border bg-secondary px-1.5 text-sm outline-none focus-visible:border-border-strong focus-visible:ring-[2px] focus-visible:ring-ring/40"
              type="number"
              min={1}
              max={100}
              value={k}
              onChange={(e) => setK(Number(e.target.value) || 1)}
              onBlur={(e) => runSimilar(queryState, Number(e.target.value) || 1)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runSimilar(queryState, Number((e.target as HTMLInputElement).value) || 1);
              }}
            />
          </label>
          {droppedInSimilar > 0 && (
            <span className="text-xs text-text-muted italic" title="unidb can't combine IS NULL with a vector NEAR search">
              IS NULL filter ignored while similar
            </span>
          )}
          <span className="flex-1" />
          <button className="h-[26px] rounded-md border border-border bg-secondary px-3 text-sm hover:border-border-strong" onClick={exitSimilar}>
            Back to browsing
          </button>
        </div>
      )}

      <div className="relative flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 focus-within:border-border-strong">
        <span className="text-base text-text-muted" aria-hidden="true">
          ⌕
        </span>
        <input
          type="text"
          placeholder={searchPlaceholder}
          value={colQuery}
          onChange={(e) => setColQuery(e.target.value)}
          onFocus={() => setShowColMenu(true)}
          onBlur={() => setTimeout(() => setShowColMenu(false), 120)}
          onKeyDown={onSearchKey}
          aria-label="Filter by column"
          className="flex-1 bg-transparent text-md text-foreground outline-none"
        />
        {activeCount > 0 && <span className="rounded-full bg-brand-subtle px-2 py-0.5 text-xs whitespace-nowrap text-brand">{activeCount} active</span>}
        {showColMenu && colMatches.length > 0 && (
          <ul className="absolute top-[calc(100%+4px)] left-0 z-10 max-h-64 min-w-[220px] overflow-auto rounded-lg border border-border bg-card p-1 shadow-[var(--shadow-overlay)]">
            {colMatches.map((c) => (
              <li key={c}>
                <button
                  className="w-full rounded-md px-2 py-1.5 text-left font-mono text-md hover:bg-accent"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickColumn(c);
                  }}
                >
                  {c}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {draftFilters.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
          {draftFilters.map((f, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-12 text-right font-mono text-xs text-text-muted">{i === 0 ? 'WHERE' : 'AND'}</span>
              <select
                className="h-8 rounded-md border border-border bg-secondary px-2 text-sm"
                value={f.column}
                onChange={(e) => setDraftFilters((d) => d.map((x, idx) => (idx === i ? { ...x, column: e.target.value } : x)))}
              >
                {colNames.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <select
                className="h-8 rounded-md border border-border bg-secondary px-2 text-sm"
                value={f.op}
                onChange={(e) => setDraftFilters((d) => d.map((x, idx) => (idx === i ? { ...x, op: e.target.value } : x)))}
              >
                {OPERATORS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              {!opById(f.op)!.valueless ? (
                <input
                  type="text"
                  placeholder="value"
                  value={f.value}
                  onChange={(e) => setDraftFilters((d) => d.map((x, idx) => (idx === i ? { ...x, value: e.target.value } : x)))}
                  onKeyDown={(e) => e.key === 'Enter' && applyFilters()}
                  className="h-8 min-w-[80px] flex-1 rounded-md border border-border bg-secondary px-2 text-sm outline-none focus-visible:border-border-strong focus-visible:ring-[2px] focus-visible:ring-ring/40"
                />
              ) : (
                <span className="flex-1" />
              )}
              <button className="text-text-muted hover:text-error" title="Remove filter" onClick={() => removeFilter(i)}>
                ✕
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <button className="h-[26px] rounded-md border border-border bg-secondary px-3 text-sm hover:border-border-strong" onClick={addFilter}>
              + Add filter
            </button>
            <span className="flex-1" />
            {(activeCount > 0 || draftFilters.length > 0) && (
              <button className="h-[26px] rounded-md border border-border bg-secondary px-3 text-sm hover:border-border-strong" onClick={clearFilters}>
                Clear
              </button>
            )}
            <button
              className="h-[26px] rounded-md bg-brand px-3 text-sm text-brand-text-on hover:bg-brand-hover disabled:opacity-45"
              onClick={applyFilters}
              disabled={loading}
            >
              Apply
            </button>
          </div>
        </div>
      )}

      {error ? (
        <ErrorBox error={error} />
      ) : loading && !result ? (
        <p className="text-sm text-text-light">Loading…</p>
      ) : result ? (
        <>
          <DataGrid
            result={result}
            columns={colNames}
            columnTypes={colTypes}
            onRowAction={vectorIndexed && !queryState.simMode ? findSimilar : null}
            rowActionIcon="≈"
            rowActionTitle="Find similar rows (vector NEAR search)"
            onCellEdit={canEdit && !queryState.simMode ? handleCellEdit : null}
            onRowDelete={canEdit && !queryState.simMode ? requestRowDelete : null}
            onSort={queryState.simMode ? null : handleSort}
            sortState={sortState}
            headerMeta={headerMeta}
          />
          {rowCount === 0 && queryState.appliedFilters.length > 0 ? (
            <p className="mt-1 text-sm text-text-light">No rows match the filters.</p>
          ) : queryState.simMode ? (
            <p className="mt-1 text-sm text-text-light">
              Top {rowCount} nearest by {vectorCol?.name}.
            </p>
          ) : queryState.atEnd ? (
            <p className="mt-1 text-sm text-text-light">End of table.</p>
          ) : null}
        </>
      ) : null}

      <Dialog open={showInsert} onOpenChange={setShowInsert}>
        <DialogContent className="max-h-[82vh] max-w-[520px] overflow-hidden p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle className="font-mono">Insert row · {table?.name}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2.5 overflow-auto p-4">
            {(table?.columns ?? []).map((c) => (
              <label key={c.name} className="flex flex-col gap-1">
                <span className="flex items-baseline gap-2 text-sm font-semibold">
                  {c.name}
                  <span className="font-mono text-xs font-normal text-text-muted">
                    {c.type}
                    {c.nullable === false ? ' · required' : ''}
                    {c.default != null ? ` · default ${c.default}` : ''}
                  </span>
                </span>
                <input
                  className="h-8 rounded-md border border-border bg-secondary px-2 font-mono text-md outline-none focus-visible:border-border-strong focus-visible:ring-[2px] focus-visible:ring-ring/40"
                  value={insertDraft[c.name] ?? ''}
                  onChange={(e) => setInsertDraft((d) => ({ ...d, [c.name]: e.target.value }))}
                  placeholder={c.default != null ? 'default' : c.nullable ? 'NULL' : ''}
                  spellCheck={false}
                />
              </label>
            ))}
          </div>
          {insertError && <p className="m-0 bg-error-subtle px-4 py-2 text-sm text-error">{insertError}</p>}
          <DialogFooter className="border-t border-border px-4 py-3">
            <span className="mr-auto self-center text-xs text-text-muted">
              Blank = default if any, else NULL. Vectors/JSON as JSON, e.g. [0.1, 0.2].
            </span>
            <button className="h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong" onClick={() => setShowInsert(false)}>
              Cancel
            </button>
            <button className="h-8 rounded-md bg-brand px-3 text-md text-brand-text-on hover:bg-brand-hover disabled:opacity-45" onClick={submitInsert} disabled={loading}>
              Insert
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <DialogContent className="max-w-[400px] p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>Delete row</DialogTitle>
          </DialogHeader>
          <div className="p-4">
            <p className="m-0 text-md leading-relaxed">
              This will permanently delete the row where{' '}
              <code className="rounded-sm border border-border bg-secondary px-1 font-mono text-sm">
                {pkCol} = {String(deleteConfirm?.pkVal)}
              </code>{' '}
              from <strong>{table?.name}</strong>. This cannot be undone.
            </p>
          </div>
          <DialogFooter className="border-t border-border px-4 py-3">
            <button className="h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </button>
            <button
              className="h-8 rounded-md bg-error px-3 text-md font-semibold text-background hover:brightness-110 disabled:opacity-45"
              onClick={confirmRowDelete}
              disabled={loading}
            >
              Delete
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
