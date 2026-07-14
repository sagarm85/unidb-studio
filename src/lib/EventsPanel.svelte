<script>
  import {
    streaming, events, lastSeq, streamErr,
    startStream, stopStream, clearEvents, maybeResume,
  } from './eventStore.js';
  import { enableTableEvents, disableTableEvents, getCdcStatus, ackEvents, runSql } from './api.js';
  import ErrorBox from './ErrorBox.svelte';

  let { tables = [] } = $props();

  let table   = $state('');
  let fromSeq = $state('');
  let subTab  = $state('stream');  // 'stream' | 'cdc' | 'consumers'

  // CDC status per table: Map<tableName, boolean>
  let cdcStatus     = $state(new Map());
  let cdcLoading    = $state(false);

  // Consumer lag from engine: unidb_catalog.subscription_lag
  let consumers     = $state([]);
  let consumerTimer = null;

  // Auto-ACK subscriber mode — set from URL params when opened via "Subscribe" link
  let autoAckConsumer = $state('');
  let autoAckMode     = $state(false);
  let lastAckedSeq    = $state(null);

  async function loadCdcStatus() {
    cdcLoading = true;
    const next = new Map();
    await Promise.all(
      userTables.map(async (t) => {
        try {
          const r = await getCdcStatus(t.name);
          next.set(t.name, r.enabled);
        } catch { next.set(t.name, false); }
      })
    );
    cdcStatus = next;
    cdcLoading = false;
  }

  async function pollConsumers() {
    try {
      // Engine-native: unidb_catalog.subscription_lag populated by POST /events/ack
      const res = await runSql('SELECT consumer, "offset", lag_events, lag_seconds FROM unidb_catalog.subscription_lag ORDER BY consumer');
      consumers = (res.results?.[0]?.rows ?? []).map(([name, seq, lagEvents, lagSeconds]) => ({
        name, seq, lagEvents, lagSeconds,
      }));
    } catch { /* catalog may be empty */ }
  }

  $effect(() => {
    maybeResume();
    loadCdcStatus();
    pollConsumers();
    consumerTimer = setInterval(pollConsumers, 2000);

    // Auto-start subscriber from URL params (opened via "Subscribe" link)
    const params = new URLSearchParams(window.location.search);
    const paramTable    = params.get('table') ?? '';
    const paramConsumer = params.get('consumer') ?? '';
    if (params.get('autostart') === '1' && paramTable) {
      table = paramTable;
      if (params.get('autoack') === '1' && paramConsumer) {
        autoAckConsumer = paramConsumer;
        autoAckMode     = true;
      }
      startStream({ table: paramTable, fromSeq: '' });
    }

    return () => clearInterval(consumerTimer);
  });

  // Auto-ACK: whenever new events arrive, ACK up to the latest seq via POST /events/ack
  $effect(() => {
    if (!autoAckMode || !autoAckConsumer || $events.length === 0) return;
    const latest = $events[$events.length - 1];
    if (latest?.seq != null && latest.seq !== lastAckedSeq) {
      lastAckedSeq = latest.seq;
      ackEvents(autoAckConsumer, latest.seq).catch(() => {});
    }
  });

  // Reload CDC status whenever the user switches to that subtab
  $effect(() => {
    if (subTab === 'cdc') loadCdcStatus();
  });

  // Open a new browser tab as a live subscriber for the given table
  function openSubscriber(tableName) {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', 'events');
    url.searchParams.set('table', tableName);
    url.searchParams.set('consumer', `browser-${tableName}`);
    url.searchParams.set('autostart', '1');
    url.searchParams.set('autoack', '1');
    window.open(url.toString(), '_blank');
  }

  function start() { startStream({ table, fromSeq }); }
  function stop()  { stopStream(); }

  function resumeFromLast() {
    const seq = $lastSeq;
    if (seq != null) fromSeq = String(seq);
    startStream({ table, fromSeq });
  }

  async function enableCdc(t) {
    try { await enableTableEvents(t); } catch { /* already enabled is fine */ }
    await loadCdcStatus();
  }

  async function disableCdc(t) {
    try { await disableTableEvents(t); } catch { /* already off is fine */ }
    await loadCdcStatus();
  }

  function opClass(op) {
    return op === 'insert' ? 'op-insert' : op === 'update' ? 'op-update' : 'op-delete';
  }

  const userTables = $derived(tables.filter(t => !/^__/.test(t.name)));

  // Row detail drawer
  let selectedEvent = $state(null);
  function openDetail(e) { selectedEvent = e; }
  function closeDetail() { selectedEvent = null; }
</script>

