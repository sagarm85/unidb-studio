<script>
  // Events tab (Milestone 20). Live change-event viewer over the ephemeral
  // SSE tail (GET /events/subscribe, no consumer → at-most-once browser tail).
  // Supports per-table enable (POST /tables/{t}/events), table filter,
  // offset scrubbing / replay-from-offset via `from_seq`, and auto-resume on
  // reconnect through the Last-Event-ID header (handled in openEventStream).
  import { openEventStream, enableTableEvents } from './api.js';
  import ErrorBox from './ErrorBox.svelte';

  let { tables = [] } = $props();

  const MAX_ROWS = 500; // bound the in-memory buffer

  let table = $state(''); // '' = all enabled tables
  let fromSeq = $state(''); // offset to (re)start strictly after
  let events = $state([]); // newest first
  let streaming = $state(false);
  let error = $state(null);
  let lastSeq = $state(null); // highest seq seen — the live cursor
  let enabling = $state(false);
  let notice = $state(null);

  let handle = null; // active stream { close }

  function start() {
    stop();
    error = null;
    const opts = {
      table: table || undefined,
      fromSeq: fromSeq !== '' ? Number(fromSeq) : undefined,
      onOpen: () => { streaming = true; },
      onEvent: (evt) => {
        lastSeq = evt.seq;
        events = [evt, ...events].slice(0, MAX_ROWS);
      },
      onError: (e) => {
        error = { code: e.code, message: e.message, status: e.status };
        streaming = false;
      },
    };
    // On an explicit restart we honor the typed from_seq; the stream's own
    // reconnect uses Last-Event-ID past lastSeq automatically.
    handle = openEventStream(opts);
  }

  function stop() {
    handle?.close();
    handle = null;
    streaming = false;
  }

  function clear() {
    events = [];
    lastSeq = null;
  }

  // Resume exactly after the last event we saw (offset scrubbing convenience).
  function resumeFromLast() {
    if (lastSeq != null) fromSeq = String(lastSeq);
    start();
  }

  async function enable() {
    if (!table) return;
    enabling = true;
    error = null;
    notice = null;
    try {
      await enableTableEvents(table);
      notice = `Event capture enabled on "${table}".`;
    } catch (e) {
      error = { code: e.code, message: e.message, status: e.status };
    } finally {
      enabling = false;
    }
  }

  // Tear the stream down when the tab unmounts.
  $effect(() => () => stop());

  function opClass(op) {
    return op === 'insert' ? 'op-insert' : op === 'update' ? 'op-update' : 'op-delete';
  }
  const userTables = $derived(tables.filter((t) => !/^__/.test(t.name)));
</script>

<div class="events">
  <div class="toolbar">
    <h3>Events</h3>
    <div class="controls">
      <label>
        Table
        <select bind:value={table} disabled={streaming}>
          <option value="">all enabled</option>
          {#each userTables as t}
            <option value={t.name}>{t.name}</option>
          {/each}
        </select>
      </label>
      <label>
        From seq
        <input type="number" min="0" placeholder="latest" bind:value={fromSeq} disabled={streaming} />
      </label>
      {#if !streaming}
        <button class="primary" onclick={start}>▶ Start tail</button>
      {:else}
        <button class="stop" onclick={stop}>■ Stop</button>
      {/if}
      <button class="ghost" onclick={enable} disabled={!table || enabling}>
        {enabling ? 'Enabling…' : 'Enable capture'}
      </button>
      <button class="link" onclick={clear} disabled={!events.length}>Clear</button>
    </div>
  </div>

  <div class="status">
    <span class="dot" class:on={streaming}></span>
    {#if streaming}
      Live{table ? ` · ${table}` : ''}{lastSeq != null ? ` · seq ${lastSeq}` : ''}
    {:else}
      Stopped
      {#if lastSeq != null}
        · <button class="link" onclick={resumeFromLast}>resume after seq {lastSeq} →</button>
      {/if}
    {/if}
    <span class="spacer"></span>
    <span class="muted">{events.length} event{events.length === 1 ? '' : 's'} (max {MAX_ROWS})</span>
  </div>

  {#if notice}<div class="notice">{notice}</div>{/if}
  {#if error}
    <ErrorBox {error} />
    <p class="muted">
      A stream error can mean the table has no event capture enabled (use “Enable capture”),
      or the server predates Milestone&nbsp;20.
    </p>
  {/if}

  {#if events.length}
    <div class="stream">
      {#each events as e (e.seq)}
        <div class="evt">
          <span class="seq">#{e.seq}</span>
          <span class="op {opClass(e.op)}">{e.op}</span>
          <span class="tbl">{e.table_name}</span>
          <span class="xid" title="transaction id">xid {e.xid}</span>
          <code class="payload">{JSON.stringify(e.payload)}</code>
        </div>
      {/each}
    </div>
  {:else if !streaming}
    <p class="muted">
      Pick a table (or “all enabled”), then <strong>Start tail</strong> to watch committed
      INSERT/UPDATE/DELETE events live. Set <em>From seq</em> to replay from an earlier offset.
    </p>
  {:else}
    <p class="muted">Waiting for events…</p>
  {/if}
</div>

<style>
  .events {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .toolbar h3 {
    margin: 0 0 8px;
    font-size: 15px;
  }
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
  .controls input,
  .controls select {
    padding: 5px 7px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--panel);
    color: var(--text);
    font-size: 13px;
  }
  .controls input { width: 110px; }
  button.primary {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 5px;
    padding: 7px 14px;
    cursor: pointer;
    font-size: 13px;
  }
  button.stop {
    background: var(--err-fg);
    color: #fff;
    border: none;
    border-radius: 5px;
    padding: 7px 14px;
    cursor: pointer;
    font-size: 13px;
  }
  button.ghost {
    background: var(--panel-alt);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 7px 12px;
    cursor: pointer;
    font-size: 13px;
  }
  button.ghost:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button.link {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-size: 12px;
    padding: 0;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text);
  }
  .spacer { flex: 1; }
  .muted { color: var(--muted); font-size: 13px; }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
    display: inline-block;
  }
  .dot.on {
    background: #22c55e;
    box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.2);
  }
  .notice {
    font-size: 13px;
    color: var(--text);
    background: var(--panel-alt);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 12px;
  }
  .stream {
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
    font-family: var(--mono);
    font-size: 12.5px;
  }
  .evt {
    display: flex;
    gap: 10px;
    align-items: baseline;
    padding: 5px 10px;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  .evt:hover { background: var(--panel-alt); }
  .seq {
    flex: 0 0 auto;
    color: var(--muted);
  }
  .op {
    flex: 0 0 58px;
    font-weight: 700;
    text-transform: uppercase;
    font-size: 11px;
  }
  .op-insert { color: #16a34a; }
  .op-update { color: #d99922; }
  .op-delete { color: var(--err-fg); }
  .tbl {
    flex: 0 0 auto;
    color: var(--accent);
  }
  .xid {
    flex: 0 0 auto;
    color: var(--muted);
    font-size: 11px;
  }
  .payload {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text);
  }
</style>
