import { useState } from 'react';
import { Search, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react';
import { getLogs } from '@/lib/engine/api.js';
import { ErrorBox } from './ErrorBox';
import { TimeRangePicker } from './TimeRangePicker';
import type { CatalogError } from '@/hooks/useCatalog';
import { cn } from '@/lib/utils';

interface LogRow {
  timestamp?: string;
  level?: string;
  target?: string;
  message?: string;
  msg?: string;
  raw?: string;
  fields?: Record<string, unknown>;
  [key: string]: unknown;
}

const HIST_N = 48;
const LEVEL_ORDER = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];

function countBy(arr: LogRow[], fn: (r: LogRow) => string) {
  const m: Record<string, number> = {};
  for (const x of arr) {
    const k = fn(x);
    m[k] = (m[k] ?? 0) + 1;
  }
  return m;
}

function levelColor(l: string | undefined) {
  const u = String(l ?? '').toUpperCase();
  if (u === 'ERROR') return 'var(--error)';
  if (u === 'WARN') return 'var(--warn)';
  if (u === 'DEBUG' || u === 'TRACE') return 'var(--text-muted)';
  return 'var(--brand)';
}
function levelTextClass(l: string | undefined) {
  const u = String(l ?? '').toUpperCase();
  if (u === 'ERROR') return 'text-error';
  if (u === 'WARN') return 'text-warn';
  if (u === 'DEBUG' || u === 'TRACE') return 'text-text-muted';
  return 'text-brand';
}
function getMsg(row: LogRow) {
  return (row.fields?.message as string) ?? row.message ?? row.msg ?? row.raw ?? '';
}
function fmtTs(ts: string | undefined) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString(undefined, { hour12: false });
  } catch {
    return ts;
  }
}
function extras(row: LogRow) {
  const { timestamp: _t, level: _l, target: _tg, message, msg, raw, fields, ...rest } = row;
  const merged: Record<string, unknown> = { ...(fields ?? {}), ...rest };
  if (message !== undefined) merged.message = message;
  if (msg !== undefined) merged.msg = msg;
  return merged;
}

function buildHist(logs: LogRow[], since: string, until: string, n: number) {
  const t0 = since ? new Date(since).getTime() : null;
  const t1 = until ? new Date(until).getTime() : Date.now();
  if (!t0 || !logs.length) return new Array(n).fill(0);
  const span = t1 - t0;
  if (span <= 0) return new Array(n).fill(0);
  const bms = span / n;
  const counts = new Array(n).fill(0);
  for (const log of logs) {
    if (!log.timestamp) continue;
    const t = new Date(log.timestamp).getTime();
    const idx = Math.min(Math.floor((t - t0) / bms), n - 1);
    if (idx >= 0) counts[idx]++;
  }
  return counts;
}

// Real clock-hour boundaries aligned to the time range. Step adapts to span
// so labels never crowd: 10m / 30m / 1h / 2h / 6h / 12h / 24h.
function buildTimeLabels(since: string, until: string) {
  const t0 = since ? new Date(since).getTime() : null;
  const t1 = until ? new Date(until).getTime() : Date.now();
  if (!t0) return [] as { pct: number; label: string }[];
  const span = t1 - t0;
  const spanH = span / 3_600_000;
  const stepH = spanH <= 1 ? 1 / 6 : spanH <= 3 ? 0.5 : spanH <= 12 ? 1 : spanH <= 48 ? 2 : spanH <= 168 ? 6 : spanH <= 336 ? 12 : 24;
  const stepMs = stepH * 3_600_000;
  const first = Math.ceil(t0 / stepMs) * stepMs;
  const out: { pct: number; label: string }[] = [];
  for (let t = first; t <= t1; t += stepMs) {
    const pct = ((t - t0) / span) * 100;
    const d = new Date(t);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    out.push({ pct, label: stepH >= 1 ? `${hh}:00` : `${hh}:${mm}` });
  }
  return out;
}

