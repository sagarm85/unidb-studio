<script>
  import { queryHistory } from './queryStore.js';
  import { getStats } from './api.js';

  let serverStats = $state(null);
  let statsError  = $state(null);
  let polling     = $state(false);
  let interval    = null;

  const KIND_COLOR = {
    select: 'var(--accent)',
    insert: '#22c55e',
    update: '#f59e0b',
    delete: '#ef4444',
    ddl:    '#a855f7',
    other:  'var(--muted)',
  };

  function kindBadgeStyle(kind) {
    return `background:${KIND_COLOR[kind] ?? 'var(--muted)'}22;color:${KIND_COLOR[kind] ?? 'var(--muted)'};`;
  }

  function durationClass(ms) {
    if (ms < 50)  return 'dur-fast';
    if (ms < 500) return 'dur-ok';
    return 'dur-slow';
  }

  async function loadStats() {
    try {
      const { stats, supported } = await getStats();
      serverStats = supported ? stats : null;
    } catch (e) {
      statsError = e.message;
    }
  }

  function togglePolling() {
    if (polling) {
      clearInterval(interval);
      interval = null;
      polling = false;
    } else {
      loadStats();
      interval = setInterval(loadStats, 2000);
      polling = true;
    }
  }

  $effect(() => {
    loadStats();
    return () => { if (interval) clearInterval(interval); };
  });

  function clearHistory() {
    queryHistory.set([]);
  }

  function fmtUs(us) {
    if (us == null || us === 0) return '—';
    if (us < 1000) return `${us} μs`;
    return `${(us / 1000).toFixed(1)} ms`;
  }

  function fmtMs(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return `${ms} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  }

  function relTime(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 2000)   return 'just now';
    if (diff < 60000)  return `${Math.floor(diff/1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
    return new Date(iso).toLocaleTimeString();
  }
</script>

<div class="qperf">

  <!-- ── Engine aggregate stats ─────────────────────────────────────────── -->
  <section class="card">
    <div class="card-head">
      <h3>Engine latency  <span class="sub">from /stats (server-side)</span></h3>
      <div class="actions">
        <button class="btn" class:active={polling} onclick={togglePolling}>
          {polling ? '⏸ Pause' : '▶ Live'}
        </button>
        <button class="btn" onclick={loadStats}>Refresh</button>
      </div>
    </div>

    {#if statsError}
      <p class="err">{statsError}</p>
    {:else if serverStats}
      <div class="stat-grid">
        {#each Object.entries(serverStats.statement_latency ?? {}) as [kind, s]}
          <div class="stat-card" style={`border-left:3px solid ${KIND_COLOR[kind] ?? 'var(--muted)'}`}>
            <div class="stat-kind">{kind}</div>
            <div class="stat-row"><span class="label">count</span><span class="value">{s.count.toLocaleString()}</span></div>
            <div class="stat-row"><span class="label">mean</span><span class="value">{fmtUs(s.mean_us)}</span></div>
            <div class="stat-row"><span class="label">p50</span><span class="value">{fmtUs(s.p50_us)}</span></div>
            <div class="stat-row"><span class="label">p99</span><span class="value">{fmtUs(s.p99_us)}</span></div>
          </div>
        {/each}
      </div>

      <!-- buffer pool + WAL row -->
      {#if serverStats.bufferpool}
        <div class="meta-row">
          <span>Buffer hit ratio</span>
          <strong>{(serverStats.bufferpool.hit_ratio * 100).toFixed(2)}%</strong>
          <span style="margin-left:24px">WAL fsyncs</span>
          <strong>{serverStats.wal_fsyncs?.toLocaleString() ?? '—'}</strong>
          <span style="margin-left:24px">WAL fsync p50</span>
          <strong>{fmtUs(serverStats.wal_fsync_latency?.p50_us)}</strong>
          <span style="margin-left:24px">Active txns</span>
          <strong>{serverStats.active_transactions ?? '—'}</strong>
        </div>
      {/if}
    {:else}
      <p class="muted">Loading…</p>
    {/if}
  </section>

  <!-- ── Recent slow queries ────────────────────────────────────────────── -->
  {#if serverStats?.recent_slow_queries?.length}
    <section class="card">
      <div class="card-head"><h3>Recent slow queries  <span class="sub">(engine-reported)</span></h3></div>
      <table class="history-table">
        <thead><tr><th>Duration</th><th>Query</th></tr></thead>
        <tbody>
          {#each serverStats.recent_slow_queries as q}
            <tr>
              <td class="dur {durationClass(q.duration_ms ?? 0)}">{fmtMs(q.duration_ms)}</td>
              <td><code class="sql-snippet">{q.sql ?? q.query ?? '—'}</code></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}

  <!-- ── Client-side query history ──────────────────────────────────────── -->
  <section class="card">
    <div class="card-head">
      <h3>Query history  <span class="sub">(browser round-trip time)</span></h3>
      <button class="btn" onclick={clearHistory}>Clear</button>
    </div>

    {#if $queryHistory.length === 0}
      <p class="muted">No queries yet — run SQL from the editor or Record Browser.</p>
    {:else}
      <table class="history-table">
        <thead>
          <tr>
            <th>When</th>
            <th>Kind</th>
            <th>Duration</th>
            <th>Rows</th>
            <th style="width:100%">SQL</th>
          </tr>
        </thead>
        <tbody>
          {#each $queryHistory as q (q.id)}
            <tr class:err-row={q.status === 'error'}>
              <td class="ts">{relTime(q.timestamp)}</td>
              <td><span class="kind-badge" style={kindBadgeStyle(q.kind)}>{q.kind}</span></td>
              <td class="dur {durationClass(q.durationMs)}">{q.durationMs} ms</td>
              <td class="rowct">{q.rowCount > 0 ? q.rowCount : '—'}</td>
              <td><code class="sql-snippet">{q.sql}</code></td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>

</div>

<style>
  .qperf {
    display: flex;
    flex-direction: column;
    gap: 18px;
    font-size: 13px;
  }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
  }
  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    gap: 10px;
  }
  h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }
  .sub {
    font-weight: 400;
    color: var(--muted);
    font-size: 11px;
    margin-left: 6px;
  }
  .actions {
    display: flex;
    gap: 6px;
  }
  .btn {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 3px 10px;
    font-size: 12px;
    cursor: pointer;
    color: var(--muted);
  }
  .btn:hover { color: var(--text); }
  .btn.active { color: var(--accent); border-color: var(--accent); }

  /* Engine stat cards */
  .stat-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 10px;
    margin-bottom: 12px;
  }
  .stat-card {
    background: var(--bg);
    border-radius: 6px;
    padding: 10px 12px;
  }
  .stat-kind {
    font-weight: 600;
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: .05em;
    color: var(--muted);
    margin-bottom: 6px;
  }
  .stat-row {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    line-height: 1.8;
  }
  .stat-row .label { color: var(--muted); }
  .stat-row .value { font-variant-numeric: tabular-nums; font-weight: 500; }

  .meta-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--muted);
    padding-top: 8px;
    border-top: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .meta-row strong { color: var(--text); }

  /* History table */
  .history-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .history-table th {
    text-align: left;
    padding: 4px 8px;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
    font-weight: 500;
    white-space: nowrap;
  }
  .history-table td {
    padding: 5px 8px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  .history-table tr:last-child td { border-bottom: none; }
  .err-row td { background: var(--err-bg, rgba(239,68,68,.05)); }

  .ts { color: var(--muted); white-space: nowrap; }
  .kind-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: .04em;
  }
  .dur { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .dur-fast { color: #22c55e; }
  .dur-ok   { color: #f59e0b; }
  .dur-slow { color: #ef4444; }
  .rowct { color: var(--muted); font-variant-numeric: tabular-nums; }
  .sql-snippet {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    display: block;
    max-width: 500px;
  }
  .err { color: #ef4444; margin: 0; }
  .muted { color: var(--muted); }
</style>
