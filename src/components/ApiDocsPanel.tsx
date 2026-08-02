import { useEffect, useMemo, useState } from 'react';
import { FileCode, Play } from 'lucide-react';
import { getRestOpenApi, restRequest, BASE_URL } from '@/lib/engine/api.js';
import { DataGrid, type DataGridResult } from './DataGrid';
import { Textarea } from './ui/textarea';
import { ErrorBox } from './ErrorBox';
import { PanelHelp } from './PanelHelp';
import { cn } from '@/lib/utils';
import type { CatalogError } from '@/hooks/useCatalog';

// API-docs panel (item 123 C1/C3, C2 embedded resources, item 136 per-embed
// filter/order/limit/offset, item 139 Prefer/count) — built directly against
// GET /rest/v1's catalog-derived OpenAPI 3 doc + a live GET/POST/PATCH/DELETE
// explorer over /rest/v1/<table>. Every response reuses POST /sql's
// ExecResult shape, not a bare PostgREST array.

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const METHODS: Method[] = ['GET', 'POST', 'PATCH', 'DELETE'];
const FILTER_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is'] as const;

interface Filter {
  col: string;
  op: (typeof FILTER_OPS)[number];
  val: string;
}

function columnsFor(doc: any, table: string): { name: string; type: string; isPk: boolean }[] {
  const schema = doc?.components?.schemas?.[table];
  if (!schema?.properties) return [];
  const pkFromTableConstraint = new Set<string>(schema['x-primary-key'] ?? []);
  return Object.entries(schema.properties as Record<string, any>).map(([name, def]: [string, any]) => ({
    name,
    type: def.type ?? 'unknown',
    isPk: pkFromTableConstraint.has(name) || def.description === 'primary key',
  }));
}

