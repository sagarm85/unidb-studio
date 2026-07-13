<script>
  // Logs tab (item 22). Filtered, cursor-paged, newest-first tail over the
  // server's rotated JSON log files via GET /logs. Superuser-gated on the
  // server — a non-superuser token gets 403, which we surface plainly.
  import { getLogs } from './api.js';
  import ErrorBox from './ErrorBox.svelte';

  const LEVELS = ['', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];

  let level = $state('');
  let since = $state('');
  let until = $state('');
  let q = $state('');
  let limit = $state(100);

  let logs = $state([]);
  let cursor = $state(null); // next_cursor for "load more"
  let scanned = $state(0);
  let truncated = $state(false);
  let supported = $state(true);
  let error = $state(null);
  let loading = $state(false);
  let expanded = $state(new Set()); // indices with the raw JSON open

  // Fetch the first page for the current filters. `append: false` resets.
  async function search({ append = false } = {}) {
    loading = true;
    error = null;
    try {
      const out = await getLogs({
        level: level || undefined,
        since: since || undefined,
        until: until || undefined,
        q: q || undefined,
        limit,
        cursor: append ? cursor : undefined,
      });
      supported = out.supported;
      if (!out.supported) {
        logs = [];
        return;
      }
      logs = append ? [...logs, ...out.logs] : out.logs;
      cursor = out.next_cursor;
      scanned = out.scanned;
      truncated = out.truncated;
      if (!append) expanded = new Set();
    } catch (e) {
      error = { code: e.code, message: e.message, status: e.status };
    } finally {
      loading = false;
    }
  }

  function toggle(i) {
    const next = new Set(expanded);
    next.has(i) ? next.delete(i) : next.add(i);
    expanded = next;
  }

  function levelClass(l) {
    const u = String(l ?? '').toUpperCase();
    if (u === 'ERROR') return 'lvl-error';
    if (u === 'WARN') return 'lvl-warn';
    if (u === 'DEBUG' || u === 'TRACE') return 'lvl-dim';
    return 'lvl-info';
  }

  // A log line is the parsed JSON object (or {raw:"..."} for a non-JSON line).
  // Pull the well-known fields; everything else shows in the expanded view.
  const KNOWN = new Set(['timestamp', 'level', 'request_id', 'message', 'msg', 'target']);
  function message(row) {
    return row.message ?? row.msg ?? row.raw ?? '';
  }
  function extras(row) {
    return Object.fromEntries(Object.entries(row).filter(([k]) => !KNOWN.has(k)));
  }
</script>

<div class="logs">
  <div class="toolbar">
    <h3>Logs</h3>
    <div class="filters">
      <label>
        Level
        <select bind:value={level}>
          {#each LEVELS as l}
            <option value={l}>{l || 'any'}</option>
          {/each}
        </select>
      </label>
      <label class="grow">
        Contains
        <input type="text" placeholder="substring / request_id" bind:value={q}
          onkeydown={(e) => e.key === 'Enter' && search()} />
      </label>
      <label>
        Since
        <input type="text" placeholder="RFC3339 UTC" bind:value={since} />
      </label>
      <label>
        Until
        <input type="text" placeholder="RFC3339 UTC" bind:value={until} />
      </label>
      <label>
        Limit
        <input type="number" min="1" max="500" bind:value={limit} />
      </label>
      <button class="primary" onclick={() => search()} disabled={loading}>
        {loading ? 'Searching…' : 'Search'}
      </button>
    </div>
  </div>

  {#if error}
    <ErrorBox {error} />
    {#if error.status === 403}
      <p class="muted">The <code>/logs</code> endpoint is superuser-gated — use a token whose user is a superuser.</p>
    {/if}
  {/if}

  {#if !supported}
    <p class="muted">
      This server doesn't expose <code>GET /logs</code>. Rebuild <code>unidb-server</code> from a
      build that includes item&nbsp;22 (logs surface).
    </p>
  {:else if logs.length}
    <div class="meta">
      {logs.length} shown · {scanned.toLocaleString()} scanned{truncated ? ' · scan budget hit (more behind cursor)' : ''}
    </div>
    <div class="lines">
      {#each logs as row, i}
        <div
          class="line"
          role="button"
          tabindex="0"
          onclick={() => toggle(i)}
          onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle(i))}
        >
          <span class="lvl {levelClass(row.level)}">{(row.level ?? '·').toUpperCase()}</span>
          <span class="ts">{row.timestamp ?? ''}</span>
          {#if row.request_id}<span class="rid" title="request_id">{row.request_id}</span>{/if}
          <span class="msg">{message(row)}</span>
        </div>
        {#if expanded.has(i)}
          <pre class="detail">{JSON.stringify(row, null, 2)}</pre>
        {/if}
      {/each}
    </div>
    {#if cursor}
      <button class="link more" onclick={() => search({ append: true })} disabled={loading}>
        Load older →
      </button>
    {:else}
      <p class="muted end">End of results.</p>
    {/if}
  {:else if !loading}
    <p class="muted">No log lines. Adjust filters and Search — results are newest-first.</p>
  {/if}
</div>

<style>
  .logs {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .toolbar h3 {
    margin: 0 0 8px;
    font-size: 15px;
  }
  .filters {
    display: flex;
    gap: 10px;
    align-items: flex-end;
    flex-wrap: wrap;
  }
  .filters label {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 11px;
    color: var(--muted);
  }
  .filters .grow {
    flex: 1;
    min-width: 180px;
  }
  .filters input,
  .filters select {
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
  }
  button.primary:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .meta {
    font-size: 12px;
    color: var(--muted);
  }
  .muted {
    color: var(--muted);
    font-size: 13px;
  }
  .lines {
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
    font-family: var(--mono);
    font-size: 12.5px;
  }
  .line {
    display: flex;
    gap: 10px;
    align-items: baseline;
    padding: 4px 10px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
  }
  .line:hover {
    background: var(--panel-alt);
  }
  .lvl {
    flex: 0 0 48px;
    font-weight: 700;
    font-size: 11px;
  }
  .lvl-error { color: var(--err-fg); }
  .lvl-warn { color: #d99922; }
  .lvl-info { color: var(--accent); }
  .lvl-dim { color: var(--muted); }
  .ts {
    flex: 0 0 auto;
    color: var(--muted);
  }
  .rid {
    flex: 0 0 auto;
    color: var(--accent);
    opacity: 0.85;
  }
  .msg {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text);
  }
  .detail {
    margin: 0;
    padding: 8px 12px;
    background: var(--panel-alt);
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    overflow-x: auto;
  }
  button.link {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-size: 13px;
    padding: 4px 0;
  }
  .more {
    align-self: flex-start;
  }
  .end {
    text-align: center;
  }
</style>
