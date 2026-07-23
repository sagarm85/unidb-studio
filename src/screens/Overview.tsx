import { useEffect, useState } from 'react';
import { Table2, Terminal, Network } from 'lucide-react';
import { BASE_URL, IS_CONFIGURED, getToken, getStats, getStatsHistory } from '@/lib/engine/api.js';
import { StatCard } from '@/components/StatCard';
import { EmptyState } from '@/components/EmptyState';
import { MetricChart, type MetricPoint } from '@/components/MetricChart';
import type { CatalogTable, CatalogError } from '@/hooks/useCatalog';

// Supabase-style landing page. Every value here comes from a live engine call
// already used elsewhere in the app (GET /tables, the catalog probe, GET
// /stats + /stats/history, the bearer token). Nothing is invented — an
// unavailable source renders "—" / "Not available", never a fake number.

function decodeExp(t: string): number | null {
  try {
    const b64 = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}
function fmtRemaining(s: number): string {
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

const REFRESH_MS = 5000;
const MAX_HISTORY = 60;

function serverPointToLocal(p: any) {
  return {
    t: p.t,
    activeTxns: p.active_transactions ?? 0,
    hitRatio: p.bufferpool_hit_ratio != null ? p.bufferpool_hit_ratio * 100 : null,
  };
}

export function Overview({
  tables,
  tablesLoading,
  tablesError,
  catalogSource,
  onGoTab,
}: {
  tables: CatalogTable[];
  tablesLoading: boolean;
  tablesError: CatalogError | null;
  catalogSource: 'catalog' | 'tables';
  onGoTab: (tab: 'records' | 'sql' | 'schema') => void;
}) {
  // ---- token countdown (same unverified-`exp`-for-display approach as TokenStatus) ----
  const [token, setToken] = useState(getToken());
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  // Token can be regenerated elsewhere (TokenStatus); re-read on an interval
  // so Overview's countdown stays in sync without a shared store.
  useEffect(() => {
    const id = setInterval(() => setToken(getToken()), 1000);
    return () => clearInterval(id);
  }, []);
  const exp = decodeExp(token);
  const remaining = exp === null ? null : exp - now;
  const tokenActive = remaining !== null && remaining > 0;

  const [copied, setCopied] = useState(false);
  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(BASE_URL);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — no-op */
    }
  }

  // ---- status card ----
  const status: { label: string; tone: 'ok' | 'warn' | 'error' } = !IS_CONFIGURED
    ? { label: 'Not configured', tone: 'warn' }
    : tablesLoading
      ? { label: 'Connecting…', tone: 'warn' }
      : tablesError
        ? { label: 'Offline', tone: 'error' }
        : { label: 'Healthy', tone: 'ok' };

  // ---- metrics (reuses the same GET /stats + /stats/history calls as ObservabilityPanel) ----
  const [metricsSupported, setMetricsSupported] = useState(true);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [history, setHistory] = useState<{ t: number; activeTxns: number; hitRatio: number | null }[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function loadMetrics() {
      try {
        const out = await getStats();
        if (cancelled) return;
        setMetricsSupported(out.supported);
        if (out.supported) {
          const stats = out.stats as any;
          const point = serverPointToLocal({
            t: Date.now(),
            active_transactions: stats.active_transactions,
            bufferpool_hit_ratio: stats.bufferpool?.hit_ratio,
          });
          setHistory((h) => [...h.slice(-(MAX_HISTORY - 1)), point]);
        }
      } catch {
        if (!cancelled) setMetricsSupported(false);
      } finally {
        if (!cancelled) setMetricsLoading(false);
      }
    }

    getStatsHistory({ points: MAX_HISTORY })
      .then(({ points }: { points: any[] }) => {
        if (!cancelled && points.length) setHistory(points.map(serverPointToLocal));
      })
      .catch(() => {});

    loadMetrics();
    const id = setInterval(loadMetrics, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  function toSeries(key: 'activeTxns' | 'hitRatio'): MetricPoint[] {
    return history.map((p) => ({ t: p.t, v: p[key] ?? null }));
  }
  const fmtPct = (v: number | null) => (v == null ? '—' : `${v.toFixed(1)}%`);

  const QUICK_LINKS: { tab: 'records' | 'sql' | 'schema'; label: string; desc: string; icon: typeof Table2 }[] = [
    { tab: 'records', label: 'Table Editor', desc: 'Browse and edit rows', icon: Table2 },
    { tab: 'sql', label: 'SQL Editor', desc: 'Run queries against the engine', icon: Terminal },
    { tab: 'schema', label: 'Schema', desc: 'View tables and relationships', icon: Network },
  ];

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-8 p-8">
        <header>
          <h1 className="m-0 mb-2 text-xl font-semibold text-foreground">unidb studio</h1>
          {IS_CONFIGURED && (
            <div className="flex items-center gap-2">
              <code className="font-mono text-sm text-text-light">{BASE_URL}</code>
              <button
                className="rounded-sm border border-border bg-secondary px-2 py-0.5 text-xs text-text-light hover:border-border-strong hover:text-foreground"
                onClick={copyUrl}
                title="Copy server URL"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          )}
        </header>

        <section className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
          <StatCard label="Status" value={status.label} tone={status.tone} />
          <StatCard label="Tables" value={tablesLoading ? null : tables.length} />
          <StatCard label="Token" value={!token ? 'no token' : tokenActive ? fmtRemaining(remaining!) : 'expired'} />
          <StatCard label="Catalog" value={catalogSource === 'catalog' ? 'Full (M18)' : 'tables fallback'} />
        </section>

        <section>
          <h2 className="m-0 mb-4 text-lg font-medium text-foreground">Metrics</h2>
          {!metricsLoading && !metricsSupported ? (
            <EmptyState message="Metrics are not available on this server — GET /stats is not exposed." />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-4">
              <MetricChart points={toSeries('activeTxns')} label="Active transactions" unit="count" fmt={(v) => v?.toFixed(0) ?? '—'} />
              <MetricChart points={toSeries('hitRatio')} label="Cache hit rate" unit="%" fmt={fmtPct} />
            </div>
          )}
        </section>

        <section>
          <h2 className="m-0 mb-4 text-lg font-medium text-foreground">Quick links</h2>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
            {QUICK_LINKS.map((q) => (
              <button
                key={q.tab}
                className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:border-border-strong hover:bg-accent"
                onClick={() => onGoTab(q.tab)}
              >
                <q.icon className="size-5 shrink-0 text-brand" />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-md font-medium text-foreground">{q.label}</span>
                  <span className="text-sm text-text-light">{q.desc}</span>
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