export function LogsPanel() {
  const [since, setSince] = useState(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  const [until, setUntil] = useState('');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(200);

  const [excLevels, setExcLevels] = useState<Set<string>>(new Set());
  const [excTargets, setExcTargets] = useState<Set<string>>(new Set());

  const [logs, setLogs] = useState<LogRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [scanned, setScanned] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<CatalogError | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [secTime, setSecTime] = useState(true);
  const [secType, setSecType] = useState(true);
  const [secLevel, setSecLevel] = useState(true);

  const targetCounts = countBy(logs, (r) => r.target ?? '');
  const levelCounts = countBy(logs, (r) => (r.level ?? '').toUpperCase());
  const allTargets = Object.keys(targetCounts).sort();
  const allLevels = LEVEL_ORDER.filter((l) => levelCounts[l]);

  const visible = logs.filter((r) => {
    if (excLevels.size && excLevels.has((r.level ?? '').toUpperCase())) return false;
    if (excTargets.size && excTargets.has(r.target ?? '')) return false;
    return true;
  });

  const histogram = buildHist(logs, since, until, HIST_N);
  const histMax = Math.max(...histogram, 1);
  const timeLabels = buildTimeLabels(since, until);

  function toggleExc(set: Set<string>, key: string) {
    const n = new Set(set);
    n.has(key) ? n.delete(key) : n.add(key);
    return n;
  }

  async function search({ append = false } = {}) {
    setLoading(true);
    setError(null);
    try {
      const out = await getLogs({ since: since || undefined, until: until || undefined, q: q || undefined, limit, cursor: append ? (cursor ?? undefined) : undefined });
      setSupported(out.supported);
      if (!out.supported) {
        setLogs([]);
        return;
      }
      setLogs((prev) => (append ? [...prev, ...out.logs] : out.logs));
      setCursor(out.next_cursor);
      setScanned(out.scanned);
      setTruncated(out.truncated);
      if (!append) {
        setExpanded(new Set());
        setExcLevels(new Set());
        setExcTargets(new Set());
      }
    } catch (e: any) {
      setError({ code: e?.code, message: e?.message ?? String(e), status: e?.status });
    } finally {
      setLoading(false);
    }
  }

  function onTimeApply({ since: s, until: u }: { since: string; until: string }) {
    setSince(s);
    setUntil(u);
    // Fetch with the new range explicitly — state updates are async, so
    // `search()` itself always reads the params it needs from its own args
    // rather than relying on `since`/`until` having flushed yet.
    searchWithRange(s, u);
  }

  async function searchWithRange(s: string, u: string) {
    setLoading(true);
    setError(null);
    try {
      const out = await getLogs({ since: s || undefined, until: u || undefined, q: q || undefined, limit });
      setSupported(out.supported);
      if (!out.supported) {
        setLogs([]);
        return;
      }
      setLogs(out.logs);
      setCursor(out.next_cursor);
      setScanned(out.scanned);
      setTruncated(out.truncated);
      setExpanded(new Set());
      setExcLevels(new Set());
      setExcTargets(new Set());
    } catch (e: any) {
      setError({ code: e?.code, message: e?.message ?? String(e), status: e?.status });
    } finally {
      setLoading(false);
    }
  }

  function toggle(i: number) {
    const n = new Set(expanded);
    n.has(i) ? n.delete(i) : n.add(i);
    setExpanded(n);
  }

  return (
    <div className="relative flex h-full gap-0 overflow-hidden">
      <button
        className="absolute top-2.5 left-0 z-10 flex size-[22px] items-center justify-center rounded-sm border border-border bg-card text-text-muted transition-transform hover:border-border-strong hover:text-foreground"
        style={{ transform: sidebarOpen ? 'translateX(210px)' : 'translateX(4px)' }}
        onClick={() => setSidebarOpen((v) => !v)}
        title={sidebarOpen ? 'Collapse filters' : 'Expand filters'}
        aria-label={sidebarOpen ? 'Collapse filters' : 'Expand filters'}
      >
        {sidebarOpen ? <ChevronLeft className="size-3.5" /> : <ChevronRight className="size-3.5" />}
      </button>

      <aside
        className={cn('flex flex-col overflow-y-auto border-r border-border pb-6 transition-[width,opacity]', sidebarOpen ? 'w-[232px]' : 'w-0 overflow-hidden border-r-0 p-0 opacity-0')}
      >
        <div className="border-b border-border-muted">
          <button className="flex w-full items-center gap-1.5 px-3.5 py-2 text-left text-md font-semibold hover:bg-accent" onClick={() => setSecTime((v) => !v)}>
            <span className="flex-1">Time Range</span>
            <ChevronDown className={cn('size-3 opacity-50 transition-transform', secTime && 'rotate-180')} />
          </button>
          {secTime && (
            <div className="px-3.5 pb-2">
              <TimeRangePicker onApply={onTimeApply} />
            </div>
          )}
        </div>

        <div className="border-b border-border-muted">
          <button className="flex w-full items-center gap-1.5 px-3.5 py-2 text-left text-md font-semibold hover:bg-accent" onClick={() => setSecType((v) => !v)}>
            <span className="flex-1">Log Type</span>
            {excTargets.size > 0 && <span className="rounded-full bg-brand px-1.5 text-[10px] font-medium text-brand-text-on">{excTargets.size} hidden</span>}
            <ChevronDown className={cn('size-3 opacity-50 transition-transform', secType && 'rotate-180')} />
          </button>
          {secType && (
            <div className="pb-2">
              {!allTargets.length ? (
                <p className="m-0 px-3.5 py-1 text-sm text-text-muted">Run Search to populate.</p>
              ) : (
                allTargets.map((t) => (
                  <label key={t} className="flex items-center gap-1.5 px-3.5 py-1 text-md hover:bg-accent">
                    <input type="checkbox" checked={!excTargets.has(t)} onChange={() => setExcTargets((s) => toggleExc(s, t))} />
                    <span className="flex-1 truncate font-mono text-sm">{t || '(unknown)'}</span>
                    <span className="min-w-6 text-right text-xs text-text-muted">{targetCounts[t] ?? 0}</span>
                  </label>
                ))
              )}
            </div>
          )}
        </div>

        <div>
          <button className="flex w-full items-center gap-1.5 px-3.5 py-2 text-left text-md font-semibold hover:bg-accent" onClick={() => setSecLevel((v) => !v)}>
            <span className="flex-1">Level</span>
            {excLevels.size > 0 && <span className="rounded-full bg-brand px-1.5 text-[10px] font-medium text-brand-text-on">{excLevels.size} hidden</span>}
            <ChevronDown className={cn('size-3 opacity-50 transition-transform', secLevel && 'rotate-180')} />
          </button>
          {secLevel && (
            <div className="pb-2">
              {!allLevels.length ? (
                <p className="m-0 px-3.5 py-1 text-sm text-text-muted">Run Search to populate.</p>
              ) : (
                allLevels.map((lv) => (
                  <label key={lv} className="flex items-center gap-1.5 px-3.5 py-1 text-md hover:bg-accent">
                    <input type="checkbox" checked={!excLevels.has(lv)} onChange={() => setExcLevels((s) => toggleExc(s, lv))} />
                    <span className="size-2 shrink-0 rounded-sm" style={{ background: levelColor(lv) }} />
                    <span className="flex-1 text-sm">{lv}</span>
                    <span className="min-w-6 text-right text-xs text-text-muted">{levelCounts[lv] ?? 0}</span>
                  </label>
                ))
              )}
            </div>
          )}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5 overflow-hidden pl-[30px]">
        <div className="flex items-center gap-2">
          <div className="flex flex-1 items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5">
            <Search className="size-3.5 shrink-0 opacity-40" />
            <input
              className="flex-1 bg-transparent text-md text-foreground outline-none"
              type="text"
              placeholder="Search logs…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && search()}
            />
          </div>
          <label className="flex items-center gap-1.5 text-sm whitespace-nowrap text-text-muted">
            Limit
            <input
              className="h-8 w-[60px] rounded-md border border-border bg-secondary px-1.5 text-md"
              type="number"
              min={1}
              max={500}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            />
          </label>
          <button
            className="h-8 rounded-md bg-brand px-3 text-md whitespace-nowrap text-brand-text-on hover:bg-brand-hover disabled:opacity-60"
            onClick={() => search()}
            disabled={loading}
          >
            {loading ? 'Searching…' : 'Search'}
          </button>
        </div>

        {error && (
          <>
            <ErrorBox error={error} />
            {error.status === 403 && (
              <p className="m-0 text-sm text-text-light">
                <code>/logs</code> is superuser-gated — use a superuser token.
              </p>
            )}
          </>
        )}

        {!supported ? (
          <p className="text-sm text-text-light">
            This server doesn't expose <code>GET /logs</code>. Rebuild from a build that includes item 22 (logs surface).
          </p>
        ) : (
          <>
            {logs.length > 0 && (
              <>
                <div className="overflow-visible rounded-md border border-border bg-secondary" aria-hidden="true">
                  <div className="px-0.5">
                    <svg className="block h-12 w-full rounded-t" viewBox={`0 0 ${HIST_N * 11} 48`} preserveAspectRatio="none">
                      {histogram.map((count, i) => {
                        const h = Math.max(count ? 3 : 0, Math.round((count / histMax) * 40));
                        return <rect key={i} x={i * 11 + 1} y={48 - h - 2} width={9} height={h} rx={1.5} fill="var(--brand)" opacity={count ? 0.65 : 0.1} />;
                      })}
                    </svg>
                    <div className="relative h-5 overflow-visible border-t border-border bg-secondary">
                      {timeLabels.map((lbl, i) => {
                        const isFirst = i === 0;
                        const isLast = i === timeLabels.length - 1;
                        const leftVal = isLast ? '100%' : `${lbl.pct}%`;
                        const tx = isFirst ? '0%' : isLast ? '-100%' : '-50%';
                        return (
                          <span
                            key={i}
                            className="absolute top-[3px] font-mono text-[10px] leading-none whitespace-nowrap text-text-muted"
                            style={{ left: leftVal, transform: `translateX(${tx})` }}
                          >
                            {lbl.label}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                </div>
                <div className="flex gap-1.5 px-0.5 text-sm text-text-muted">
                  <span>
                    {visible.length}
                    {excLevels.size || excTargets.size ? ` of ${logs.length}` : ''} shown
                  </span>
                  <span>·</span>
                  <span>{scanned.toLocaleString()} scanned</span>
                  {truncated && <span>· scan budget hit</span>}
                </div>
              </>
            )}

            {visible.length > 0 ? (
              <>
                <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
                  <table className="w-full table-fixed border-collapse font-mono text-sm">
                    <thead>
                      <tr>
                        <th className="w-14 bg-secondary px-2.5 py-1.5 text-left text-xs font-semibold text-text-muted">Level</th>
                        <th className="w-[152px] bg-secondary px-2.5 py-1.5 text-left text-xs font-semibold text-text-muted">Timestamp</th>
                        <th className="w-[148px] bg-secondary px-2.5 py-1.5 text-left text-xs font-semibold text-text-muted">Target</th>
                        <th className="bg-secondary px-2.5 py-1.5 text-left text-xs font-semibold text-text-muted">Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((row, i) => (
                        <>
                          <tr
                            key={i}
                            className={cn('cursor-pointer border-b border-border hover:bg-secondary', expanded.has(i) && 'bg-secondary')}
                            role="button"
                            tabIndex={0}
                            onClick={() => toggle(i)}
                            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle(i))}
                          >
                            <td className="overflow-hidden px-2.5 py-1 whitespace-nowrap">
                              <span className={cn('text-xs font-bold', levelTextClass(row.level))}>{(row.level ?? '·').toUpperCase()}</span>
                            </td>
                            <td className="overflow-hidden px-2.5 py-1 text-xs text-text-muted whitespace-nowrap">{fmtTs(row.timestamp)}</td>
                            <td className="overflow-hidden px-2.5 py-1 text-sm text-brand/85 whitespace-nowrap">{row.target ?? ''}</td>
                            <td className="overflow-hidden px-2.5 py-1 whitespace-nowrap text-foreground">{getMsg(row)}</td>
                          </tr>
                          {expanded.has(i) && (
                            <tr className="border-b border-border bg-secondary">
                              <td colSpan={4} className="p-0">
                                <pre className="m-0 overflow-x-auto p-3 text-sm whitespace-pre">{JSON.stringify(extras(row), null, 2)}</pre>
                              </td>
                            </tr>
                          )}
                        </>
                      ))}
                    </tbody>
                  </table>
                </div>

                {cursor ? (
                  <button className="self-start py-1 text-md text-brand hover:underline disabled:opacity-60" onClick={() => search({ append: true })} disabled={loading}>
                    Load older →
                  </button>
                ) : (
                  <p className="text-center text-sm text-text-light">End of results.</p>
                )}
              </>
            ) : !loading && logs.length ? (
              <p className="text-sm text-text-light">All results filtered out — uncheck some filters on the left.</p>
            ) : !loading ? (
              <p className="text-sm text-text-light">No log lines. Set a time range and Search — results are newest-first.</p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
