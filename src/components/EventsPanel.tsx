import { useEffect, useState, useSyncExternalStore } from 'react';
import { enableTableEvents, disableTableEvents, getCdcStatus, ackEvents, runSql } from '@/lib/engine/api.js';
import { subscribe, getSnapshot, startStream, stopStream, clearEvents, maybeResume, type StreamEvent } from '@/lib/eventStream';
import { ErrorBox } from './ErrorBox';
import type { CatalogTable, CatalogError } from '@/hooks/useCatalog';
import { cn } from '@/lib/utils';

interface Consumer {
  name: string;
  seq: number;
  lagEvents: number | null;
  lagSeconds: number | null;
}

function opClass(op: string) {
  return op === 'insert' ? 'bg-ok-subtle text-ok' : op === 'update' ? 'bg-warn-subtle text-warn' : 'bg-error-subtle text-error';
}

export function EventsPanel({ tables = [] }: { tables?: CatalogTable[] }) {
  const stream = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const [table, setTable] = useState('');
  const [fromSeq, setFromSeq] = useState('');
  const [subTab, setSubTab] = useState<'stream' | 'cdc' | 'consumers'>('stream');

  const [cdcStatus, setCdcStatus] = useState<Map<string, boolean>>(new Map());
  const [cdcLoading, setCdcLoading] = useState(false);

  const [consumers, setConsumers] = useState<Consumer[]>([]);

  const [autoAckConsumer, setAutoAckConsumer] = useState('');
  const [autoAckMode, setAutoAckMode] = useState(false);
  const [lastAckedSeq, setLastAckedSeq] = useState<number | null>(null);

  const [selectedEvent, setSelectedEvent] = useState<StreamEvent | null>(null);

  const userTables = tables.filter((t) => !/^__/.test(t.name));

  async function loadCdcStatus() {
    setCdcLoading(true);
    const next = new Map<string, boolean>();
    await Promise.all(
      userTables.map(async (t) => {
        try {
          const r = await getCdcStatus(t.name);
          next.set(t.name, r.enabled);
        } catch {
          next.set(t.name, false);
        }
      }),
    );
    setCdcStatus(next);
    setCdcLoading(false);
  }

  async function pollConsumers() {
    try {
      const res = await runSql('SELECT consumer, "offset", lag_events, lag_seconds FROM unidb_catalog.subscription_lag ORDER BY consumer');
      const rows = (res.results?.[0]?.rows ?? []) as [string, number, number | null, number | null][];
      setConsumers(rows.map(([name, seq, lagEvents, lagSeconds]) => ({ name, seq, lagEvents, lagSeconds })));
    } catch {
      /* catalog may be empty */
    }
  }

  // Mount: resume a persisted stream, load CDC status, start polling consumers,
  // and auto-start a subscriber if opened via a "Subscribe" link's URL params.
  useEffect(() => {
    maybeResume();
    loadCdcStatus();
    pollConsumers();
    const id = setInterval(pollConsumers, 2000);

    const params = new URLSearchParams(window.location.search);
    const paramTable = params.get('table') ?? '';
    const paramConsumer = params.get('consumer') ?? '';
    if (params.get('autostart') === '1' && paramTable) {
      setTable(paramTable);
      if (params.get('autoack') === '1' && paramConsumer) {
        setAutoAckConsumer(paramConsumer);
        setAutoAckMode(true);
      }
      startStream({ table: paramTable, fromSeq: '' });
    }

    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-ACK: whenever new events arrive, ACK up to the latest seq.
  useEffect(() => {
    if (!autoAckMode || !autoAckConsumer || stream.events.length === 0) return;
    const latest = stream.events[0];
    if (latest?.seq != null && latest.seq !== lastAckedSeq) {
      setLastAckedSeq(latest.seq);
      ackEvents(autoAckConsumer, latest.seq).catch(() => {});
    }
  }, [stream.events, autoAckMode, autoAckConsumer, lastAckedSeq]);

  // Reload CDC status whenever the user switches to that subtab.
  useEffect(() => {
    if (subTab === 'cdc') loadCdcStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subTab]);

  function openSubscriber(tableName: string) {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', 'events');
    url.searchParams.set('table', tableName);
    url.searchParams.set('consumer', `browser-${tableName}`);
    url.searchParams.set('autostart', '1');
    url.searchParams.set('autoack', '1');
    window.open(url.toString(), '_blank');
  }

  function start() {
    startStream({ table, fromSeq });
  }
  function stop() {
    stopStream();
  }
  function resumeFromLast() {
    const seq = stream.lastSeq;
    if (seq != null) setFromSeq(String(seq));
    startStream({ table, fromSeq: seq != null ? String(seq) : fromSeq });
  }

  async function enableCdc(t: string) {
    try {
      await enableTableEvents(t);
    } catch {
      /* already enabled is fine */
    }
    await loadCdcStatus();
  }
  async function disableCdc(t: string) {
    try {
      await disableTableEvents(t);
    } catch {
      /* already off is fine */
    }
    await loadCdcStatus();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-0.5 border-b border-border">
        {(['stream', 'cdc', 'consumers'] as const).map((t) => (
          <button
            key={t}
            className={cn(
              '-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3.5 py-1.5 text-md font-medium text-text-light',
              subTab === t ? 'border-brand text-brand' : 'hover:text-foreground',
            )}
            onClick={() => setSubTab(t)}
          >
            {t === 'stream' ? 'Live stream' : t === 'cdc' ? 'CDC tables' : 'Consumers'}
            {t === 'consumers' && consumers.length > 0 && (
              <span className="rounded-full bg-brand px-1.5 text-[10px] font-bold text-brand-text-on">{consumers.length}</span>
            )}
          </button>
        ))}
      </div>

      {subTab === 'stream' && (
        <>
          <div className="flex flex-wrap items-end gap-2.5">
            <label className="flex flex-col gap-0.5 text-xs text-text-muted">
              Table
              <select
                className="h-8 rounded-md border border-border bg-secondary px-2 text-md"
                value={table}
                onChange={(e) => setTable(e.target.value)}
                disabled={stream.streaming}
              >
                <option value="">all enabled</option>
                {userTables.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-0.5 text-xs text-text-muted">
              From seq
              <input
                type="number"
                min={0}
                placeholder="latest"
                value={fromSeq}
                onChange={(e) => setFromSeq(e.target.value)}
                disabled={stream.streaming}
                className="h-8 w-[110px] rounded-md border border-border bg-secondary px-2 text-md"
              />
            </label>
            {!stream.streaming ? (
              <button className="h-8 rounded-md bg-brand px-3.5 text-md text-brand-text-on hover:bg-brand-hover" onClick={start}>
                ▶ Start tail
              </button>
            ) : (
              <button className="h-8 rounded-md bg-error px-3.5 text-md text-background hover:brightness-110" onClick={stop}>
                ■ Stop
              </button>
            )}
            <button className="text-md text-brand hover:underline disabled:opacity-45" onClick={clearEvents} disabled={!stream.events.length}>
              Clear
            </button>
          </div>

          <div className="flex items-center gap-2 text-md text-foreground">
            <span className={cn('size-2 rounded-full', stream.streaming ? 'bg-ok shadow-[0_0_0_3px_var(--ok-subtle)]' : 'bg-text-muted')} />
            {stream.streaming ? (
              <>
                Live{table ? ` · ${table}` : ''}
                {stream.lastSeq != null ? ` · seq ${stream.lastSeq}` : ''}
                <span className="text-xs text-text-muted italic">(persists across tab switches and page reloads)</span>
              </>
            ) : (
              <>
                Stopped
                {stream.lastSeq != null && (
                  <>
                    {' '}
                    · <button className="text-brand hover:underline" onClick={resumeFromLast}>
                      resume after seq {stream.lastSeq} →
                    </button>
                  </>
                )}
              </>
            )}
            {autoAckMode && autoAckConsumer && (
              <span className="rounded-md border border-ok/30 bg-ok-subtle px-2 py-0.5 text-xs text-ok">
                ⚡ auto-ACK as <strong>{autoAckConsumer}</strong>
                {lastAckedSeq != null ? ` · acked seq ${lastAckedSeq}` : ''}
              </span>
            )}
            <span className="flex-1" />
            <span className="text-md text-text-light">
              {stream.events.length} event{stream.events.length === 1 ? '' : 's'} (max 500)
            </span>
          </div>

          {stream.streamErr && (
            <>
              <ErrorBox error={stream.streamErr as CatalogError} />
              <p className="text-md text-text-light">
                Table may not have CDC enabled — go to the{' '}
                <button className="text-brand hover:underline" onClick={() => setSubTab('cdc')}>
                  CDC tables
                </button>{' '}
                tab to enable it.
              </p>
            </>
          )}

          {stream.events.length ? (
            <div className="max-h-[60vh] overflow-auto rounded-md border border-border">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th className="sticky top-0 w-[60px] bg-secondary px-2.5 py-1.5 text-left text-xs font-semibold tracking-wide text-text-muted uppercase">Seq</th>
                    <th className="sticky top-0 w-[90px] bg-secondary px-2.5 py-1.5 text-left text-xs font-semibold tracking-wide text-text-muted uppercase">Operation</th>
                    <th className="sticky top-0 w-[140px] bg-secondary px-2.5 py-1.5 text-left text-xs font-semibold tracking-wide text-text-muted uppercase">Table</th>
                    <th className="sticky top-0 w-20 bg-secondary px-2.5 py-1.5 text-left text-xs font-semibold tracking-wide text-text-muted uppercase">Txn ID</th>
                    <th className="sticky top-0 bg-secondary px-2.5 py-1.5 text-left text-xs font-semibold tracking-wide text-text-muted uppercase">Row data</th>
                  </tr>
                </thead>
                <tbody>
                  {stream.events.map((e) => (
                    <tr
                      key={e.seq}
                      className={cn('cursor-pointer border-b border-border hover:bg-secondary', selectedEvent?.seq === e.seq && 'bg-brand-subtle')}
                      onClick={() => setSelectedEvent(e)}
                      title="Click to inspect payload"
                    >
                      <td className="px-2.5 py-1 font-mono text-text-muted">#{e.seq}</td>
                      <td className="px-2.5 py-1">
                        <span className={cn('rounded-md px-1.5 py-0.5 font-mono text-xs font-bold uppercase', opClass(e.op))}>{e.op}</span>
                      </td>
                      <td className="px-2.5 py-1 font-mono">{e.table_name}</td>
                      <td className="px-2.5 py-1 font-mono text-xs text-text-muted">{e.xid}</td>
                      <td className="max-w-0 overflow-hidden px-2.5 py-1">
                        <code className="block truncate font-mono text-sm text-foreground">{JSON.stringify(e.payload)}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : !stream.streaming ? (
            <p className="text-md text-text-light">
              Pick a table (or "all enabled"), then <strong>Start tail</strong> to watch committed INSERT/UPDATE/DELETE events live.
            </p>
          ) : (
            <p className="text-md text-text-light">Waiting for events…</p>
          )}
        </>
      )}

      {subTab === 'cdc' && (
        <>
          <p className="m-0 text-md text-text-light">
            Change-Data-Capture must be enabled per table before the engine emits events. Status is read live from{' '}
            <code>GET /tables/{'{name}'}/events</code>.
          </p>
          <div className="flex justify-end">
            <button className="h-[26px] rounded-md border border-border bg-secondary px-2.5 text-sm hover:border-border-strong disabled:opacity-60" onClick={loadCdcStatus} disabled={cdcLoading}>
              {cdcLoading ? 'Loading…' : '↻ Refresh'}
            </button>
          </div>
          <table className="w-full border-collapse text-md">
            <thead>
              <tr>
                <th className="border-b border-border px-2.5 py-1.5 text-left text-xs font-semibold tracking-wide text-text-muted uppercase">Table</th>
                <th className="border-b border-border px-2.5 py-1.5 text-left text-xs font-semibold tracking-wide text-text-muted uppercase">CDC status</th>
                <th className="border-b border-border px-2.5 py-1.5 text-left text-xs font-semibold tracking-wide text-text-muted uppercase">Actions</th>
              </tr>
            </thead>
            <tbody>
              {userTables.map((t) => {
                const enabled = cdcStatus.get(t.name);
                return (
                  <tr key={t.name} className="border-b border-border hover:bg-secondary">
                    <td className="px-2.5 py-2 font-mono">{t.name}</td>
                    <td className="px-2.5 py-2">
                      {cdcLoading ? (
                        <span className="text-sm text-text-light">loading…</span>
                      ) : enabled ? (
                        <span className="text-sm font-semibold text-ok">● enabled</span>
                      ) : (
                        <span className="text-sm text-text-muted">○ not enabled</span>
                      )}
                    </td>
                    <td className="flex gap-1.5 px-2.5 py-2">
                      {!enabled ? (
                        <button className="h-[26px] rounded-md border border-border bg-secondary px-2.5 text-sm hover:border-border-strong" onClick={() => enableCdc(t.name)}>
                          Enable CDC
                        </button>
                      ) : (
                        <>
                          <button
                            className="h-[26px] rounded-md border border-error/35 bg-error-subtle px-2.5 text-sm text-error hover:brightness-110"
                            onClick={() => disableCdc(t.name)}
                          >
                            Disable
                          </button>
                          <button
                            className="h-[26px] rounded-md border border-ok/35 bg-ok-subtle px-2.5 text-sm text-ok hover:brightness-110"
                            onClick={() => openSubscriber(t.name)}
                            title={`Open a live subscriber for ${t.name} in a new tab — auto-ACKs consumed events`}
                          >
                            ▶ Subscribe
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="rounded-md border border-border bg-secondary px-3.5 py-2.5 text-sm leading-relaxed text-text-light">
            <strong className="text-foreground">Database-level CDC</strong> is not supported — enable per table above, or run{' '}
            <code>python3 demo/events_demo.py</code> which enables CDC on <code>orders</code> automatically.
          </div>
        </>
      )}

      {subTab === 'consumers' && (
        <>
          <p className="m-0 text-md text-text-light">
            Consumer offsets from <code>unidb_catalog.subscription_lag</code> — advanced by <code>POST /events/ack</code> each time a
            consumer durably processes events.
          </p>
          {consumers.length === 0 ? (
            <p className="text-md text-text-light">
              No consumers registered yet. Run <code>python3 demo/events_demo.py</code> to register <code>demo-py</code>.
            </p>
          ) : (
            <table className="w-full border-collapse text-md">
              <thead>
                <tr>
                  <th className="border-b border-border px-2.5 py-1.5 text-left text-xs font-semibold tracking-wide text-text-muted uppercase">Consumer</th>
                  <th className="border-b border-border px-2.5 py-1.5 text-right text-xs font-semibold tracking-wide text-text-muted uppercase">Committed offset</th>
                  <th className="border-b border-border px-2.5 py-1.5 text-right text-xs font-semibold tracking-wide text-text-muted uppercase">Lag (events)</th>
                  <th className="border-b border-border px-2.5 py-1.5 text-right text-xs font-semibold tracking-wide text-text-muted uppercase">Lag (seconds)</th>
                  <th className="border-b border-border px-2.5 py-1.5 text-left text-xs font-semibold tracking-wide text-text-muted uppercase">Replay</th>
                </tr>
              </thead>
              <tbody>
                {consumers.map((c) => (
                  <tr key={c.name} className="border-b border-border hover:bg-secondary">
                    <td className="px-2.5 py-2 font-mono text-brand">{c.name}</td>
                    <td className="px-2.5 py-2 text-right font-mono">{c.seq}</td>
                    <td className="px-2.5 py-2 text-right font-mono">{c.lagEvents ?? '—'}</td>
                    <td className="px-2.5 py-2 text-right font-mono">{c.lagSeconds != null ? c.lagSeconds.toFixed(1) + 's' : '—'}</td>
                    <td className="px-2.5 py-2">
                      <button
                        className="h-[26px] rounded-md border border-border bg-secondary px-2.5 text-sm hover:border-border-strong"
                        onClick={() => {
                          setSubTab('stream');
                          setFromSeq(String(c.seq));
                          setTable('');
                          startStream({ table: '', fromSeq: String(c.seq) });
                        }}
                      >
                        ▶ Resume from seq {c.seq}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {selectedEvent && (
        <div className="fixed inset-0 z-40 bg-black/35" role="presentation" onClick={() => setSelectedEvent(null)}>
          <div
            className="fixed top-1/2 left-1/2 z-50 flex max-h-[70vh] w-[min(560px,90vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-card shadow-[var(--shadow-overlay)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3.5 py-2.5">
              <span className={cn('rounded-md px-1.5 py-0.5 font-mono text-xs font-bold uppercase', opClass(selectedEvent.op))}>{selectedEvent.op}</span>
              <span className="flex-1 font-mono text-md font-semibold">
                {selectedEvent.table_name} · seq #{selectedEvent.seq}
              </span>
              <span className="text-xs text-text-muted">txn {selectedEvent.xid}</span>
              <button className="rounded-sm p-1 text-text-muted hover:bg-secondary hover:text-foreground" onClick={() => setSelectedEvent(null)} title="Close">
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-auto p-3.5">
              <div className="mb-1.5 text-xs font-semibold tracking-wide text-text-muted uppercase">Row data (payload)</div>
              <pre className="m-0 font-mono text-sm leading-relaxed break-all whitespace-pre-wrap text-foreground">
                {JSON.stringify(selectedEvent.payload, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
