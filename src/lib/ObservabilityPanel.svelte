<script>
  import { getStats, getStatsHistory } from './api.js';
  import { formatMicros, formatCount, formatDuration } from './format.js';
  import ErrorBox from './ErrorBox.svelte';
  import MetricChart from './MetricChart.svelte';
  import { queryHistory } from './queryStore.js';

  const REFRESH_MS = 5000;
  const MAX_HISTORY = 60; // 5 min at 5s intervals

  let stats     = $state(null);
  let supported = $state(true);
  let error     = $state(null);
  let loading   = $state(true);
  let live      = $state(true);
  let subTab    = $state('overview'); // 'overview' | 'queries'

  // History prefilled from GET /stats/history on mount; subsequent polls append live points.
  let history = $state([]);

  function serverPointToLocal(p) {
    return {
      t:             p.t,
      activeTxns:    p.active_transactions ?? 0,
      hitRatio:      p.bufferpool_hit_ratio != null ? p.bufferpool_hit_ratio * 100 : null,
      commitsPerSec: p.commits_per_sec  ?? 0,
      walBytesPerSec: p.wal_bytes_per_sec ?? 0,
      lockWaits:     null, // not in history response
    };
  }

  async function load() {
    try {
      const out = await getStats();
      supported = out.supported;
      if (out.supported) {
        stats = out.stats;
        const point = serverPointToLocal({
          t:                  Date.now(),
          active_transactions: stats.active_transactions,
          bufferpool_hit_ratio: stats.bufferpool?.hit_ratio,
          commits_per_sec:    null, // computed by server in history; live poll falls back to 0
          wal_bytes_per_sec:  null,
        });
        // Carry server rates from the most recent history point if available
        const last = history[history.length - 1];
        if (last) {
          point.commitsPerSec  = last.commitsPerSec;
          point.walBytesPerSec = last.walBytesPerSec;
        }
        history = [...history.slice(-(MAX_HISTORY - 1)), point];
      }
      error = null;
    } catch (e) {
      error = { code: e.code, message: e.message, status: e.status };
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    // Prefill charts from engine ring buffer before starting the live poll
    getStatsHistory({ points: MAX_HISTORY }).then(({ points }) => {
      if (points.length) history = points.map(serverPointToLocal);
    }).catch(() => {});

    load();
    if (!live) return;
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  });

  let obsEl = $state(null);
  function switchTab(t) {
    subTab = t;
    obsEl?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const kinds   = ['select', 'insert', 'update', 'delete'];
  const latency = $derived(stats?.statement_latency ?? {});
  const bp      = $derived(stats?.bufferpool ?? null);
  const locks   = $derived(stats?.locks ?? null);
  const fsync   = $derived(stats?.wal_fsync_latency ?? null);
  const workers = $derived(stats?.parallel_workers ?? null);
  const tables  = $derived(stats?.tables ?? []);
  const horizon = $derived(stats?.horizon_age_secs ?? null);

  const horizonLevel = $derived(
    horizon == null ? 'ok' : horizon >= 300 ? 'bad' : horizon >= 30 ? 'warn' : 'ok',
  );
  const hitRatio = $derived(
    bp?.hit_ratio != null ? `${(bp.hit_ratio * 100).toFixed(1)}%` : '—'
  );
  const totalQueries = $derived(
    kinds.reduce((s, k) => s + (latency[k]?.count ?? 0), 0)
  );
  const slowCount = $derived(stats?.recent_slow_queries?.length ?? 0);

  // ── Series helpers ────────────────────────────────────────
  function toSeries(key) {
    return history.map(p => ({ t: p.t, v: p[key] ?? null }));
  }

  function fmtRate(v) {
    if (v == null) return '—';
    if (v >= 1000) return `${(v / 1000).toFixed(1)}k/s`;
    return `${v.toFixed(1)}/s`;
  }
  function fmtBytes(v) {
    if (v == null) return '—';
    if (v >= 1_048_576) return `${(v / 1_048_576).toFixed(1)} MB/s`;
    if (v >= 1024) return `${(v / 1024).toFixed(1)} KB/s`;
    return `${v.toFixed(0)} B/s`;
  }
  function fmtPct(v) {
    if (v == null) return '—';
    return `${v.toFixed(1)}%`;
  }
  function relTime(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 2000)    return 'just now';
    if (diff < 60000)   return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return new Date(iso).toLocaleTimeString();
  }
</script>

