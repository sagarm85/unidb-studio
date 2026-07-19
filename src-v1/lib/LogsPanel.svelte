<script>
  import { getLogs } from './api.js';
  import ErrorBox from './ErrorBox.svelte';
  import TimeRangePicker from './TimeRangePicker.svelte';

  // ---- fetch params --------------------------------------------------------
  let since = $state(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  let until = $state('');
  let q     = $state('');
  let limit = $state(200);

  // ---- client-side exclusion filters (empty = show all) --------------------
  let excLevels  = $state(new Set());
  let excTargets = $state(new Set());

  // ---- data ----------------------------------------------------------------
  let logs      = $state([]);
  let cursor    = $state(null);
  let scanned   = $state(0);
  let truncated = $state(false);
  let supported = $state(true);
  let error     = $state(null);
  let loading   = $state(false);
  let expanded  = $state(new Set());

  // ---- sidebar section open/close ------------------------------------------
  let sidebarOpen = $state(true);
  let secTime  = $state(true);
  let secType  = $state(true);
  let secLevel = $state(true);

  // ---- derived -------------------------------------------------------------
  function countBy(arr, fn) {
    const m = {};
    for (const x of arr) { const k = fn(x); m[k] = (m[k] ?? 0) + 1; }
    return m;
  }

  let targetCounts = $derived(countBy(logs, r => r.target ?? ''));
  let levelCounts  = $derived(countBy(logs, r => (r.level ?? '').toUpperCase()));
  let allTargets   = $derived(Object.keys(targetCounts).sort());

  const LEVEL_ORDER = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];
  let allLevels = $derived(LEVEL_ORDER.filter(l => levelCounts[l]));

  let visible = $derived(logs.filter(r => {
    if (excLevels.size  && excLevels.has((r.level ?? '').toUpperCase())) return false;
    if (excTargets.size && excTargets.has(r.target ?? ''))               return false;
    return true;
  }));

  // histogram: 48 narrow buckets across the fetched window
  const HIST_N = 48;
  let histogram  = $derived(buildHist(logs, since, until, HIST_N));
  let histMax    = $derived(Math.max(...histogram, 1));
  let timeLabels = $derived(buildTimeLabels(since, until));

  function buildHist(logs, since, until, n) {
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

  // Real clock-hour boundaries aligned to the time range.
  // Step adapts to span so labels never crowd: 10m / 30m / 1h / 2h / 6h / 12h / 24h.
  function buildTimeLabels(since, until) {
    const t0 = since ? new Date(since).getTime() : null;
    const t1 = until ? new Date(until).getTime() : Date.now();
    if (!t0) return [];
    const span   = t1 - t0;
    const spanH  = span / 3_600_000;
    const stepH  = spanH <=  1 ? 1/6   // 10 min
                 : spanH <=  3 ? 0.5   // 30 min
                 : spanH <= 12 ? 1     // 1 h
                 : spanH <= 48 ? 2     // 2 h
                 : spanH <= 168 ? 6    // 6 h
                 : spanH <= 336 ? 12   // 12 h
                 : 24;                 // 24 h
    const stepMs = stepH * 3_600_000;
    // first mark: round up t0 to next stepMs boundary
    const first  = Math.ceil(t0 / stepMs) * stepMs;
    const out    = [];
    for (let t = first; t <= t1; t += stepMs) {
      const pct = ((t - t0) / span) * 100;
      const d   = new Date(t);
      const hh  = String(d.getHours()).padStart(2, '0');
      const mm  = String(d.getMinutes()).padStart(2, '0');
      out.push({ pct, label: stepH >= 1 ? `${hh}:00` : `${hh}:${mm}` });
    }
    return out;
  }

  // ---- helpers -------------------------------------------------------------
  function toggleExc(set, key) {
    const n = new Set(set);
    n.has(key) ? n.delete(key) : n.add(key);
    return n;
  }

  function levelColor(l) {
    const u = String(l ?? '').toUpperCase();
    if (u === 'ERROR') return '#ef4444';
    if (u === 'WARN')  return '#f59e0b';
    if (u === 'DEBUG' || u === 'TRACE') return '#9ca3af';
    return 'var(--accent)';
  }

  function levelClass(l) {
    const u = String(l ?? '').toUpperCase();
    if (u === 'ERROR') return 'lvl-error';
    if (u === 'WARN')  return 'lvl-warn';
    if (u === 'DEBUG' || u === 'TRACE') return 'lvl-dim';
    return 'lvl-info';
  }

  function getMsg(row) {
    return row.fields?.message ?? row.message ?? row.msg ?? row.raw ?? '';
  }

  function fmtTs(ts) {
    if (!ts) return '';
    try { return new Date(ts).toLocaleString(undefined, { hour12: false }); }
    catch { return ts; }
  }

  function extras(row) {
    const { timestamp, level: _l, target: _t, message, msg, raw, fields, ...rest } = row;
    const merged = { ...(fields ?? {}), ...rest };
    if (message !== undefined) merged.message = message;
    if (msg     !== undefined) merged.msg     = msg;
    return merged;
  }

  function toggle(i) {
    const n = new Set(expanded);
    n.has(i) ? n.delete(i) : n.add(i);
    expanded = n;
  }

  // ---- fetch ---------------------------------------------------------------
  async function search({ append = false } = {}) {
    loading = true; error = null;
    try {
      const out = await getLogs({
        since: since || undefined,
        until: until || undefined,
        q: q || undefined,
        limit,
        cursor: append ? cursor : undefined,
      });
      supported = out.supported;
      if (!out.supported) { logs = []; return; }
      logs      = append ? [...logs, ...out.logs] : out.logs;
      cursor    = out.next_cursor;
      scanned   = out.scanned;
      truncated = out.truncated;
      if (!append) { expanded = new Set(); excLevels = new Set(); excTargets = new Set(); }
    } catch (e) {
      error = { code: e.code, message: e.message, status: e.status };
    } finally {
      loading = false;
    }
  }

  function onTimeApply({ since: s, until: u }) {
    since = s; until = u;
    search();
  }
</script>

<div class="logs-layout">
  <!-- Sidebar collapse toggle -->
  <button
    class="sidebar-toggle"
    onclick={() => (sidebarOpen = !sidebarOpen)}
    title={sidebarOpen ? 'Collapse filters' : 'Expand filters'}
    aria-label={sidebarOpen ? 'Collapse filters' : 'Expand filters'}
  >
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.7">
      {#if sidebarOpen}
        <path d="M9 2L4 7l5 5"/>
      {:else}
        <path d="M5 2l5 5-5 5"/>
      {/if}
    </svg>
  </button>

  <!-- ===== SIDEBAR ===== -->
  <aside class="sidebar" class:hidden={!sidebarOpen}>

    <!-- Time Range -->
    <div class="sec">
      <button class="sec-hdr" onclick={() => (secTime = !secTime)}>
        <span>Time Range</span>
        <svg class="chevron {secTime ? 'open' : ''}" width="12" height="12" viewBox="0 0 12 12"
             fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path d="M2 4l4 4 4-4"/>
        </svg>
      </button>
      {#if secTime}
        <div class="sec-body">
          <TimeRangePicker onApply={onTimeApply} />
        </div>
      {/if}
    </div>

    <!-- Log Type (target) -->
    <div class="sec">
      <button class="sec-hdr" onclick={() => (secType = !secType)}>
        <span>Log Type</span>
        {#if excTargets.size}
          <span class="badge">{excTargets.size} hidden</span>
        {/if}
        <svg class="chevron {secType ? 'open' : ''}" width="12" height="12" viewBox="0 0 12 12"
             fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path d="M2 4l4 4 4-4"/>
        </svg>
      </button>
      {#if secType}
        <div class="sec-body">
          {#if !allTargets.length}
            <p class="sec-empty">Run Search to populate.</p>
          {:else}
            {#each allTargets as t}
              <label class="chk-row">
                <input type="checkbox"
                  checked={!excTargets.has(t)}
                  onchange={() => (excTargets = toggleExc(excTargets, t))}
                />
                <span class="chk-label">{t || '(unknown)'}</span>
                <span class="chk-count">{targetCounts[t] ?? 0}</span>
              </label>
            {/each}
          {/if}
        </div>
      {/if}
    </div>

    <!-- Level -->
    <div class="sec">
      <button class="sec-hdr" onclick={() => (secLevel = !secLevel)}>
        <span>Level</span>
        {#if excLevels.size}
          <span class="badge">{excLevels.size} hidden</span>
        {/if}
        <svg class="chevron {secLevel ? 'open' : ''}" width="12" height="12" viewBox="0 0 12 12"
             fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path d="M2 4l4 4 4-4"/>
        </svg>
      </button>
      {#if secLevel}
        <div class="sec-body">
          {#if !allLevels.length}
            <p class="sec-empty">Run Search to populate.</p>
          {:else}
            {#each allLevels as lv}
              <label class="chk-row">
                <input type="checkbox"
                  checked={!excLevels.has(lv)}
                  onchange={() => (excLevels = toggleExc(excLevels, lv))}
                />
                <span class="lvl-dot" style="background:{levelColor(lv)}"></span>
                <span class="chk-label">{lv}</span>
                <span class="chk-count">{levelCounts[lv] ?? 0}</span>
              </label>
            {/each}
          {/if}
        </div>
      {/if}
    </div>

  </aside>

  <!-- ===== MAIN ===== -->
  <div class="main">

    <!-- Search bar -->
    <div class="search-bar">
      <div class="q-wrap">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
             stroke-width="1.8" aria-hidden="true">
          <circle cx="6.5" cy="6.5" r="5"/>
          <path d="M10.5 10.5L14 14" stroke-linecap="round"/>
        </svg>
        <input class="q-input" type="text" placeholder="Search logs…" bind:value={q}
          onkeydown={(e) => e.key === 'Enter' && search()} />
      </div>
      <label class="limit-label">
        Limit
        <input class="limit-input" type="number" min="1" max="500" bind:value={limit} />
      </label>
      <button class="primary" onclick={() => search()} disabled={loading}>
        {loading ? 'Searching…' : 'Search'}
      </button>
    </div>

    {#if error}
      <ErrorBox {error} />
      {#if error.status === 403}
        <p class="muted"><code>/logs</code> is superuser-gated — use a superuser token.</p>
      {/if}
    {/if}

    {#if !supported}
      <p class="muted">This server doesn't expose <code>GET /logs</code>. Rebuild from a build that includes item 22 (logs surface).</p>
    {:else}

      <!-- Histogram -->
      {#if logs.length}
        <div class="hist-wrap" aria-hidden="true">
          <!-- bars with equal horizontal inset so both edges have breathing room -->
          <div class="hist-bars-pad">
            <svg class="hist-svg" viewBox="0 0 {HIST_N * 11} 48" preserveAspectRatio="none">
              {#each histogram as count, i}
                {@const h = Math.max(count ? 3 : 0, Math.round((count / histMax) * 40))}
                <rect
                  x={i * 11 + 1} y={48 - h - 2}
                  width="9" height={h}
                  rx="1.5"
                  fill="var(--accent)"
                  opacity={count ? 0.65 : 0.1}
                />
              {/each}
            </svg>
            <!-- time axis labels aligned inside the same padded region -->
            <div style="position:relative;height:20px;border-top:1px solid var(--border);background:var(--panel-alt);overflow:visible">
              {#each timeLabels as { pct, label }, i}
                {@const isFirst = i === 0}
                {@const isLast  = i === timeLabels.length - 1}
                {@const leftVal = isLast ? '100%' : `${pct}%`}
                {@const tx      = isFirst ? '0%' : isLast ? '-100%' : '-50%'}
                <span style="position:absolute;left:{leftVal};transform:translateX({tx});top:3px;font-size:10px;font-family:var(--mono);color:var(--muted);white-space:nowrap;line-height:1">{label}</span>
              {/each}
            </div>
          </div>
        </div>
        <!-- meta line sits below the card, not inside it -->
        <div class="hist-meta">
          <span>{visible.length}{excLevels.size || excTargets.size ? ` of ${logs.length}` : ''} shown</span>
          <span>·</span>
          <span>{scanned.toLocaleString()} scanned</span>
          {#if truncated}<span>· scan budget hit</span>{/if}
        </div>
      {/if}

      <!-- Log table -->
      {#if visible.length}
        <div class="table-wrap">
          <table class="log-table">
            <thead>
              <tr>
                <th class="col-lvl">Level</th>
                <th class="col-ts">Timestamp</th>
                <th class="col-target">Target</th>
                <th class="col-msg">Message</th>
              </tr>
            </thead>
            <tbody>
              {#each visible as row, i}
                <tr
                  class="log-row {expanded.has(i) ? 'is-open' : ''}"
                  role="button"
                  tabindex="0"
                  onclick={() => toggle(i)}
                  onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle(i))}
                >
                  <td><span class="lvl {levelClass(row.level)}">{(row.level ?? '·').toUpperCase()}</span></td>
                  <td class="ts">{fmtTs(row.timestamp)}</td>
                  <td class="target">{row.target ?? ''}</td>
                  <td class="msg">{getMsg(row)}</td>
                </tr>
                {#if expanded.has(i)}
                  <tr class="detail-row">
                    <td colspan="4">
                      <pre class="detail">{JSON.stringify(extras(row), null, 2)}</pre>
                    </td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
        </div>

        {#if cursor}
          <button class="link more" onclick={() => search({ append: true })} disabled={loading}>
            Load older →
          </button>
        {:else}
          <p class="muted end">End of results.</p>
        {/if}

      {:else if !loading && logs.length}
        <p class="muted">All results filtered out — uncheck some filters on the left.</p>
      {:else if !loading}
        <p class="muted">No log lines. Set a time range and Search — results are newest-first.</p>
      {/if}

    {/if}
  </div>
</div>

<style>
  /* ---- two-column layout — fills parent panel, no outer scroll ---- */
  .logs-layout {
    display: flex;
    gap: 0;
    height: 100%;
    overflow: hidden;
    position: relative;
  }

  /* sidebar collapse toggle */
  .sidebar-toggle {
    position: absolute;
    top: 10px;
    left: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
    color: var(--muted);
    padding: 0;
    transform: translateX(210px);
    transition: transform 0.2s;
  }
  .sidebar-toggle:hover { color: var(--text); border-color: var(--accent); }
  /* when sidebar is collapsed the button anchors to the left edge */
  :global(.logs-layout:has(.sidebar.hidden) .sidebar-toggle) {
    transform: translateX(4px);
  }

  /* ===== SIDEBAR ===== */
  .sidebar {
    width: 232px;
    flex-shrink: 0;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 0;
    overflow-y: auto;
    padding-bottom: 24px;
    transition: width 0.2s, opacity 0.15s;
  }
  .sidebar.hidden {
    width: 0;
    overflow: hidden;
    opacity: 0;
    border-right: none;
    padding: 0;
  }

  .sec {
    border-bottom: 1px solid var(--border);
  }
  .sec-hdr {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 9px 14px;
    background: none;
    border: none;
    text-align: left;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text);
    cursor: pointer;
  }
  .sec-hdr:hover { background: var(--panel-alt); }
  .sec-hdr span:first-child { flex: 1; }

  .chevron { transition: transform 0.15s; opacity: 0.5; }
  .chevron.open { transform: rotate(180deg); }

  .badge {
    font-size: 10px;
    font-weight: 500;
    background: var(--accent);
    color: #fff;
    border-radius: 8px;
    padding: 1px 6px;
  }

  .sec-body { padding: 4px 0 8px; }

  .sec-empty {
    font-size: 12px;
    color: var(--muted);
    padding: 4px 14px;
    margin: 0;
  }

  .chk-row {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 5px 14px;
    cursor: pointer;
    font-size: 12.5px;
    color: var(--text);
  }
  .chk-row:hover { background: var(--panel-alt); }
  .chk-row input[type="checkbox"] { cursor: pointer; accent-color: var(--accent); }
  .chk-label { flex: 1; font-family: var(--mono); font-size: 11.5px; }
  .chk-count {
    font-size: 11px;
    color: var(--muted);
    min-width: 24px;
    text-align: right;
  }
  .lvl-dot {
    width: 9px; height: 9px;
    border-radius: 2px;
    flex-shrink: 0;
  }

  /* ===== MAIN ===== */
  .main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-left: 30px;  /* leaves room for the toggle button */
    overflow: hidden;
  }

  /* search bar */
  .search-bar {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .q-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 10px;
    background: var(--panel);
  }
  .q-wrap svg { opacity: 0.4; flex-shrink: 0; }
  .q-input {
    flex: 1;
    border: none;
    background: transparent;
    color: var(--text);
    font-size: 13px;
  }
  .q-input:focus { outline: none; }

  .limit-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: var(--muted);
    white-space: nowrap;
  }
  .limit-input {
    width: 60px;
    padding: 5px 7px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--panel);
    color: var(--text);
    font-size: 13px;
  }

  button.primary {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 5px;
    padding: 7px 14px;
    cursor: pointer;
    font-size: 13px;
    white-space: nowrap;
  }
  button.primary:disabled { opacity: 0.6; cursor: default; }

  /* histogram */
  .hist-wrap {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel-alt);
    overflow: visible;
  }
  /* equal left/right inset so bars don't touch the card edges */
  .hist-bars-pad {
    padding: 0 2px;
  }
  .hist-svg {
    width: 100%;
    height: 48px;
    display: block;
    border-radius: 4px 4px 0 0;
  }
  /* meta line sits below the histogram card */
  .hist-meta {
    display: flex;
    gap: 6px;
    font-size: 11.5px;
    color: var(--muted);
    padding: 4px 2px 0;
  }

  /* log table — only this region scrolls */
  .table-wrap {
    flex: 1;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: auto;
  }
  .log-table {
    width: 100%;
    table-layout: fixed;          /* columns honour declared widths; msg gets the rest */
    border-collapse: collapse;
    font-family: var(--mono);
    font-size: 12.5px;
  }
  .log-table thead th {
    text-align: left;
    padding: 6px 10px;
    background: var(--panel-alt);
    border-bottom: 1px solid var(--border);
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    overflow: hidden;
    white-space: nowrap;
  }
  .col-lvl    { width: 56px; }
  .col-ts     { width: 152px; }
  .col-target { width: 148px; }
  .col-msg    { /* fills all remaining width */ }

  .log-row { cursor: pointer; border-bottom: 1px solid var(--border); }
  .log-row:hover td,
  .log-row.is-open td { background: var(--panel-alt); }
  .log-row td {
    padding: 4px 10px;
    vertical-align: middle;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .log-row td.msg   { color: var(--text); }
  .log-row td.ts     { color: var(--muted); font-size: 12px; }
  .log-row td.target { color: var(--accent); opacity: 0.85; font-size: 12px; }

  .lvl         { display: inline-block; font-weight: 700; font-size: 11px; }
  .lvl-error   { color: var(--err-fg); }
  .lvl-warn    { color: #d99922; }
  .lvl-info    { color: var(--accent); }
  .lvl-dim     { color: var(--muted); }

  .detail-row td {
    padding: 0;
    border-bottom: 1px solid var(--border);
    background: var(--panel-alt);
  }
  .detail {
    margin: 0; padding: 8px 12px;
    font-size: 12px; overflow-x: auto; white-space: pre;
  }

  /* misc */
  .muted { color: var(--muted); font-size: 13px; }
  button.link { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 13px; padding: 4px 0; }
  .more       { align-self: flex-start; }
  .end        { text-align: center; }
</style>