export function ApiDocsPanel() {
  const [supported, setSupported] = useState(true);
  const [doc, setDoc] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CatalogError | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);

  useEffect(() => {
    getRestOpenApi()
      .then((out) => {
        setSupported(out.supported);
        setDoc(out.doc);
        const names = Object.keys(out.doc?.components?.schemas ?? {});
        if (names.length) setSelectedTable(names[0]);
      })
      .catch((e) => setError({ code: e?.code, message: e?.message ?? String(e), status: e?.status }))
      .finally(() => setLoading(false));
  }, []);

  const tableNames = useMemo(() => (doc ? Object.keys(doc.components?.schemas ?? {}) : []), [doc]);
  const columns = useMemo(() => (selectedTable ? columnsFor(doc, selectedTable) : []), [doc, selectedTable]);

  // ---- explorer state ----
  const [method, setMethod] = useState<Method>('GET');
  const [selectCols, setSelectCols] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<Filter[]>([]);
  const [orderCol, setOrderCol] = useState('');
  const [orderDir, setOrderDir] = useState<'asc' | 'desc'>('asc');
  const [limit, setLimit] = useState('50');
  const [offset, setOffset] = useState('0');
  const [extraParamsText, setExtraParamsText] = useState('');
  const [bodyText, setBodyText] = useState('{}');
  const [countExact, setCountExact] = useState(false);
  const [returnMode, setReturnMode] = useState<'' | 'representation' | 'minimal'>('');
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<any>(null);
  const [runMeta, setRunMeta] = useState<{ url: string; status: number; contentRange: string | null; preferenceApplied: string | null } | null>(null);

  useEffect(() => {
    setSelectCols(new Set());
    setFilters([]);
    setOrderCol('');
    setRunResult(null);
    setRunMeta(null);
    setRunError(null);
  }, [selectedTable]);

  function toggleSelectCol(c: string) {
    setSelectCols((s) => {
      const next = new Set(s);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }
  function addFilter() {
    setFilters((f) => [...f, { col: columns[0]?.name ?? '', op: 'eq', val: '' }]);
  }
  function updateFilter(i: number, patch: Partial<Filter>) {
    setFilters((f) => f.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  }
  function removeFilter(i: number) {
    setFilters((f) => f.filter((_, idx) => idx !== i));
  }

  // Parse the free-text extra-params textarea (one `key=value` per line) into
  // [key, value] pairs — this is where item 136's dotted <embed>.<col>=<op>.<val>
  // / <embed>.order= / <embed>.limit= / <embed>.offset= params go, since their
  // key shape doesn't fit the fixed select/filter/order builder above.
  function parseExtraParams(): [string, string][] {
    return extraParamsText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const idx = l.indexOf('=');
        return idx === -1 ? [l, ''] : [l.slice(0, idx), l.slice(idx + 1)];
      });
  }

  async function runExplorer() {
    if (!selectedTable) return;
    setRunBusy(true);
    setRunError(null);
    setRunResult(null);
    setRunMeta(null);
    try {
      const opts: any = { countExact, return: returnMode || undefined };
      if (method === 'GET') {
        if (selectCols.size) opts.select = Array.from(selectCols).join(',');
        opts.filterParams = filters.filter((f) => f.col && f.val).map((f) => [f.col, `${f.op}.${f.val}`]);
        if (orderCol) opts.order = `${orderCol}.${orderDir}`;
        if (limit) opts.limit = Number(limit);
        if (offset) opts.offset = Number(offset);
        opts.extraParams = parseExtraParams();
      } else if (method === 'DELETE') {
        opts.filterParams = filters.filter((f) => f.col && f.val).map((f) => [f.col, `${f.op}.${f.val}`]);
      } else {
        opts.filterParams = filters.filter((f) => f.col && f.val).map((f) => [f.col, `${f.op}.${f.val}`]);
        try {
          opts.body = JSON.parse(bodyText);
        } catch {
          setRunError('Request body must be valid JSON.');
          setRunBusy(false);
          return;
        }
      }
      const out = await restRequest(selectedTable, method, opts);
      setRunResult(out.result);
      setRunMeta({ url: out.url, status: out.status, contentRange: out.contentRange, preferenceApplied: out.preferenceApplied });
    } catch (e: any) {
      setRunError(e?.message ?? String(e));
    } finally {
      setRunBusy(false);
    }
  }

  function curlSnippet(): string {
    if (!selectedTable) return '';
    const sel = selectCols.size ? `?select=${Array.from(selectCols).join(',')}` : '';
    return `curl -H "Authorization: Bearer $TOKEN" \\\n  "${BASE_URL}/rest/v1/${selectedTable}${sel}"`;
  }

  const inputCls =
    'h-8 rounded-md border border-border bg-secondary px-2 text-md outline-none focus-visible:border-border-strong focus-visible:ring-[2px] focus-visible:ring-ring/40';
  const btnCls = 'h-8 rounded-md bg-brand px-3 text-md font-semibold text-brand-text-on hover:bg-brand-hover disabled:opacity-45';
  const ghostBtnCls = 'h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong disabled:opacity-45';

  if (loading) return <p className="p-4 text-sm text-text-light">Loading…</p>;
  if (!supported) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <h3 className="m-0 text-md font-semibold">API docs not available</h3>
        <p className="m-0 text-sm text-text-light">
          This server predates item 123 (<code>GET /rest/v1</code>).
        </p>
      </div>
    );
  }
  if (error) return <div className="p-4"><ErrorBox error={error} /></div>;

  return (
    <div className="flex h-full gap-4 p-4">
      <div className="flex w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border pr-3">
        <span className="mb-1 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-text-muted uppercase">
          <FileCode className="size-3.5" /> Tables
        </span>
        {tableNames.map((t) => (
          <button
            key={t}
            onClick={() => setSelectedTable(t)}
            className={cn('rounded-md px-2 py-1.5 text-left font-mono text-md hover:bg-accent', selectedTable === t && 'bg-selected text-brand')}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex flex-1 flex-col gap-3.5 overflow-y-auto">
        <PanelHelp
          summary="A live OpenAPI 3 view of the auto-generated REST API, plus a request explorer."
          what={
            <>
              Generated from the engine's own <code>GET /rest/v1</code> document — pick a table on the left to see its endpoints and copy curl
              snippets. The explorer runs real <code>GET/POST/PATCH/DELETE</code> against <code>/rest/v1/&lt;table&gt;</code> with{' '}
              <code>select=</code> + embedded FK expansion, filter operators
              (<code>eq/neq/gt/gte/lt/lte/like/ilike/in/is</code>), <code>order=</code>/<code>limit</code>/<code>offset</code>, and{' '}
              <code>Prefer: count=exact</code> / <code>return=representation</code> (real <code>Content-Range</code> headers shown). Same
              RLS/grant enforcement as <code>/sql</code>.
            </>
          }
          actions={[
            'Pick a table, then run a GET with a filter like status=eq.paid&limit=5',
            'Add Prefer: count=exact and read the Content-Range response header',
          ]}
          routes={['GET /rest/v1', 'GET/POST/PATCH/DELETE /rest/v1/{table}']}
        />
        {selectedTable && (
          <>
            <div>
              <h3 className="m-0 mb-1 font-mono text-md font-semibold">{selectedTable}</h3>
              <div className="flex flex-wrap gap-1">
                {columns.map((c) => (
                  <span key={c.name} className={cn('rounded-sm border border-border bg-secondary px-1.5 py-0.5 font-mono text-xs', c.isPk && 'border-brand text-brand')}>
                    {c.name}: {c.type}
                    {c.isPk ? ' (PK)' : ''}
                  </span>
                ))}
              </div>
            </div>

            <div className="rounded-md border border-border bg-secondary/40 p-2">
              <pre className="m-0 overflow-x-auto font-mono text-xs whitespace-pre-wrap text-text-light">{curlSnippet()}</pre>
            </div>

            <div className="flex gap-1">
              {METHODS.map((m) => (
                <button
                  key={m}
                  onClick={() => setMethod(m)}
                  className={cn('rounded-md border border-border px-3 py-1 text-sm font-semibold', method === m ? 'bg-brand text-brand-text-on' : 'bg-secondary hover:border-border-strong')}
                >
                  {m}
                </button>
              ))}
            </div>

            {method === 'GET' && (
              <>
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-semibold tracking-wide text-text-muted uppercase">select=</span>
                  <div className="flex flex-wrap gap-2">
                    {columns.map((c) => (
                      <label key={c.name} className="flex items-center gap-1 text-sm">
                        <input type="checkbox" checked={selectCols.has(c.name)} onChange={() => toggleSelectCol(c.name)} /> {c.name}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="flex items-end gap-2">
                  <label className="flex flex-col gap-1 text-sm text-text-light">
                    order
                    <select value={orderCol} onChange={(e) => setOrderCol(e.target.value)} className={inputCls}>
                      <option value="">(none)</option>
                      {columns.map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <select value={orderDir} onChange={(e) => setOrderDir(e.target.value as any)} className={inputCls}>
                    <option value="asc">asc</option>
                    <option value="desc">desc</option>
                  </select>
                  <label className="flex flex-col gap-1 text-sm text-text-light">
                    limit
                    <input value={limit} onChange={(e) => setLimit(e.target.value)} className={cn(inputCls, 'w-20')} />
                  </label>
                  <label className="flex flex-col gap-1 text-sm text-text-light">
                    offset
                    <input value={offset} onChange={(e) => setOffset(e.target.value)} className={cn(inputCls, 'w-20')} />
                  </label>
                  <label className="flex items-center gap-1.5 text-md">
                    <input type="checkbox" checked={countExact} onChange={(e) => setCountExact(e.target.checked)} /> Prefer: count=exact
                  </label>
                </div>
              </>
            )}

            {method !== 'GET' && (
              <label className="flex items-center gap-1.5 text-md">
                <span className="text-sm text-text-light">Prefer: return=</span>
                <select value={returnMode} onChange={(e) => setReturnMode(e.target.value as any)} className={inputCls}>
                  <option value="">(default)</option>
                  <option value="representation">representation</option>
                  <option value="minimal">minimal</option>
                </select>
              </label>
            )}

            {method !== 'POST' && (
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold tracking-wide text-text-muted uppercase">filters {method !== 'GET' ? '(row target)' : ''}</span>
                  <button className={cn(ghostBtnCls, 'h-6 px-2 text-xs')} onClick={addFilter}>
                    + filter
                  </button>
                </div>
                {filters.map((f, i) => (
                  <div key={i} className="flex gap-2">
                    <select value={f.col} onChange={(e) => updateFilter(i, { col: e.target.value })} className={inputCls}>
                      {columns.map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <select value={f.op} onChange={(e) => updateFilter(i, { op: e.target.value as any })} className={inputCls}>
                      {FILTER_OPS.map((op) => (
                        <option key={op} value={op}>
                          {op}
                        </option>
                      ))}
                    </select>
                    <input value={f.val} onChange={(e) => updateFilter(i, { val: e.target.value })} className={cn(inputCls, 'flex-1')} spellCheck={false} />
                    <button className="text-sm text-text-muted hover:text-error" onClick={() => removeFilter(i)}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            {(method === 'POST' || method === 'PATCH') && (
              <label className="flex flex-col gap-1 text-sm text-text-light">
                JSON body
                <Textarea value={bodyText} onChange={(e) => setBodyText(e.target.value)} spellCheck={false} className="min-h-20 font-mono" />
              </label>
            )}

            {method === 'GET' && (
              <label className="flex flex-col gap-1 text-sm text-text-light">
                Embedded resources / raw extra params (item 136 — one <code>key=value</code> per line, e.g.{' '}
                <code>select=id,orders()</code> + <code>orders.customer_id=eq.1</code> + <code>orders.order=id.desc</code>)
                <Textarea value={extraParamsText} onChange={(e) => setExtraParamsText(e.target.value)} spellCheck={false} className="min-h-14 font-mono text-sm" />
              </label>
            )}

            <div>
              <button className={cn(btnCls, 'flex items-center gap-1.5')} onClick={runExplorer} disabled={runBusy}>
                <Play className="size-3.5" /> {runBusy ? 'Running…' : 'Run'}
              </button>
            </div>

            {runError && <p className="m-0 text-sm text-error">{runError}</p>}

            {runMeta && (
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-secondary/40 px-3 py-1.5 font-mono text-xs text-text-light">
                <span>{runMeta.status}</span>
                <span className="truncate">{runMeta.url}</span>
                {runMeta.contentRange && <span>Content-Range: {runMeta.contentRange}</span>}
                {runMeta.preferenceApplied && <span>Preference-Applied: {runMeta.preferenceApplied}</span>}
              </div>
            )}

            {runResult != null &&
              (runResult?.type === 'rows' ? (
                <DataGrid result={runResult as DataGridResult} />
              ) : (
                <pre className="m-0 rounded-md border border-border bg-secondary px-3 py-2 font-mono text-sm">{JSON.stringify(runResult, null, 2)}</pre>
              ))}
            {runResult == null && runMeta && <p className="m-0 text-sm text-text-light">(empty body — return=minimal or a plain DELETE)</p>}
          </>
        )}
      </div>
    </div>
  );
}
