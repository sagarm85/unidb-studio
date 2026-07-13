<script>
  // Observability tab (item 21). Polls GET /stats and renders the widget set
  // from the engine_access_guide §9 traceability table — every panel maps to a
  // documented EngineStats field; no bespoke endpoint. Read-only.
  import { getStats } from './api.js';
  import { formatMicros, formatCount, formatDuration } from './format.js';
  import ErrorBox from './ErrorBox.svelte';

  const REFRESH_MS = 3000;

  let stats = $state(null);
  let supported = $state(true);
  let error = $state(null);
  let loading = $state(true);
  let live = $state(true); // auto-refresh toggle

  async function load() {
    try {
      const out = await getStats();
      supported = out.supported;
      if (out.supported) stats = out.stats;
      error = null;
    } catch (e) {
      error = { code: e.code, message: e.message, status: e.status };
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    load();
    if (!live) return;
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  });

  // Derived views over the snapshot (guarded — a pre-item-21 server may omit
  // the enriched blocks even while /stats itself exists).
  const kinds = ['insert', 'update', 'delete', 'select'];
  const latency = $derived(stats?.statement_latency ?? {});
  const bp = $derived(stats?.bufferpool ?? null);
  const locks = $derived(stats?.locks ?? null);
  const fsync = $derived(stats?.wal_fsync_latency ?? null);
  const workers = $derived(stats?.parallel_workers ?? null);
  const tables = $derived(stats?.tables ?? []);
  const horizon = $derived(stats?.horizon_age_secs ?? null);
  // The horizon-age gauge is the one to alert on: a pinned vacuum horizon is the
  // #1 silent bloat cause (item-16 postmortem). Warn as it climbs.
  const horizonLevel = $derived(
    horizon == null ? 'ok' : horizon >= 300 ? 'bad' : horizon >= 30 ? 'warn' : 'ok',
  );
  const hitRatio = $derived(bp?.hit_ratio != null ? `${(bp.hit_ratio * 100).toFixed(1)}%` : '—');
</script>