<div class="obs" bind:this={obsEl}>
  <!-- Subtab nav — deliberately separate from the live/refresh controls -->
  <div class="obs-header">
    <div class="subtabs">
      <button class:active={subTab === 'overview'} onclick={() => switchTab('overview')}>Overview</button>
      <button class:active={subTab === 'queries'}  onclick={() => switchTab('queries')}>Query Performance</button>
    </div>
    <span class="hspacer"></span>
    <!-- checkbox + label kept as siblings (not nested) to avoid label hit-area bleed -->
    <input type="checkbox" id="obs-live" bind:checked={live} style="cursor:pointer" />
    <label for="obs-live" class="live-label">Live ({REFRESH_MS / 1000}s)</label>
    <button class="refresh-btn" onclick={load} title="Refresh now">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5c1.8 0 3.4.87 4.4 2.2"/>
        <polyline points="10 2 13 5 10.5 7.5"/>
      </svg>
      Refresh
    </button>
  </div>

  {#if error}
    <ErrorBox {error} />
  {/if}

  {#if !supported}
    <p class="muted">
      This server doesn't expose <code>GET /stats</code>. Rebuild
      <code>unidb-server</code> from a build that includes observability metrics.
    </p>
  {:else if loading && !stats}
    <p class="muted">Loading metrics…</p>
  {:else if stats}

    <!-- ── OVERVIEW ────────────────────────────────────────── -->
    {#if subTab === 'overview'}

      <!-- KPI summary cards -->
      <div class="kpi-grid">
        <div class="kpi">
          <span class="kpi-label">Total queries</span>
          <span class="kpi-val">{formatCount(totalQueries)}</span>
        </div>
        <div class="kpi {slowCount > 0 ? 'warn' : ''}">
          <span class="kpi-label">Slow queries</span>
          <span class="kpi-val">{slowCount}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Cache hit rate</span>
          <span class="kpi-val accent">{hitRatio}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Active txns</span>
          <span class="kpi-val">{formatCount(stats.active_transactions)}</span>
        </div>
        <div class="kpi {locks?.deadlocks > 0 ? 'bad' : ''}">
          <span class="kpi-label">Deadlocks</span>
          <span class="kpi-val">{formatCount(locks?.deadlocks)}</span>
        </div>
        <div class="kpi {horizonLevel}">
          <span class="kpi-label">Vacuum horizon</span>
          <span class="kpi-val">{formatDuration(horizon)}</span>
        </div>
      </div>

      <!-- Time-series charts -->
      <div class="chart-grid">
        <MetricChart
          points={toSeries('activeTxns')}
          label="Active transactions"
          unit="count"
          color="#2563eb"
          fmt={(v) => v?.toFixed(0) ?? '—'}
        />
        <MetricChart
          points={toSeries('hitRatio')}
          label="Cache hit rate"
          unit="%"
          color="#16a34a"
          fmt={fmtPct}
        />
        <MetricChart
          points={toSeries('commitsPerSec')}
          label="Commits / sec"
          unit="txn/s"
          color="#7c3aed"
          fmt={fmtRate}
        />
        <MetricChart
          points={toSeries('walBytesPerSec')}
          label="WAL throughput"
          unit="bytes/s"
          color="#b45309"
          fmt={fmtBytes}
        />
      </div>

      <!-- Card grid -->
      <div class="card-grid">
        <!-- Throughput -->
        <section class="card">
          <h4>Throughput</h4>
          <dl>
            <dt>Commits</dt>       <dd>{formatCount(stats.commits)}</dd>
            <dt>Aborts</dt>        <dd>{formatCount(stats.aborts)}</dd>
            <dt>Checkpoints</dt>   <dd>{formatCount(stats.checkpoints)}</dd>
            <dt>Autovacuums</dt>   <dd>{formatCount(stats.autovacuums)}</dd>
          </dl>
        </section>

        <!-- Sessions -->
        <section class="card">
          <h4>Sessions</h4>
          <dl>
            <dt>Open txn sessions</dt>   <dd>{formatCount(stats.open_txn_sessions)}</dd>
            <dt>Open cursors</dt>        <dd>{formatCount(stats.open_cursors)}</dd>
            <dt>Idle-reaper aborts</dt>  <dd>{formatCount(stats.idle_reaper_aborts)}</dd>
          </dl>
        </section>

        <!-- Buffer pool -->
        {#if bp}
          <section class="card">
            <h4>Buffer pool</h4>
            <dl>
              <dt>Hit ratio</dt>   <dd class="accent strong">{hitRatio}</dd>
              <dt>Hits</dt>        <dd>{formatCount(bp.hits)}</dd>
              <dt>Misses</dt>      <dd>{formatCount(bp.misses)}</dd>
              <dt>Evictions</dt>   <dd>{formatCount(bp.evictions)}</dd>
            </dl>
          </section>
        {/if}

        <!-- Contention -->
        {#if locks}
          <section class="card">
            <h4>Contention</h4>
            <dl>
              <dt>Lock waits</dt>  <dd>{formatCount(locks.waits)}</dd>
              <dt>Deadlocks</dt>   <dd class:danger={locks.deadlocks > 0}>{formatCount(locks.deadlocks)}</dd>
              <dt>Wait p50</dt>    <dd>{formatMicros(locks.wait?.p50_us)}</dd>
              <dt>Wait p99</dt>    <dd>{formatMicros(locks.wait?.p99_us)}</dd>
            </dl>
          </section>
        {/if}

        <!-- WAL -->
        <section class="card">
          <h4>WAL / Durability</h4>
          <dl>
            <dt>fsyncs</dt>       <dd>{formatCount(stats.wal_fsyncs)}</dd>
            <dt>fsync p50</dt>    <dd>{formatMicros(fsync?.p50_us)}</dd>
            <dt>fsync p99</dt>    <dd>{formatMicros(fsync?.p99_us)}</dd>
            <dt>WAL bytes</dt>    <dd>{formatCount(stats.wal_bytes)}</dd>
          </dl>
        </section>

        <!-- Workers -->
        {#if workers}
          <section class="card">
            <h4>Parallel workers</h4>
            <dl>
              <dt>Budget</dt>           <dd>{formatCount(workers.global_max)}</dd>
              <dt>Available</dt>        <dd>{formatCount(workers.available)}</dd>
              <dt>Active scans</dt>     <dd>{formatCount(workers.parallel_scans)}</dd>
              <dt>Serial fallbacks</dt> <dd>{formatCount(workers.serial_fallbacks)}</dd>
            </dl>
          </section>
        {/if}
      </div>

      <!-- Table health -->
      {#if tables.length}
        <section class="card wide">
          <h4>Table health
            <span class="hint">
              dead ≈ {formatCount(stats.dead_tuple_estimate)} · live ≈ {formatCount(stats.live_tuple_estimate)}
            </span>
          </h4>
          <table>
            <thead><tr><th>Table</th><th>Pages</th></tr></thead>
            <tbody>
              {#each tables as t}
                <tr><td class="mono">{t.name}</td><td class="mono">{formatCount(t.pages)}</td></tr>
              {/each}
            </tbody>
          </table>
        </section>
      {/if}

    <!-- ── QUERY PERFORMANCE ──────────────────────────────── -->
    {:else}

      <!-- Statement latency summary -->
      <section class="card wide">
        <h4>Statement latency <span class="hint">p50/p99 are log-bucket estimates</span></h4>
        <table class="perf-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th class="num">Calls</th>
              <th class="num">Mean</th>
              <th class="num">p50</th>
              <th class="num">p99</th>
            </tr>
          </thead>
          <tbody>
            {#each kinds as k}
              {@const row = latency[k] ?? {}}
              <tr>
                <td><span class="kind-chip {k}">{k}</span></td>
                <td class="num mono">{formatCount(row.count)}</td>
                <td class="num mono">{formatMicros(row.mean_us)}</td>
                <td class="num mono">{formatMicros(row.p50_us)}</td>
                <td class="num mono">{formatMicros(row.p99_us)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </section>

      <!-- Slow queries -->
      <section class="card wide">
        <h4>
          Recent slow queries
          {#if slowCount > 0}<span class="badge-count">{slowCount}</span>{/if}
        </h4>
        {#if stats.recent_slow_queries?.length}
          <table class="perf-table">
            <thead>
              <tr>
                <th>Query</th>
                <th class="num" style="width:110px">Time</th>
              </tr>
            </thead>
            <tbody>
              {#each stats.recent_slow_queries as sq}
                <tr>
                  <td class="mono sql" title={sq.sql}>{sq.sql}</td>
                  <td class="num mono">{formatMicros(sq.micros)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else}
          <p class="muted no-slow">No slow queries recorded — set <code>UNIDB_SLOW_QUERY_MS</code> on the engine to enable threshold logging.</p>
        {/if}
      </section>

      <!-- Client-side query history -->
      <section class="card wide">
        <div class="card-head-row">
          <h4>Query history <span class="hint">browser round-trip time · this session</span></h4>
          <button class="btn-clear" onclick={() => queryHistory.set([])}>Clear</button>
        </div>
        {#if $queryHistory.length === 0}
          <p class="muted no-slow">No queries yet — run SQL from the editor or Record Browser.</p>
        {:else}
          <table class="perf-table">
            <thead>
              <tr>
                <th style="width:80px">When</th>
                <th style="width:60px">Kind</th>
                <th class="num" style="width:90px">Duration</th>
                <th class="num" style="width:60px">Rows</th>
                <th>SQL</th>
              </tr>
            </thead>
            <tbody>
              {#each $queryHistory as q (q.id)}
                {@const dur = q.durationMs}
                <tr class:err-row={q.status === 'error'}>
                  <td class="mono muted-cell">{relTime(q.timestamp)}</td>
                  <td><span class="kind-chip {q.kind}">{q.kind}</span></td>
                  <td class="num mono" class:dur-fast={dur < 50} class:dur-ok={dur >= 50 && dur < 500} class:dur-slow={dur >= 500}>{dur} ms</td>
                  <td class="num mono muted-cell">{q.rowCount > 0 ? q.rowCount : '—'}</td>
                  <td class="mono sql" title={q.sql}>{q.sql}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </section>

    {/if}
  {/if}
</div>

<style>
  .obs {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding-bottom: 24px;
    /* Own scroll context so position:sticky on .obs-header works reliably
       inside the flex .panel parent (sticky is unreliable in flex children) */
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  /* ── header (subtabs + controls) ── */
  .obs-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-bottom: 2px;
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--bg);
  }
  .subtabs {
    display: flex;
    gap: 0;
  }
  .subtabs button {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 6px 16px;
    font-size: 13px;
    color: var(--muted);
    cursor: pointer;
    font-weight: 500;
    margin-bottom: -1px;
  }
  .subtabs button.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
    font-weight: 600;
    background: color-mix(in srgb, var(--accent) 8%, transparent);
    border-radius: 6px 6px 0 0;
  }
  .subtabs button:hover:not(.active) { color: var(--text); }
  .hspacer { flex: 1; }
  .live-label {
    font-size: 12px;
    color: var(--muted);
    cursor: pointer;
    user-select: none;
  }
  .refresh-btn {
    display: flex;
    align-items: center;
    gap: 5px;
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 5px 10px;
    font-size: 12px;
    color: var(--muted);
    cursor: pointer;
  }
  .refresh-btn:hover { color: var(--text); border-color: var(--accent); }

  /* ── KPI row ── */
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 10px;
  }
  .kpi {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .kpi.warn { border-color: #d99922; background: rgba(210,153,34,0.06); }
  .kpi.bad  { border-color: var(--err-border); background: var(--err-bg); }
  .kpi-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    font-weight: 600;
  }
  .kpi-val {
    font-size: 26px;
    font-weight: 700;
    font-family: var(--mono);
    line-height: 1;
  }
  .kpi-val.accent { color: var(--accent); }

  /* ── card grid ── */
  .card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
    gap: 12px;
  }
  .card {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
    background: var(--panel);
  }
  .card.wide { grid-column: 1 / -1; }
  .card h4 {
    margin: 0 0 10px;
    font-size: 13px;
    font-weight: 600;
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }
  .hint {
    font-size: 11px;
    font-weight: 400;
    color: var(--muted);
  }

  /* ── dl ── */
  dl {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 5px 12px;
    margin: 0;
    font-size: 13px;
  }
  dt { color: var(--muted); }
  dd {
    margin: 0;
    font-family: var(--mono);
    text-align: right;
  }
  dd.accent.strong { font-weight: 700; color: var(--accent); }
  dd.danger { color: var(--err-fg); font-weight: 700; }

  /* ── tables ── */
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td {
    text-align: left;
    padding: 7px 10px;
    border-bottom: 1px solid var(--border);
  }
  th { color: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: var(--panel-alt); }
  .perf-table th.num,
  .perf-table td.num { text-align: right; }
  .mono { font-family: var(--mono); }
  td.sql {
    max-width: 640px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ── kind chips ── */
  .kind-chip {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 700;
    font-family: var(--mono);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .kind-chip.select { background: rgba(37,99,235,0.12);  color: #2563eb; }
  .kind-chip.insert { background: rgba(22,163,74,0.12);  color: #16a34a; }
  .kind-chip.update { background: rgba(202,138,4,0.12);  color: #b45309; }
  .kind-chip.delete { background: rgba(220,38,38,0.12);  color: #dc2626; }

  .badge-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 18px;
    padding: 0 6px;
    border-radius: 9px;
    background: var(--err-fg);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
  }
  .no-slow { margin: 4px 0; font-size: 13px; }
  .card-head-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .card-head-row h4 { margin: 0; }
  .btn-clear {
    background: none;
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 2px 10px;
    font-size: 12px;
    color: var(--muted);
    cursor: pointer;
  }
  .btn-clear:hover { color: var(--text); }
  .muted-cell { color: var(--muted); }
  .err-row td { background: var(--err-bg, rgba(239,68,68,.05)); }
  .dur-fast { color: #22c55e; }
  .dur-ok   { color: #f59e0b; }
  .dur-slow { color: #ef4444; }
  .muted { color: var(--muted); font-size: 13px; }
  /* ── time-series charts ── */
  .chart-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 14px;
  }
</style>
