<script>
  import { streaming, events, lastSeq, streamErr, startStream, stopStream, clearEvents } from './eventStore.js';
  import { enableTableEvents, runSql } from './api.js';
  import ErrorBox from './ErrorBox.svelte';

  let { tables = [] } = $props();

  let table    = $state('');
  let fromSeq  = $state('');
  let enabling = $state(false);
  let notice   = $state(null);

  // Consumer offset polling
  let consumers     = $state([]);
  let consumerTimer = null;

  async function pollConsumers() {
    try {
      const res = await runSql('SELECT * FROM __consumers__ ORDER BY consumer_name');
      // Deduplicate by name (no UNIQUE constraint on the system table) — keep max offset per consumer
      const map = new Map();
      for (const [name, offset] of (res.results?.[0]?.rows ?? [])) {
        if (!map.has(name) || offset > map.get(name)) map.set(name, offset);
      }
      consumers = [...map.entries()].map(([name, offset]) => ({ name, offset }));
    } catch { /* silently ignore */ }
  }

  $effect(() => {
    pollConsumers();
    consumerTimer = setInterval(pollConsumers, 2000);
    return () => clearInterval(consumerTimer);
  });

  function start() {
    startStream({ table, fromSeq });
  }

  function stop() {
    stopStream();
  }

  function resumeFromLast() {
    const seq = $lastSeq;
    if (seq != null) fromSeq = String(seq);
    startStream({ table, fromSeq });
  }

  async function enable() {
    if (!table) return;
    enabling = true;
    notice   = null;
    try {
      await enableTableEvents(table);
      notice = `Event capture enabled on "${table}".`;
    } catch (e) {
      // streamErr is for stream errors; use local notice for enable errors
      notice = `Error: ${e.message}`;
    } finally {
      enabling = false;
    }
  }

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
      <button class="ghost" onclick={enable} disabled={!table || enabling}>
        {enabling ? 'Enabling…' : 'Enable capture'}
      </button>
      <button class="link" onclick={clearEvents} disabled={!$events.length}>Clear</button>
    </div>
  </div>

  <div class="status">
    <span class="dot" class:on={$streaming}></span>
    {#if $streaming}
      Live{table ? ` · ${table}` : ''}{$lastSeq != null ? ` · seq ${$lastSeq}` : ''}
    {:else}
      Stopped
      {#if $lastSeq != null}
        · <button class="link" onclick={resumeFromLast}>resume after seq {$lastSeq} →</button>
      {/if}
    {/if}
    <span class="spacer"></span>
    <span class="muted">{$events.length} event{$events.length === 1 ? '' : 's'} (max 500)</span>
  </div>

  {#if notice}<div class="notice">{notice}</div>{/if}
  {#if $streamErr}
    <ErrorBox error={$streamErr} />
    <p class="muted">
      A stream error can mean the table has no event capture enabled (use "Enable capture"),
      or the server predates Milestone&nbsp;20.
    </p>
  {/if}

  <!-- Consumer offsets -->
  {#if consumers.length > 0}
    <section class="consumers">
      <span class="consumers-label">Consumer offsets</span>
      {#each consumers as c}
        <span class="consumer-chip">
          <span class="consumer-name">{c.name}</span>
          <span class="consumer-offset">seq {c.offset}</span>
        </span>
      {/each}
    </section>
  {/if}

  {#if $events.length}
    <div class="stream">
      {#each $events as e (e.seq)}
        <div class="evt">
          <span class="seq">#{e.seq}</span>
          <span class="op {opClass(e.op)}">{e.op}</span>
          <span class="tbl">{e.table_name}</span>
          <span class="xid" title="transaction id">xid {e.xid}</span>
          <code class="payload">{JSON.stringify(e.payload)}</code>
        </div>
      {/each}
    </div>
  {:else if !$streaming}
    <p class="muted">
      Pick a table (or "all enabled"), then <strong>Start tail</strong> to watch committed
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
  button.ghost:disabled { opacity: 0.5; cursor: default; }
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
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--muted);
    display: inline-block;
  }
  .dot.on {
    background: #22c55e;
    box-shadow: 0 0 0 3px rgba(34,197,94,.2);
  }
  .notice {
    font-size: 13px;
    background: var(--panel-alt);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 12px;
  }

  /* Consumer offsets bar */
  .consumers {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 7px 10px;
    background: var(--panel-alt);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 12px;
  }
  .consumers-label {
    color: var(--muted);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: .05em;
    font-weight: 600;
    margin-right: 4px;
  }
  .consumer-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 2px 8px;
  }
  .consumer-name { font-family: var(--mono); color: var(--accent); }
  .consumer-offset { color: var(--muted); font-family: var(--mono); }

  /* Event stream */
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
  .seq { flex: 0 0 auto; color: var(--muted); }
  .op {
    flex: 0 0 58px;
    font-weight: 700;
    text-transform: uppercase;
    font-size: 11px;
  }
  .op-insert { color: #16a34a; }
  .op-update { color: #d99922; }
  .op-delete { color: var(--err-fg); }
  .tbl  { flex: 0 0 auto; color: var(--accent); }
  .xid  { flex: 0 0 auto; color: var(--muted); font-size: 11px; }
  .payload {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text);
  }
</style>