<div class="obs">
  <div class="toolbar">
    <h3>Observability</h3>
    <div class="spacer"></div>
    <label class="live">
      <input type="checkbox" bind:checked={live} />
      Auto-refresh ({REFRESH_MS / 1000}s)
    </label>
    <button class="link" onclick={load}>Refresh now</button>
  </div>

  {#if error}
    <ErrorBox {error} />
  {/if}

  {#if !supported}
    <p class="muted">
      This server doesn't expose <code>GET /stats</code>. Rebuild
      <code>unidb-server</code> from a build that includes item&nbsp;21 (observability metrics).
    </p>
  {:else if loading && !stats}
    <p class="muted">Loading metrics…</p>
  {:else if stats}
    <!-- Horizon-age gauge — the alertable one, first and prominent. -->
    <div class="gauge {horizonLevel}">
      <div class="gauge-label">Vacuum-horizon age</div>
      <div class="gauge-value">{formatDuration(horizon)}</div>
      <div class="gauge-note">
        {#if horizonLevel === 'bad'}
          A snapshot has been pinned &gt;5m — likely an idle <code>REPEATABLE READ</code> session or
          abandoned transaction. #1 silent cause of bloat &amp; scan slowdown.
        {:else if horizonLevel === 'warn'}
          Oldest live snapshot is aging. Resets to 0 the instant it commits/aborts.
        {:else}
          No long-lived snapshot pinning the vacuum horizon.
        {/if}
      </div>
    </div>

    <div class="grid">
      <!-- Throughput -->
      <section class="card">
        <h4>Throughput</h4>
        <dl>
          <dt>Commits</dt><dd>{formatCount(stats.commits)}</dd>
          <dt>Aborts</dt><dd>{formatCount(stats.aborts)}</dd>
          <dt>Active txns</dt><dd>{formatCount(stats.active_transactions)}</dd>
          <dt>Checkpoints</dt><dd>{formatCount(stats.checkpoints)}</dd>
        </dl>
      </section>

      <!-- Durability cost -->
      <section class="card">
        <h4>Durability cost</h4>
        <dl>
          <dt>WAL fsyncs</dt><dd>{formatCount(stats.wal_fsyncs)}</dd>
          <dt>fsync p50</dt><dd>{formatMicros(fsync?.p50_us)}</dd>
          <dt>fsync p99</dt><dd>{formatMicros(fsync?.p99_us)}</dd>
          <dt>WAL bytes</dt><dd>{formatCount(stats.wal_bytes)}</dd>
        </dl>
      </section>

      <!-- Cache efficiency -->
      {#if bp}
        <section class="card">
          <h4>Cache efficiency</h4>
          <dl>
            <dt>Hit ratio</dt><dd class="strong">{hitRatio}</dd>
            <dt>Hits</dt><dd>{formatCount(bp.hits)}</dd>
            <dt>Misses</dt><dd>{formatCount(bp.misses)}</dd>
            <dt>Evictions</dt><dd>{formatCount(bp.evictions)}</dd>
          </dl>
        </section>
      {/if}

      <!-- Contention -->
      {#if locks}
        <section class="card">
          <h4>Contention</h4>
          <dl>
            <dt>Lock waits</dt><dd>{formatCount(locks.waits)}</dd>
            <dt>Deadlocks</dt><dd class:danger={locks.deadlocks > 0}>{formatCount(locks.deadlocks)}</dd>
            <dt>Wait p50</dt><dd>{formatMicros(locks.wait?.p50_us)}</dd>
            <dt>Wait p99</dt><dd>{formatMicros(locks.wait?.p99_us)}</dd>
          </dl>
        </section>
      {/if}

      <!-- Worker governance -->
      {#if workers}
        <section class="card">
          <h4>Parallel workers</h4>
          <dl>
            <dt>Budget</dt><dd>{formatCount(workers.global_max)}</dd>
            <dt>Available</dt><dd>{formatCount(workers.available)}</dd>
            <dt>Active scans</dt><dd>{formatCount(workers.parallel_scans)}</dd>
            <dt>Serial fallbacks</dt><dd>{formatCount(workers.serial_fallbacks)}</dd>
          </dl>
        </section>
      {/if}

      <!-- Server sessions -->
      <section class="card">
        <h4>Server sessions</h4>
        <dl>
          <dt>Open txn sessions</dt><dd>{formatCount(stats.open_txn_sessions)}</dd>
          <dt>Open cursors</dt><dd>{formatCount(stats.open_cursors)}</dd>
          <dt>Idle-reaper aborts</dt><dd>{formatCount(stats.idle_reaper_aborts)}</dd>
          <dt>Autovacuums</dt><dd>{formatCount(stats.autovacuums)}</dd>
        </dl>
      </section>
    </div>

    <!-- Query latency by statement kind -->
    <section class="card wide">
      <h4>Query latency by kind <span class="hint">p50/p99 are log-bucket upper-bound estimates</span></h4>
      <table>
        <thead>
          <tr><th>Kind</th><th>Count</th><th>p50</th><th>p99</th><th>Mean</th></tr>
        </thead>
        <tbody>
          {#each kinds as k}
            <tr>
              <td class="mono">{k}</td>
              <td>{formatCount(latency[k]?.count)}</td>
              <td>{formatMicros(latency[k]?.p50_us)}</td>
              <td>{formatMicros(latency[k]?.p99_us)}</td>
              <td>{formatMicros(latency[k]?.mean_us)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>

    <!-- Table health -->
    <section class="card wide">
      <h4>
        Table health
        <span class="hint">
          dead/live estimates are engine-wide (per-table split is a filed follow-up):
          dead ≈ {formatCount(stats.dead_tuple_estimate)}, live ≈ {formatCount(stats.live_tuple_estimate)}
        </span>
      </h4>
      {#if tables.length}
        <table>
          <thead><tr><th>Table</th><th>Pages</th></tr></thead>
          <tbody>
            {#each tables as t}
              <tr><td class="mono">{t.name}</td><td>{formatCount(t.pages)}</td></tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="muted">No user tables reported.</p>
      {/if}
    </section>

    {#if stats.recent_slow_queries?.length}
      <section class="card wide">
        <h4>Recent slow queries</h4>
        <table>
          <thead><tr><th>SQL</th><th>Time</th></tr></thead>
          <tbody>
            {#each stats.recent_slow_queries as sq}
              <tr><td class="mono sql">{sq.sql}</td><td>{formatMicros(sq.micros)}</td></tr>
            {/each}
          </tbody>
        </table>
      </section>
    {/if}
  {/if}
</div>

<style>
  .obs {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .toolbar h3 {
    margin: 0;
    font-size: 15px;
  }
  .spacer {
    flex: 1;
  }
  .live {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--muted);
  }
  .muted {
    color: var(--muted);
    font-size: 13px;
  }
  .gauge {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
    background: var(--panel-alt);
  }
  .gauge.warn {
    border-color: #d99922;
    background: rgba(210, 153, 34, 0.1);
  }
  .gauge.bad {
    border-color: var(--err-border);
    background: var(--err-bg);
  }
  .gauge-label {
    font-size: 12px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .gauge-value {
    font-size: 28px;
    font-weight: 700;
    font-family: var(--mono);
    margin: 2px 0 4px;
  }
  .gauge-note {
    font-size: 12px;
    color: var(--text);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
    gap: 12px;
  }
  .card {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 14px;
    background: var(--panel);
  }
  .card.wide {
    grid-column: 1 / -1;
  }
  .card h4 {
    margin: 0 0 8px;
    font-size: 13px;
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
  dl {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 4px 10px;
    margin: 0;
    font-size: 13px;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
    font-family: var(--mono);
    text-align: right;
  }
  dd.strong {
    font-weight: 700;
    color: var(--accent);
  }
  dd.danger {
    color: var(--err-fg);
    font-weight: 700;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  th, td {
    text-align: left;
    padding: 5px 8px;
    border-bottom: 1px solid var(--border);
  }
  th {
    color: var(--muted);
    font-weight: 600;
  }
  td.mono, .mono {
    font-family: var(--mono);
  }
  td.sql {
    max-width: 640px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  button.link {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-size: 12px;
    padding: 0;
  }
</style>
