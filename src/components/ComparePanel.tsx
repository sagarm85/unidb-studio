import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

// Loads /benchmark-results.json written by demo/compare.py and renders a
// side-by-side unidb vs Postgres comparison with bar charts. Static file
// fetch (not an engine REST call — `demo/compare.py` writes it to `public/`).

interface QueryResult {
  label: string;
  unidb_ms: number | null;
  postgres_ms?: number | null;
  ratio?: number | null;
}
interface BenchmarkData {
  size: string;
  n_cust?: number;
  n_ord?: number;
  run_at: string;
  unidb_url: string;
  postgres_dsn?: string;
  summary?: { unidb_total_ms: number; postgres_total_ms: number; ratio?: number | null };
  queries: QueryResult[];
}

function ratioLabel(r: number | null | undefined) {
  if (r == null) return '';
  if (r < 0.95) return `unidb ${(1 / r).toFixed(2)}× faster`;
  if (r > 1.05) return `postgres ${r.toFixed(2)}× faster`;
  return 'roughly equal';
}
function ratioClass(r: number | null | undefined) {
  if (r == null) return 'text-text-muted';
  if (r < 0.8) return 'text-ok';
  if (r < 0.95) return 'text-ok/70';
  if (r > 1.25) return 'text-error';
  if (r > 1.05) return 'text-error/70';
  return 'text-text-muted';
}
function fmt(ms: number | null | undefined) {
  if (ms == null) return '—';
  return ms < 1000 ? `${ms.toFixed(1)} ms` : `${(ms / 1000).toFixed(2)} s`;
}
function relTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return new Date(iso).toLocaleTimeString();
}

export function ComparePanel() {
  const [data, setData] = useState<BenchmarkData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadResults() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/benchmark-results.json', { cache: 'no-store' });
      if (res.status === 404) {
        setData(null);
      } else if (!res.ok) {
        setError(`HTTP ${res.status}`);
      } else {
        setData(await res.json());
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadResults();
  }, []);

  const maxMs = data?.queries?.length ? Math.max(...data.queries.flatMap((q) => [q.unidb_ms ?? 0, q.postgres_ms ?? 0])) : 1;
  const barPct = (ms: number | null | undefined) => Math.min(100, ((ms ?? 0) / (maxMs || 1)) * 100);

  return (
    <div className="flex max-w-[960px] flex-col gap-4.5 text-md">
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <h2 className="m-0 text-lg font-medium text-foreground">unidb vs Postgres</h2>
          {data && (
            <>
              <span className="rounded-full bg-brand-subtle px-2 py-0.5 text-xs font-semibold text-brand">
                {data.size} · {data.n_cust?.toLocaleString()} customers · {data.n_ord?.toLocaleString()} orders
              </span>
              <span className="text-xs text-text-muted">run {relTime(data.run_at)}</span>
            </>
          )}
        </div>
        <button className="flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1 text-sm hover:border-border-strong" onClick={loadResults}>
          <RefreshCw className="size-3" /> Refresh
        </button>
      </div>

      {loading ? (
        <p className="p-10 text-center text-md text-text-light">Loading…</p>
      ) : error ? (
        <div className="rounded-lg border border-error/40 bg-error-subtle px-4 py-3 text-md text-error">Error loading results: {error}</div>
      ) : !data ? (
        <div className="rounded-lg border border-border bg-card p-5 leading-relaxed">
          <strong>No results yet.</strong> Run the comparison script to generate data:
          <pre className="mt-2.5 rounded-md bg-secondary p-2.5 text-sm">
            pip3 install psycopg2-binary{'\n'}python3 demo/compare.py --size 10k
          </pre>
          Then click <em>Refresh</em> above.
        </div>
      ) : (
        <>
          {data.summary && (
            <div className="flex flex-wrap items-center gap-4.5">
              <div className="min-w-40 rounded-lg border border-border border-l-4 border-l-brand bg-card p-3.5 px-5">
                <div className="text-xs tracking-wide text-text-muted uppercase">unidb</div>
                <div className="my-1 text-2xl font-bold">{fmt(data.summary.unidb_total_ms)}</div>
                <div className="text-xs text-text-muted">total across {data.queries.length} queries</div>
              </div>
              <div className="text-lg font-bold text-text-muted">vs</div>
              <div className="min-w-40 rounded-lg border border-border border-l-4 border-l-[#336791] bg-card p-3.5 px-5">
                <div className="text-xs tracking-wide text-text-muted uppercase">PostgreSQL 16</div>
                <div className="my-1 text-2xl font-bold">{fmt(data.summary.postgres_total_ms)}</div>
                <div className="text-xs text-text-muted">total across {data.queries.length} queries</div>
              </div>
              {data.summary.ratio != null && (
                <div className={cn('text-md font-semibold', ratioClass(data.summary.ratio))}>
                  {ratioLabel(data.summary.ratio)}
                  <div className="text-xs font-normal text-text-muted">overall</div>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col gap-3.5">
            {data.queries.map((q, i) => (
              <div key={i} className="rounded-lg border border-border bg-card p-3.5">
                <div className="mb-2 font-semibold">{q.label}</div>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <span className="w-[68px] shrink-0 text-[10px] font-bold tracking-wide text-brand uppercase">unidb</span>
                    <div className="h-3 flex-1 overflow-hidden rounded-sm bg-secondary">
                      <div className="h-full rounded-sm bg-brand opacity-80 transition-[width]" style={{ width: `${barPct(q.unidb_ms)}%` }} />
                    </div>
                    <span className="w-[70px] shrink-0 text-right text-sm tabular-nums">{fmt(q.unidb_ms)}</span>
                  </div>
                  {q.postgres_ms != null && (
                    <div className="flex items-center gap-2">
                      <span className="w-[68px] shrink-0 text-[10px] font-bold tracking-wide text-[#336791] uppercase">postgres</span>
                      <div className="h-3 flex-1 overflow-hidden rounded-sm bg-secondary">
                        <div className="h-full rounded-sm bg-[#336791] opacity-80 transition-[width]" style={{ width: `${barPct(q.postgres_ms)}%` }} />
                      </div>
                      <span className="w-[70px] shrink-0 text-right text-sm tabular-nums">{fmt(q.postgres_ms)}</span>
                    </div>
                  )}
                </div>
                {q.ratio != null && <div className={cn('mt-1.5 text-xs font-semibold', ratioClass(q.ratio))}>{ratioLabel(q.ratio)}</div>}
              </div>
            ))}
          </div>

          <div className="border-t border-border pt-2 text-xs leading-loose text-text-muted">
            unidb @ <code className="font-mono">{data.unidb_url}</code>
            {data.postgres_dsn && (
              <>
                {' '}
                · postgres DSN: <code className="font-mono">{data.postgres_dsn}</code>
              </>
            )}
            <br />
            <span>
              Timings are browser/script round-trip (network included). Run <code>python3 demo/compare.py --size 50k</code> to refresh.
            </span>
          </div>
        </>
      )}
    </div>
  );
}
