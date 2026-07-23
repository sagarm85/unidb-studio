import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RefreshCw } from 'lucide-react';
import { getStats, getStatsHistory } from '@/lib/engine/api.js';
import { formatMicros, formatCount, formatDuration } from '@/lib/engine/format.js';
import { subscribeQueryHistory, getQueryHistory, clearQueryHistory } from '@/lib/engine/queryStore.js';
import { ErrorBox } from './ErrorBox';
import { MetricChart, type MetricPoint } from './MetricChart';
import type { CatalogError } from '@/hooks/useCatalog';
import { cn } from '@/lib/utils';

const REFRESH_MS = 5000;
const MAX_HISTORY = 60; // 5 min at 5s intervals
const KINDS = ['select', 'insert', 'update', 'delete'] as const;

interface HistoryPoint {
  t: number;
  activeTxns: number;
  hitRatio: number | null;
  commitsPerSec: number | null;
  walBytesPerSec: number | null;
}

function serverPointToLocal(p: any): HistoryPoint {
  return {
    t: p.t,
    activeTxns: p.active_transactions ?? 0,
    hitRatio: p.bufferpool_hit_ratio != null ? p.bufferpool_hit_ratio * 100 : null,
    commitsPerSec: p.commits_per_sec ?? 0,
    walBytesPerSec: p.wal_bytes_per_sec ?? 0,
  };
}

function fmtRate(v: number | null) {
  if (v == null) return '—';
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k/s`;
  return `${v.toFixed(1)}/s`;
}
function fmtBytes(v: number | null) {
  if (v == null) return '—';
  if (v >= 1_048_576) return `${(v / 1_048_576).toFixed(1)} MB/s`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB/s`;
  return `${v.toFixed(0)} B/s`;
}
function fmtPct(v: number | null) {
  return v == null ? '—' : `${v.toFixed(1)}%`;
}
function relTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 2000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return new Date(iso).toLocaleTimeString();
}

