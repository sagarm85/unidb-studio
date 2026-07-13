<script>
  import { columnSummary } from './format.js';
  import CollapsibleSection from './CollapsibleSection.svelte';

  // Presentational: App owns the fetch and passes state in. DDL callbacks
  // (New table / Manage) are only offered when `canDDL` (a live catalog).
  let {
    tables = [],
    loading = false,
    error = null,
    supported = true,
    selected = null,
    canDDL = false,
    onSelect,
    onRefresh,
    onNewTable,
    onManageTable,
  } = $props();

  // Client-side table search (Supabase-style). Name matches win: typing "user"
  // shows the `users` table, not every table with a `user_id` column. Only when
  // NO table name matches do we fall back to column-name matches, so you can
  // still find "the table with `email`".
  let query = $state('');

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tables;
    const byName = tables.filter((t) => t.name.toLowerCase().includes(q));
    if (byName.length) return byName;
    return tables.filter((t) => (t.columns ?? []).some((c) => c.name.toLowerCase().includes(q)));
  });
</script>

<aside class="sidebar">
  <CollapsibleSection title="database">
    {#snippet action()}
      <button class="refresh" onclick={() => onRefresh?.()} disabled={loading} title="Reload tables">↻</button>
    {/snippet}

    {#if canDDL}
      <button class="newtable" onclick={() => onNewTable?.()}>+ New table</button>
    {/if}

    {#if supported && tables.length > 0}
      <div class="search">
        <input
          type="search"
          placeholder="Search tables…"
          bind:value={query}
          aria-label="Search tables"
        />
      </div>
    {/if}

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
    {:else if filtered.length === 0}
      <p class="muted">No tables match “{query}”.</p>
    {:else}
      <ul>
        {#each filtered as t}
          <li class="trow" class:active={selected === t.name}>
            <button class="table" class:active={selected === t.name} onclick={() => onSelect?.(t)}>
              <span class="name">{t.name}</span>
              <span class="cols">{columnSummary(t.columns)}</span>
            </button>
            {#if canDDL}
              <button class="manage" title="Manage table" aria-label="Manage {t.name}" onclick={() => onManageTable?.(t)}>⋮</button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </CollapsibleSection>
</aside>

<style>
  .sidebar {
    width: 240px;
    flex-shrink: 0;
    border-right: 1px solid var(--border);
    padding: 6px 12px;
    overflow-y: auto;
    background: var(--panel-alt);
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
  .newtable {
    width: 100%;
    margin-bottom: 8px;
    padding: 6px 9px;
    font-size: 12px;
    font-weight: 600;
    color: var(--accent);
    background: none;
    border: 1px dashed var(--border);
    border-radius: 6px;
    cursor: pointer;
  }
  .newtable:hover {
    border-color: var(--accent);
    background: var(--panel);
  }
  .trow {
    display: flex;
    align-items: stretch;
    border-radius: 6px;
  }
  .trow .manage {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 15px;
    padding: 0 6px;
    opacity: 0;
  }
  .trow:hover .manage,
  .trow.active .manage {
    opacity: 1;
  }
  .trow .manage:hover {
    color: var(--text);
  }
  .trow.active .manage {
    color: #fff;
  }
  .search {
    margin-bottom: 10px;
  }
  .search input {
    width: 100%;
    box-sizing: border-box;
    padding: 6px 9px;
    font-size: 12px;
    font-family: inherit;
    color: var(--text);
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .search input:focus {
    outline: none;
    border-color: var(--accent);
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
    flex: 1;
    min-width: 0;
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