<div class="events">

  <!-- ── Subtab bar ── -->
  <div class="subtabs">
    <button class:active={subTab === 'stream'}    onclick={() => subTab = 'stream'}>Live stream</button>
    <button class:active={subTab === 'cdc'}       onclick={() => subTab = 'cdc'}>CDC tables</button>
    <button class:active={subTab === 'consumers'} onclick={() => subTab = 'consumers'}>
      Consumers
      {#if consumers.length > 0}<span class="badge">{consumers.length}</span>{/if}
    </button>
  </div>

  <!-- ══ LIVE STREAM ══════════════════════════════════════════════════════════ -->
  {#if subTab === 'stream'}

    <div class="toolbar">
      <div class="controls">
        <label>
          Table
          <select bind:value={table} disabled={$streaming}>
            <option value="">all enabled</option>
            {#each userTables as t}
              <option value={t.name}>{t.name}</option>
            {/each}
          </select>
        </label>
        <label>
          From seq
          <input type="number" min="0" placeholder="latest" bind:value={fromSeq} disabled={$streaming} />
        </label>
        {#if !$streaming}
          <button class="primary" onclick={start}>▶ Start tail</button>
        {:else}
          <button class="stop" onclick={stop}>■ Stop</button>
        {/if}
        <button class="link" onclick={clearEvents} disabled={!$events.length}>Clear</button>
      </div>
    </div>

    <div class="status">
      <span class="dot" class:on={$streaming}></span>
      {#if $streaming}
        Live{table ? ` · ${table}` : ''}{$lastSeq != null ? ` · seq ${$lastSeq}` : ''}
        <span class="hint">(persists across tab switches and page reloads)</span>
      {:else}
        Stopped
        {#if $lastSeq != null}
          · <button class="link" onclick={resumeFromLast}>resume after seq {$lastSeq} →</button>
        {/if}
      {/if}
      {#if autoAckMode && autoAckConsumer}
        <span class="ack-badge">⚡ auto-ACK as <strong>{autoAckConsumer}</strong>{lastAckedSeq != null ? ` · acked seq ${lastAckedSeq}` : ''}</span>
      {/if}
      <span class="spacer"></span>
      <span class="muted">{$events.length} event{$events.length === 1 ? '' : 's'} (max 500)</span>
    </div>

    {#if $streamErr}
      <ErrorBox error={$streamErr} />
      <p class="muted">Table may not have CDC enabled — go to the <button class="link" onclick={() => subTab='cdc'}>CDC tables</button> tab to enable it.</p>
    {/if}

    {#if $events.length}
      <div class="stream-wrap">
        <table class="evt-table">
          <thead>
            <tr>
              <th class="col-seq">Seq</th>
              <th class="col-op">Operation</th>
              <th class="col-tbl">Table</th>
              <th class="col-xid">Txn ID</th>
              <th class="col-payload">Row data</th>
            </tr>
          </thead>
          <tbody>
            {#each $events as e (e.seq)}
              <tr class="evt-row" class:selected={selectedEvent?.seq === e.seq} onclick={() => openDetail(e)} title="Click to inspect payload">
                <td class="col-seq mono muted">#{e.seq}</td>
                <td class="col-op"><span class="op-chip {opClass(e.op)}">{e.op.toUpperCase()}</span></td>
                <td class="col-tbl mono">{e.table_name}</td>
                <td class="col-xid mono muted">{e.xid}</td>
                <td class="col-payload"><code class="payload">{JSON.stringify(e.payload)}</code></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if !$streaming}
      <p class="muted">Pick a table (or "all enabled"), then <strong>Start tail</strong> to watch committed INSERT/UPDATE/DELETE events live.</p>
    {:else}
      <p class="muted">Waiting for events…</p>
    {/if}

  <!-- ══ CDC TABLES ══════════════════════════════════════════════════════════ -->
  {:else if subTab === 'cdc'}

    <p class="section-desc">
      Change-Data-Capture must be enabled per table before the engine emits events.
      Status is read live from <code>GET /tables/{'{name}'}/events</code>.
    </p>

    <div class="cdc-toolbar">
      <button class="ghost sm" onclick={loadCdcStatus} disabled={cdcLoading}>
        {cdcLoading ? 'Loading…' : '↻ Refresh'}
      </button>
    </div>

    <table class="info-table">
      <thead>
        <tr>
          <th>Table</th>
          <th>CDC status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each userTables as t}
          {@const enabled = cdcStatus.get(t.name)}
          <tr>
            <td class="mono">{t.name}</td>
            <td>
              {#if cdcLoading}
                <span class="muted" style="font-size:11px">loading…</span>
              {:else if enabled}
                <span class="badge-enabled">● enabled</span>
              {:else}
                <span class="badge-off">○ not enabled</span>
              {/if}
            </td>
            <td class="action-cell">
              {#if !enabled}
                <button class="ghost sm" onclick={() => enableCdc(t.name)}>Enable CDC</button>
              {:else}
                <button class="ghost sm danger" onclick={() => disableCdc(t.name)}>Disable</button>
                <button class="ghost sm subscribe" onclick={() => openSubscriber(t.name)}
                        title="Open a live subscriber for {t.name} in a new tab — auto-ACKs consumed events">
                  ▶ Subscribe
                </button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>

    <div class="tip-box">
      <strong>Database-level CDC</strong> is not supported — enable per table above,
      or run <code>python3 demo/events_demo.py</code> which enables CDC on <code>orders</code> automatically.
    </div>

  <!-- ══ CONSUMERS ═══════════════════════════════════════════════════════════ -->
  {:else}

    <p class="section-desc">
      Consumer offsets from <code>unidb_catalog.subscription_lag</code> — advanced by
      <code>POST /events/ack</code> each time a consumer durably processes events.
    </p>

    {#if consumers.length === 0}
      <p class="muted">
        No consumers registered yet. Run <code>python3 demo/events_demo.py</code> to register <code>demo-py</code>.
      </p>
    {:else}
      <table class="info-table">
        <thead>
          <tr>
            <th>Consumer</th>
            <th class="num">Committed offset</th>
            <th class="num">Lag (events)</th>
            <th class="num">Lag (seconds)</th>
            <th>Replay</th>
          </tr>
        </thead>
        <tbody>
          {#each consumers as c}
            <tr>
              <td class="mono accent">{c.name}</td>
              <td class="num mono">{c.seq}</td>
              <td class="num mono">{c.lagEvents ?? '—'}</td>
              <td class="num mono">{c.lagSeconds != null ? c.lagSeconds.toFixed(1) + 's' : '—'}</td>
              <td>
                <button class="ghost sm" onclick={() => {
                  subTab = 'stream';
                  fromSeq = String(c.seq);
                  table = '';
                  startStream({ table: '', fromSeq: String(c.seq) });
                }}>
                  ▶ Resume from seq {c.seq}
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

  {/if}
</div>

<!-- ── Event detail drawer ──────────────────────────────────────────────────── -->
{#if selectedEvent}
  <div class="drawer-backdrop" onclick={closeDetail} role="presentation"></div>
  <div class="drawer">
    <div class="drawer-head">
      <span class="op-chip {opClass(selectedEvent.op)}">{selectedEvent.op.toUpperCase()}</span>
      <span class="drawer-title">{selectedEvent.table_name} · seq #{selectedEvent.seq}</span>
      <span class="drawer-xid muted">txn {selectedEvent.xid}</span>
      <button class="drawer-close" onclick={closeDetail} title="Close">✕</button>
    </div>
    <div class="drawer-body">
      <div class="drawer-label">Row data (payload)</div>
      <pre class="drawer-json">{JSON.stringify(selectedEvent.payload, null, 2)}</pre>
    </div>
  </div>
{/if}

<style>
  .events { display: flex; flex-direction: column; gap: 12px; }

  /* Subtabs */
  .subtabs {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid var(--border);
    padding-bottom: 0;
  }
  .subtabs button {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 6px 14px;
    font-size: 13px;
    color: var(--muted);
    cursor: pointer;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 5px;
    margin-bottom: -1px;
  }
  .subtabs button.active { color: var(--accent); border-bottom-color: var(--accent); }
  .subtabs button:hover:not(.active) { color: var(--text); }
  .badge {
    background: var(--accent);
    color: #fff;
    border-radius: 8px;
    padding: 1px 6px;
    font-size: 10px;
    font-weight: 700;
  }

  /* Controls */
  .controls {
    display: flex;
    gap: 10px;
    align-items: flex-end;
    flex-wrap: wrap;
  }
  .controls label {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 11px;
    color: var(--muted);
  }
  .controls input, .controls select {
    padding: 5px 7px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--panel);
    color: var(--text);
    font-size: 13px;
  }
  .controls input { width: 110px; }

  button.primary { background: var(--accent); color: #fff; border: none; border-radius: 5px; padding: 7px 14px; cursor: pointer; font-size: 13px; }
  button.stop    { background: var(--err-fg); color: #fff; border: none; border-radius: 5px; padding: 7px 14px; cursor: pointer; font-size: 13px; }
  button.ghost   { background: var(--panel-alt); color: var(--text); border: 1px solid var(--border); border-radius: 5px; padding: 7px 12px; cursor: pointer; font-size: 13px; }
  button.ghost.sm { padding: 3px 10px; font-size: 12px; }
  button.ghost.danger    { color: var(--err-fg); border-color: var(--err-fg); }
  button.ghost.subscribe { color: #16a34a; border-color: #16a34a; }
  button.ghost:disabled  { opacity: 0.5; cursor: default; }
  .cdc-toolbar { display: flex; justify-content: flex-end; }
  .action-cell { display: flex; gap: 6px; }
  button.link    { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 12px; padding: 0; }
  .ack-badge {
    background: rgba(22,163,74,0.1);
    color: #16a34a;
    border: 1px solid rgba(22,163,74,0.3);
    border-radius: 5px;
    padding: 2px 8px;
    font-size: 11px;
  }

  /* Status bar */
  .status { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text); }
  .spacer { flex: 1; }
  .muted  { color: var(--muted); font-size: 13px; }
  .hint   { color: var(--muted); font-size: 11px; font-style: italic; }
  .dot    { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); display: inline-block; }
  .dot.on { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.2); }

  /* Stream */
  .stream-wrap { border: 1px solid var(--border); border-radius: 6px; overflow: auto; max-height: 60vh; }
  .evt-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  .evt-table thead th {
    position: sticky; top: 0; background: var(--panel-alt);
    text-align: left; padding: 6px 10px;
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.04em; color: var(--muted);
    border-bottom: 1px solid var(--border);
  }
  .evt-table tbody tr { border-bottom: 1px solid var(--border); }
  .evt-table tbody tr:last-child { border-bottom: none; }
  .evt-table tbody tr:hover { background: var(--panel-alt); }
  .evt-table td { padding: 5px 10px; vertical-align: middle; }
  .col-seq  { width: 60px; white-space: nowrap; }
  .col-op   { width: 90px; white-space: nowrap; }
  .col-tbl  { width: 140px; white-space: nowrap; color: var(--accent); }
  .col-xid  { width: 80px; white-space: nowrap; font-size: 11px; }
  .col-payload { max-width: 0; }
  .op-chip { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 700; font-family: var(--mono); }
  .op-insert { background: rgba(22,163,74,0.12);  color: #16a34a; }
  .op-update { background: rgba(202,138,4,0.12);  color: #b45309; }
  .op-delete { background: rgba(220,38,38,0.12);  color: var(--err-fg); }
  .payload { font-family: var(--mono); font-size: 12px; color: var(--text); display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 640px; }

  /* Info tables */
  .section-desc { font-size: 13px; color: var(--muted); margin: 0; }
  .info-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .info-table th { text-align: left; padding: 6px 10px; color: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; border-bottom: 1px solid var(--border); }
  .info-table td { padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  .info-table tr:last-child td { border-bottom: none; }
  .info-table tr:hover td { background: var(--panel-alt); }
  .info-table .num { text-align: right; }
  .mono   { font-family: var(--mono); }
  .accent { color: var(--accent); }
  .badge-enabled { color: #16a34a; font-size: 12px; font-weight: 600; }
  .badge-off     { color: var(--muted); font-size: 12px; }

  .tip-box {
    background: var(--panel-alt);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 14px;
    font-size: 12px;
    color: var(--muted);
    line-height: 1.6;
  }
  .tip-box strong { color: var(--text); }
  .tip-box code { font-family: var(--mono); font-size: 11px; }

  /* ── event row click ── */
  .evt-row { cursor: pointer; }
  .evt-row:hover td { background: var(--panel-alt); }
  .evt-row.selected td { background: color-mix(in srgb, var(--accent) 8%, transparent); }

  /* ── detail drawer ── */
  .drawer-backdrop {
    position: fixed; inset: 0; z-index: 40;
    background: rgba(0,0,0,0.35);
  }
  .drawer {
    position: fixed;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: min(560px, 90vw);
    max-height: 70vh;
    z-index: 50;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
  }
  .drawer-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .drawer-title { font-size: 13px; font-weight: 600; flex: 1; font-family: var(--mono); }
  .drawer-xid   { font-size: 11px; }
  .drawer-close {
    background: none; border: none; cursor: pointer;
    color: var(--muted); font-size: 15px; line-height: 1;
    padding: 2px 5px; border-radius: 4px;
  }
  .drawer-close:hover { background: var(--panel-alt); color: var(--text); }
  .drawer-body { overflow: auto; padding: 12px 14px; flex: 1; }
  .drawer-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin-bottom: 6px; }
  .drawer-json {
    margin: 0;
    font-family: var(--mono);
    font-size: 12.5px;
    line-height: 1.6;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