export function ObservabilityPanel() {
  const [stats, setStats] = useState<any>(null);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<CatalogError | null>(null);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(true);
  const [subTab, setSubTab] = useState<'overview' | 'queries'>('overview');
  const [history, setHistory] = useState<HistoryPoint[]>([]);

  const queryHistory = useSyncExternalStore(subscribeQueryHistory, getQueryHistory, getQueryHistory);
  const obsBodyRef = useRef<HTMLDivElement>(null);

  const historyRef = useRef(history);
  historyRef.current = history;

  async function load() {
    try {
      const out = await getStats();
      setSupported(out.supported);
      if (out.supported) {
        const s = out.stats as any;
        setStats(s);
        const point = serverPointToLocal({
          t: Date.now(),
          active_transactions: s.active_transactions,
          bufferpool_hit_ratio: s.bufferpool?.hit_ratio,
          commits_per_sec: null,
          wal_bytes_per_sec: null,
        });
        // Carry server rates from the most recent history point if available.
        const last = historyRef.current[historyRef.current.length - 1];
        if (last) {
          point.commitsPerSec = last.commitsPerSec;
          point.walBytesPerSec = last.walBytesPerSec;
        }
        setHistory((h) => [...h.slice(-(MAX_HISTORY - 1)), point]);
      }
      setError(null);
    } catch (e: any) {
      setError({ code: e?.code, message: e?.message ?? String(e), status: e?.status });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Prefill charts from engine ring buffer before starting the live poll.
    getStatsHistory({ points: MAX_HISTORY })
      .then(({ points }: { points: any[] }) => {
        if (points.length) setHistory(points.map(serverPointToLocal));
      })
      .catch(() => {});

    load();
    if (!live) return;
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  function switchTab(t: 'overview' | 'queries') {
    setSubTab(t);
    obsBodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const latency = stats?.statement_latency ?? {};
  const bp = stats?.bufferpool ?? null;
  const locks = stats?.locks ?? null;
  const fsync = stats?.wal_fsync_latency ?? null;
  const workers = stats?.parallel_workers ?? null;
  const tables = stats?.tables ?? [];
  const horizon = stats?.horizon_age_secs ?? null;

  const horizonLevel = horizon == null ? 'ok' : horizon >= 300 ? 'bad' : horizon >= 30 ? 'warn' : 'ok';
  const hitRatio = bp?.hit_ratio != null ? `${(bp.hit_ratio * 100).toFixed(1)}%` : '—';
  const totalQueries = KINDS.reduce((s, k) => s + (latency[k]?.count ?? 0), 0);
  const slowCount = stats?.recent_slow_queries?.length ?? 0;

  function toSeries(key: keyof HistoryPoint): MetricPoint[] {
    return history.map((p) => ({ t: p.t, v: (p[key] as number | null) ?? null }));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Header sits outside the scroll area so it can never scroll off screen */}
      <div className="flex shrink-0 items-center gap-2.5 border-b border-border pb-0.5">
        <div className="flex">
          {(['overview', 'queries'] as const).map((t) => (
            <button
              key={t}
              className={cn(
                '-mb-px rounded-t-md border-b-2 border-transparent px-4 py-1.5 text-md font-medium text-text-light',
                subTab === t ? 'border-brand bg-brand-subtle text-brand' : 'hover:text-foreground',
              )}
              onClick={() => switchTab(t)}
            >
              {t === 'overview' ? 'Overview' : 'Query Performance'}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <input type="checkbox" id="obs-live" checked={live} onChange={(e) => setLive(e.target.checked)} className="cursor-pointer" />
        <label htmlFor="obs-live" className="cursor-pointer text-sm text-text-light select-none">
          Live ({REFRESH_MS / 1000}s)
        </label>
        <button className="flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1 text-sm hover:border-border-strong" onClick={load} title="Refresh now">
          <RefreshCw className="size-3" />
          Refresh
        </button>
      </div>

      <div ref={obsBodyRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-6">
        {error && <ErrorBox error={error} />}

        {!supported ? (
          <p className="text-md text-text-light">
            This server doesn't expose <code>GET /stats</code>. Rebuild <code>unidb-server</code> from a build that includes
            observability metrics.
          </p>
        ) : loading && !stats ? (
          <p className="text-md text-text-light">Loading metrics…</p>
        ) : stats ? (
          subTab === 'overview' ? (
            <>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2.5">
                <Kpi label="Total queries" value={formatCount(totalQueries)} />
                <Kpi label="Slow queries" value={String(slowCount)} tone={slowCount > 0 ? 'warn' : undefined} />
                <Kpi label="Cache hit rate" value={hitRatio} tone="brand" />
                <Kpi label="Active txns" value={formatCount(stats.active_transactions)} />
                <Kpi label="Deadlocks" value={formatCount(locks?.deadlocks)} tone={locks?.deadlocks > 0 ? 'bad' : undefined} />
                <Kpi label="Vacuum horizon" value={formatDuration(horizon)} tone={horizonLevel === 'ok' ? undefined : (horizonLevel as 'warn' | 'bad')} />
              </div>

              <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3.5">
                <MetricChart points={toSeries('activeTxns')} label="Active transactions" unit="count" fmt={(v) => v?.toFixed(0) ?? '—'} />
                <MetricChart points={toSeries('hitRatio')} label="Cache hit rate" unit="%" fmt={fmtPct} />
                <MetricChart points={toSeries('commitsPerSec')} label="Commits / sec" unit="txn/s" fmt={fmtRate} />
                <MetricChart points={toSeries('walBytesPerSec')} label="WAL throughput" unit="bytes/s" fmt={fmtBytes} />
              </div>

              <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
                <Card title="Throughput">
                  <Dl>
                    <Dt>Commits</Dt>
                    <Dd>{formatCount(stats.commits)}</Dd>
                    <Dt>Aborts</Dt>
                    <Dd>{formatCount(stats.aborts)}</Dd>
                    <Dt>Checkpoints</Dt>
                    <Dd>{formatCount(stats.checkpoints)}</Dd>
                    <Dt>Autovacuums</Dt>
                    <Dd>{formatCount(stats.autovacuums)}</Dd>
                  </Dl>
                </Card>

                <Card title="Sessions">
                  <Dl>
                    <Dt>Open txn sessions</Dt>
                    <Dd>{formatCount(stats.open_txn_sessions)}</Dd>
                    <Dt>Open cursors</Dt>
                    <Dd>{formatCount(stats.open_cursors)}</Dd>
                    <Dt>Idle-reaper aborts</Dt>
                    <Dd>{formatCount(stats.idle_reaper_aborts)}</Dd>
                  </Dl>
                </Card>

                {bp && (
                  <Card title="Buffer pool">
                    <Dl>
                      <Dt>Hit ratio</Dt>
                      <Dd className="font-bold text-brand">{hitRatio}</Dd>
                      <Dt>Hits</Dt>
                      <Dd>{formatCount(bp.hits)}</Dd>
                      <Dt>Misses</Dt>
                      <Dd>{formatCount(bp.misses)}</Dd>
                      <Dt>Evictions</Dt>
                      <Dd>{formatCount(bp.evictions)}</Dd>
                    </Dl>
                  </Card>
                )}

                {locks && (
                  <Card title="Contention">
                    <Dl>
                      <Dt>Lock waits</Dt>
                      <Dd>{formatCount(locks.waits)}</Dd>
                      <Dt>Deadlocks</Dt>
                      <Dd className={locks.deadlocks > 0 ? 'font-bold text-error' : ''}>{formatCount(locks.deadlocks)}</Dd>
                      <Dt>Wait p50</Dt>
                      <Dd>{formatMicros(locks.wait?.p50_us)}</Dd>
                      <Dt>Wait p99</Dt>
                      <Dd>{formatMicros(locks.wait?.p99_us)}</Dd>
                    </Dl>
                  </Card>
                )}

                <Card title="WAL / Durability">
                  <Dl>
                    <Dt>fsyncs</Dt>
                    <Dd>{formatCount(stats.wal_fsyncs)}</Dd>
                    <Dt>fsync p50</Dt>
                    <Dd>{formatMicros(fsync?.p50_us)}</Dd>
                    <Dt>fsync p99</Dt>
                    <Dd>{formatMicros(fsync?.p99_us)}</Dd>
                    <Dt>WAL bytes</Dt>
                    <Dd>{formatCount(stats.wal_bytes)}</Dd>
                  </Dl>
                </Card>

                {workers && (
                  <Card title="Parallel workers">
                    <Dl>
                      <Dt>Budget</Dt>
                      <Dd>{formatCount(workers.global_max)}</Dd>
                      <Dt>Available</Dt>
                      <Dd>{formatCount(workers.available)}</Dd>
                      <Dt>Active scans</Dt>
                      <Dd>{formatCount(workers.parallel_scans)}</Dd>
                      <Dt>Serial fallbacks</Dt>
                      <Dd>{formatCount(workers.serial_fallbacks)}</Dd>
                    </Dl>
                  </Card>
                )}
              </div>

              {tables.length > 0 && (
                <section className="rounded-lg border border-border bg-card p-3.5">
                  <h4 className="m-0 mb-2.5 flex flex-wrap items-baseline gap-2 text-md font-semibold">
                    Table health
                    <span className="text-xs font-normal text-text-muted">
                      dead ≈ {formatCount(stats.dead_tuple_estimate)} · live ≈ {formatCount(stats.live_tuple_estimate)}
                    </span>
                  </h4>
                  <table className="w-full border-collapse text-md">
                    <thead>
                      <tr>
                        <th className="border-b border-border px-2.5 py-1.5 text-left text-xs font-semibold tracking-wide text-text-muted uppercase">Table</th>
                        <th className="border-b border-border px-2.5 py-1.5 text-left text-xs font-semibold tracking-wide text-text-muted uppercase">Pages</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tables.map((t: any) => (
                        <tr key={t.name} className="hover:bg-secondary">
                          <td className="border-b border-border px-2.5 py-1.5 font-mono">{t.name}</td>
                          <td className="border-b border-border px-2.5 py-1.5 font-mono">{formatCount(t.pages)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}
            </>
          ) : (
            <>
              <section className="rounded-lg border border-border bg-card p-3.5">
                <h4 className="m-0 mb-2.5 flex items-baseline gap-2 text-md font-semibold">
                  Statement latency <span className="text-xs font-normal text-text-muted">p50/p99 are log-bucket estimates</span>
                </h4>
                <table className="w-full border-collapse text-md">
                  <thead>
                    <tr>
                      <th className="border-b border-border px-2.5 py-1.5 text-left text-xs font-semibold tracking-wide text-text-muted uppercase">Kind</th>
                      <th className="border-b border-border px-2.5 py-1.5 text-right text-xs font-semibold tracking-wide text-text-muted uppercase">Calls</th>
                      <th className="border-b border-border px-2.5 py-1.5 text-right text-xs font-semibold tracking-wide text-text-muted uppercase">Mean</th>
                      <th className="border-b border-border px-2.5 py-1.5 text-right text-xs font-semibold tracking-wide text-text-muted uppercase">p50</th>
                      <th className="border-b border-border px-2.5 py-1.5 text-right text-xs font-semibold tracking-wide text-text-muted uppercase">p99</th>
                    </tr>
                  </thead>
                  <tbody>
                    {KINDS.map((k) => {
                      const row = latency[k] ?? {};
                      return (
                        <tr key={k} className="hover:bg-secondary">
                          <td className="border-b border-border px-2.5 py-1.5">
                            <KindChip kind={k} />
                          </td>
                          <td className="border-b border-border px-2.5 py-1.5 text-right font-mono">{formatCount(row.count)}</td>
                          <td className="border-b border-border px-2.5 py-1.5 text-right font-mono">{formatMicros(row.mean_us)}</td>
                          <td className="border-b border-border px-2.5 py-1.5 text-right font-mono">{formatMicros(row.p50_us)}</td>
                          <td className="border-b border-border px-2.5 py-1.5 text-right font-mono">{formatMicros(row.p99_us)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>

              <section className="rounded-lg border border-border bg-card p-3.5">
                <h4 className="m-0 mb-2.5 text-md font-semibold">
                  Recent slow queries
                  {slowCount > 0 && (
                    <span className="ml-2 inline-flex h-[18px] min-w-5 items-center justify-center rounded-full bg-error px-1.5 text-xs font-bold text-background">
                      {slowCount}
                    </span>
                  )}
                </h4>
                {stats.recent_slow_queries?.length ? (
                  <table className="w-full border-collapse text-md">
                    <thead>
                      <tr>
                        <th className="border-b border-border px-2.5 py-1.5 text-left text-xs font-semibold tracking-wide text-text-muted uppercase">Query</th>
                        <th className="w-[110px] border-b border-border px-2.5 py-1.5 text-right text-xs font-semibold tracking-wide text-text-muted uppercase">Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.recent_slow_queries.map((sq: any, i: number) => (
                        <tr key={i} className="hover:bg-secondary">
                          <td className="max-w-[640px] truncate border-b border-border px-2.5 py-1.5 font-mono" title={sq.sql}>
                            {sq.sql}
                          </td>
                          <td className="border-b border-border px-2.5 py-1.5 text-right font-mono">{formatMicros(sq.micros)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="my-1 text-md text-text-light">
                    No slow queries recorded — set <code>UNIDB_SLOW_QUERY_MS</code> on the engine to enable threshold logging.
                  </p>
                )}
              </section>

              <section className="rounded-lg border border-border bg-card p-3.5">
                <div className="mb-2.5 flex items-baseline justify-between">
                  <h4 className="m-0 text-md font-semibold">
                    Query history <span className="text-xs font-normal text-text-muted">browser round-trip time · this session</span>
                  </h4>
                  <button className="rounded-sm border border-border px-2.5 py-0.5 text-sm text-text-light hover:text-foreground" onClick={() => clearQueryHistory()}>
                    Clear
                  </button>
                </div>
                {queryHistory.length === 0 ? (
                  <p className="my-1 text-md text-text-light">No queries yet — run SQL from the editor or Record Browser.</p>
                ) : (
                  <table className="w-full border-collapse text-md">
                    <thead>
                      <tr>
                        <th className="w-20 border-b border-border px-2.5 py-1.5 text-left text-xs font-semibold tracking-wide text-text-muted uppercase">When</th>
                        <th className="w-16 border-b border-border px-2.5 py-1.5 text-left text-xs font-semibold tracking-wide text-text-muted uppercase">Kind</th>
                        <th className="w-[90px] border-b border-border px-2.5 py-1.5 text-right text-xs font-semibold tracking-wide text-text-muted uppercase">Duration</th>
                        <th className="w-16 border-b border-border px-2.5 py-1.5 text-right text-xs font-semibold tracking-wide text-text-muted uppercase">Rows</th>
                        <th className="border-b border-border px-2.5 py-1.5 text-left text-xs font-semibold tracking-wide text-text-muted uppercase">SQL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {queryHistory.map((q: any) => (
                        <tr key={q.id} className={cn('hover:bg-secondary', q.status === 'error' && 'bg-error-subtle')}>
                          <td className="border-b border-border px-2.5 py-1.5 font-mono text-text-muted">{relTime(q.timestamp)}</td>
                          <td className="border-b border-border px-2.5 py-1.5">
                            <KindChip kind={q.kind} />
                          </td>
                          <td
                            className={cn(
                              'border-b border-border px-2.5 py-1.5 text-right font-mono',
                              q.durationMs < 50 ? 'text-ok' : q.durationMs < 500 ? 'text-warn' : 'text-error',
                            )}
                          >
                            {q.durationMs} ms
                          </td>
                          <td className="border-b border-border px-2.5 py-1.5 text-right font-mono text-text-muted">{q.rowCount > 0 ? q.rowCount : '—'}</td>
                          <td className="max-w-[640px] truncate border-b border-border px-2.5 py-1.5 font-mono" title={q.sql}>
                            {q.sql}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            </>
          )
        ) : null}
      </div>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'bad' | 'brand' }) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-lg border border-border bg-card p-4',
        tone === 'warn' && 'border-warn/50 bg-warn-subtle',
        tone === 'bad' && 'border-error/50 bg-error-subtle',
      )}
    >
      <span className="text-xs font-semibold tracking-wide text-text-muted uppercase">{label}</span>
      <span className={cn('font-mono text-2xl leading-none font-bold', tone === 'brand' && 'text-brand')}>{value}</span>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-3.5">
      <h4 className="m-0 mb-2.5 text-md font-semibold">{title}</h4>
      {children}
    </section>
  );
}
function Dl({ children }: { children: React.ReactNode }) {
  return <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-md">{children}</dl>;
}
function Dt({ children }: { children: React.ReactNode }) {
  return <dt className="text-text-muted">{children}</dt>;
}
function Dd({ children, className }: { children: React.ReactNode; className?: string }) {
  return <dd className={cn('m-0 text-right font-mono', className)}>{children}</dd>;
}

const KIND_CLASSES: Record<string, string> = {
  select: 'bg-info/12 text-info',
  insert: 'bg-ok-subtle text-ok',
  update: 'bg-warn-subtle text-warn',
  delete: 'bg-error-subtle text-error',
};
function KindChip({ kind }: { kind: string }) {
  return <span className={cn('rounded-sm px-2 py-0.5 font-mono text-xs font-bold tracking-wide uppercase', KIND_CLASSES[kind])}>{kind}</span>;
}
