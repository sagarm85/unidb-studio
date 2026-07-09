<script>
  import { columnSummary } from './format.js';

  // Presentational: App owns the fetch and passes state in.
  let { tables = [], loading = false, error = null, supported = true, selected = null, onSelect, onRefresh } = $props();
</script>

<aside class="sidebar">
  <div class="head">
    <h2>database</h2>
    <button class="refresh" onclick={() => onRefresh?.()} disabled={loading} title="Reload tables">↻</button>
  </div>

  {#if loading}
    <p class="muted">Loading tables…</p>
  {:else if error}
    <p class="err">{error.code}: {error.message}</p>
  {:else if !supported}
    <p class="muted">
      GET /tables not available on this server yet. Use the SQL editor to query directly.
    </p>
  {:else if tables.length === 0}
    <p class="muted">No tables. Create one in the SQL editor.</p>
  {:else}
    <ul>
      {#each tables as t}
        <li>
          <button class="table" class:active={selected === t.name} onclick={() => onSelect?.(t)}>
            <span class="name">{t.name}</span>
            <span class="cols">{columnSummary(t.columns)}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</aside>

<style>
  .sidebar {
    width: 240px;
    flex-shrink: 0;
    border-right: 1px solid var(--border);
    padding: 14px 12px;
    overflow-y: auto;
    background: var(--panel-alt);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  h2 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    margin: 0;
  }
  .refresh {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 15px;
    padding: 0 4px;
  }
  .refresh:hover {
    color: var(--text);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .table {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-radius: 6px;
    padding: 7px 9px;
    cursor: pointer;
    color: var(--text);
  }
  .table:hover {
    background: var(--panel);
  }
  .table.active {
    background: var(--accent);
    color: #fff;
  }
  .name {
    font-weight: 600;
    font-size: 13px;
  }
  .cols {
    font-size: 11px;
    color: var(--muted);
    font-family: var(--mono);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .table.active .cols {
    color: rgba(255, 255, 255, 0.8);
  }
  .muted {
    color: var(--muted);
    font-size: 12px;
  }
  .err {
    color: var(--err-fg);
    font-size: 12px;
  }
</style>
