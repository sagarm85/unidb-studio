<script>
  // Loads /benchmark-results.json written by demo/compare.py and renders a
  // side-by-side unidb vs Postgres comparison with bar charts.

  let data    = $state(null);
  let loading = $state(true);
  let error   = $state(null);

  async function loadResults() {
    loading = true;
    error   = null;
    try {
      const res = await fetch('/benchmark-results.json', { cache: 'no-store' });
      if (res.status === 404) {
        data = null;
      } else if (!res.ok) {
        error = `HTTP ${res.status}`;
      } else {
        data = await res.json();
      }
    } catch (e) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  $effect(() => { loadResults(); });

  // Max ms across all queries — used to normalize bar widths.
  const maxMs = $derived(() => {
    if (!data?.queries?.length) return 1;
    return Math.max(...data.queries.flatMap((q) => [q.unidb_ms ?? 0, q.postgres_ms ?? 0]));
  });

  function barPct(ms) {
    return Math.min(100, (ms / maxMs()) * 100);
  }

  function ratioLabel(r) {
    if (r == null) return '';
    if (r < 0.95)  return `unidb ${(1/r).toFixed(2)}× faster`;
    if (r > 1.05)  return `postgres ${r.toFixed(2)}× faster`;
    return 'roughly equal';
  }

  function ratioColor(r) {
    if (r == null) return 'var(--muted)';
    if (r < 0.8)  return '#22c55e';   // unidb clearly faster
    if (r < 0.95) return '#86efac';
    if (r > 1.25) return '#f87171';   // postgres clearly faster
    if (r > 1.05) return '#fca5a5';
    return 'var(--muted)';
  }

  function fmt(ms) {
    if (ms == null) return '—';
    return ms < 1000 ? `${ms.toFixed(1)} ms` : `${(ms/1000).toFixed(2)} s`;
  }

  function relTime(iso) {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60000)  return `${Math.floor(diff/1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
    return new Date(iso).toLocaleTimeString();
  }
</script>

<div class="compare">

  <!-- ── Header ──────────────────────────────────────────────────────────── -->
  <div class="topbar">
    <div class="topbar-left">
      <h2>unidb vs Postgres</h2>
      {#if data}
        <span class="badge">
          {data.size} · {data.n_cust?.toLocaleString()} customers ·
          {data.n_ord?.toLocaleString()} orders
        </span>
        <span class="run-time">run {relTime(data.run_at)}</span>
      {/if}
    </div>
    <button class="btn" onclick={loadResults}>↺ Refresh</button>
  </div>

  {#if loading}
    <p class="muted center">Loading…</p>

  {:else if error}
    <div class="notice err">Error loading results: {error}</div>

  {:else if !data}
    <div class="notice">
      <strong>No results yet.</strong> Run the comparison script to generate data:
      <pre>pip3 install psycopg2-binary
python3 demo/compare.py --size 10k</pre>
      Then click <em>Refresh</em> above.
    </div>

  {:else}

    <!-- ── Summary banner ─────────────────────────────────────────────── -->
    {#if data.summary}
      {@const s = data.summary}
      <div class="summary-row">
        <div class="summary-card unidb">
          <div class="eng-label">unidb</div>
          <div class="eng-total">{fmt(s.unidb_total_ms)}</div>
          <div class="eng-sub">total across {data.queries.length} queries</div>
        </div>
        <div class="vs">vs</div>
        <div class="summary-card pg">
          <div class="eng-label">PostgreSQL 16</div>
          <div class="eng-total">{fmt(s.postgres_total_ms)}</div>
          <div class="eng-sub">total across {data.queries.length} queries</div>
        </div>
        {#if s.ratio != null}
          <div class="verdict" style={`color:${ratioColor(s.ratio)}`}>
            {ratioLabel(s.ratio)}
            <div class="verdict-sub">overall</div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- ── Per-query bars ──────────────────────────────────────────────── -->
    <div class="queries">
      {#each data.queries as q}
        <div class="query-row">
          <div class="q-label">{q.label}</div>
          <div class="bars">
            <!-- unidb bar -->
            <div class="bar-row">
              <span class="eng-tag unidb-tag">unidb</span>
              <div class="bar-track">
                <div class="bar unidb-bar" style={`width:${barPct(q.unidb_ms)}%`}></div>
              </div>
              <span class="bar-val">{fmt(q.unidb_ms)}</span>
            </div>
            <!-- postgres bar -->
            {#if q.postgres_ms != null}
              <div class="bar-row">
                <span class="eng-tag pg-tag">postgres</span>
                <div class="bar-track">
                  <div class="bar pg-bar" style={`width:${barPct(q.postgres_ms)}%`}></div>
                </div>
                <span class="bar-val">{fmt(q.postgres_ms)}</span>
              </div>
            {/if}
          </div>
          {#if q.ratio != null}
            <div class="q-ratio" style={`color:${ratioColor(q.ratio)}`}>
              {ratioLabel(q.ratio)}
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <!-- ── Footer ─────────────────────────────────────────────────────── -->
    <div class="footer">
      unidb @ <code>{data.unidb_url}</code>
      {#if data.postgres_dsn}
        · postgres DSN: <code>{data.postgres_dsn}</code>
      {/if}
      <br>
      <span class="muted">
        Timings are browser/script round-trip (network included).
        Run <code>python3 demo/compare.py --size 50k</code> to refresh.
      </span>
    </div>
  {/if}
</div>

<style>
  .compare {
    display: flex;
    flex-direction: column;
    gap: 18px;
    font-size: 13px;
    max-width: 960px;
  }

  /* Top bar */
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .topbar-left {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
  }
  h2 { margin: 0; font-size: 15px; }
  .badge {
    background: var(--accent-faint, rgba(99,102,241,.1));
    color: var(--accent);
    border-radius: 10px;
    padding: 2px 8px;
    font-size: 11px;
    font-weight: 600;
  }
  .run-time { color: var(--muted); font-size: 11px; }
  .btn {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 4px 12px;
    font-size: 12px;
    cursor: pointer;
    color: var(--muted);
  }
  .btn:hover { color: var(--text); }

  /* Summary banner */
  .summary-row {
    display: flex;
    align-items: center;
    gap: 18px;
    flex-wrap: wrap;
  }
  .summary-card {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 20px;
    min-width: 160px;
  }
  .summary-card.unidb { border-left: 4px solid var(--accent); }
  .summary-card.pg    { border-left: 4px solid #336791; }
  .eng-label { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .eng-total { font-size: 26px; font-weight: 700; margin: 4px 0 2px; }
  .eng-sub   { font-size: 11px; color: var(--muted); }
  .vs { font-size: 18px; font-weight: 700; color: var(--muted); }
  .verdict { font-size: 14px; font-weight: 600; }
  .verdict-sub { font-size: 11px; color: var(--muted); font-weight: 400; margin-top: 2px; }

  /* Per-query rows */
  .queries { display: flex; flex-direction: column; gap: 14px; }
  .query-row {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 14px;
  }
  .q-label {
    font-weight: 600;
    margin-bottom: 8px;
  }
  .bars { display: flex; flex-direction: column; gap: 6px; }
  .bar-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .eng-tag {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    width: 68px;
    flex-shrink: 0;
    letter-spacing: .04em;
  }
  .unidb-tag { color: var(--accent); }
  .pg-tag    { color: #336791; }
  .bar-track {
    flex: 1;
    background: var(--bg);
    border-radius: 3px;
    height: 12px;
    overflow: hidden;
  }
  .bar {
    height: 100%;
    border-radius: 3px;
    transition: width 0.4s ease;
  }
  .unidb-bar { background: var(--accent); opacity: 0.8; }
  .pg-bar    { background: #336791; opacity: 0.8; }
  .bar-val {
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    width: 70px;
    text-align: right;
    flex-shrink: 0;
  }
  .q-ratio {
    margin-top: 6px;
    font-size: 11px;
    font-weight: 600;
  }

  /* Misc */
  .notice {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 20px;
    background: var(--panel);
    line-height: 1.6;
  }
  .notice.err { border-color: #f87171; color: #ef4444; }
  .notice pre {
    background: var(--bg);
    padding: 10px;
    border-radius: 5px;
    font-size: 12px;
    margin: 10px 0 0;
  }
  .footer {
    font-size: 11px;
    color: var(--muted);
    line-height: 1.8;
    padding-top: 8px;
    border-top: 1px solid var(--border);
  }
  .footer code { font-family: var(--mono); }
  .muted { color: var(--muted); }
  .center { text-align: center; padding: 40px; }
</style>
