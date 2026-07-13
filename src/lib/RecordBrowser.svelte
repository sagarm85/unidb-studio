<script>
  import { untrack } from 'svelte';
  import { runSql } from './api.js';
  import { quoteIdent } from './format.js';
  import ResultsGrid from './ResultsGrid.svelte';
  import ErrorBox from './ErrorBox.svelte';

  let { table } = $props();

  const PAGE = 50;

  // Supabase-style filter operators. `valueless` ops (IS NULL / IS NOT NULL)
  // and `pattern` ops (LIKE, wrapped client-side) don't bind a raw value 1:1.
  const OPERATORS = [
    { id: 'eq', label: '=', sql: '=' },
    { id: 'neq', label: '≠', sql: '!=' },
    { id: 'gt', label: '>', sql: '>' },
    { id: 'gte', label: '≥', sql: '>=' },
    { id: 'lt', label: '<', sql: '<' },
    { id: 'lte', label: '≤', sql: '<=' },
    { id: 'contains', label: 'contains', sql: 'LIKE', wrap: (v) => `%${v}%` },
    { id: 'starts', label: 'starts with', sql: 'LIKE', wrap: (v) => `${v}%` },
    { id: 'ends', label: 'ends with', sql: 'LIKE', wrap: (v) => `%${v}` },
    { id: 'isnull', label: 'is null', valueless: true },
    { id: 'notnull', label: 'is not null', valueless: true },
  ];
  const opById = (id) => OPERATORS.find((o) => o.id === id);

  let loading = $state(false);
  let error = $state(null);
  let result = $state(null); // last { type: 'rows', rows }
  let page = $state(0); // 0-based page index
  let atEnd = $state(false); // last fetch returned < PAGE rows
  let roundTripMs = $state(null);

  // Draft filters (being edited) vs. the applied set that shapes the query.
  let draftFilters = $state([]); // [{ column, op, value }]
  let appliedFilters = $state([]);

  const colNames = $derived((table?.columns ?? []).map((c) => c.name));

  // "Obvious key" for keyset paging: an indexed column, else a column named
  // "id". If neither, we page with LIMIT/OFFSET instead (the fallback).
  const keyCol = $derived.by(() => {
    const cols = table?.columns ?? [];
    return cols.find((c) => c.index)?.name ?? cols.find((c) => c.name.toLowerCase() === 'id')?.name ?? null;
  });
  const keyIndex = $derived(keyCol ? colNames.indexOf(keyCol) : -1);
  const mode = $derived(keyCol ? 'keyset' : 'offset');

  let lastKey = $state(null); // last seen key value (keyset mode)

  // Turn applied filters into WHERE conditions + positional params, numbering
  // placeholders from `start` so the keyset condition can append after them.
  function buildFilterClauses(start) {
    const conds = [];
    const params = [];
    let n = start;
    for (const f of appliedFilters) {
      if (!f.column) continue;
      const op = opById(f.op);
      const col = quoteIdent(f.column);
      if (op.valueless) {
        conds.push(`${col} ${op.id === 'isnull' ? 'IS NULL' : 'IS NOT NULL'}`);
        continue;
      }
      conds.push(`${col} ${op.sql} $${n}`);
      params.push(op.wrap ? op.wrap(f.value) : f.value);
      n += 1;
    }
    return { conds, params };
  }

  async function fetchPage(direction) {
    if (!table) return;
    loading = true;
    error = null;

    const t = quoteIdent(table.name);
    // Filter placeholders come first ($1..$k); keyset's boundary is $(k+1).
    const { conds, params } = buildFilterClauses(1);
    let sql;

    if (mode === 'keyset') {
      const k = quoteIdent(keyCol);
      const where = [...conds];
      if (direction === 'next' && lastKey != null) {
        where.push(`${k} > $${params.length + 1}`);
        params.push(lastKey);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      sql = `SELECT * FROM ${t} ${whereSql} ORDER BY ${k} LIMIT ${PAGE}`;
    } else {
      // Fallback: no obvious key -> LIMIT/OFFSET, ordered by the first column
      // ordinal for stable-ish paging.
      const nextPage = direction === 'next' ? page + 1 : 0;
      const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      sql = `SELECT * FROM ${t} ${whereSql} ORDER BY 1 LIMIT ${PAGE} OFFSET ${nextPage * PAGE}`;
    }

    try {
      const out = await runSql(sql.replace(/\s+/g, ' ').trim(), params);
      roundTripMs = out.roundTripMs;
      const r = out.results.find((x) => x.type === 'rows') ?? { type: 'rows', rows: [] };
      result = r;
      const rows = r.rows ?? [];
      atEnd = rows.length < PAGE;

      if (direction === 'next') page += 1;
      else page = 0;

      if (mode === 'keyset' && rows.length) {
        lastKey = rows[rows.length - 1][keyIndex];
      }
    } catch (e) {
      error = { code: e.code, message: e.message, status: e.status };
    } finally {
      loading = false;
    }
  }

  function resetPaging() {
    page = 0;
    lastKey = null;
    atEnd = false;
  }

  // Reload from the top whenever the selected table changes; drop stale filters.
  // `untrack` the body so this effect depends ONLY on `table` — fetchPage reads
  // appliedFilters/page/etc. synchronously, and we reset those here, so tracking
  // them would create a write→read→rerun loop.
  $effect(() => {
    const t = table;
    untrack(() => {
      if (!t) return;
      draftFilters = [];
      appliedFilters = [];
      resetPaging();
      result = null;
      fetchPage('first');
    });
  });

  function addFilter() {
    draftFilters = [...draftFilters, { column: colNames[0] ?? '', op: 'eq', value: '' }];
  }
  function removeFilter(i) {
    draftFilters = draftFilters.filter((_, idx) => idx !== i);
  }
  function applyFilters() {
    // Keep only complete filters (a column, and a value unless valueless).
    appliedFilters = draftFilters.filter((f) => f.column && (opById(f.op).valueless || f.value !== ''));
    resetPaging();
    fetchPage('first');
  }
  function clearFilters() {
    draftFilters = [];
    appliedFilters = [];
    resetPaging();
    fetchPage('first');
  }

  // Supabase-style filter search: a single box that suggests the table's
  // columns; picking one opens a filter for it.
  let colQuery = $state('');
  let showColMenu = $state(false);
  const colMatches = $derived.by(() => {
    const q = colQuery.trim().toLowerCase();
    return q ? colNames.filter((c) => c.toLowerCase().includes(q)) : colNames;
  });
  const searchPlaceholder = $derived(
    colNames.length
      ? `Filter by ${colNames.slice(0, 3).join(', ')}${colNames.length > 3 ? '…' : ''}`
      : 'Filter…',
  );

  function pickColumn(c) {
    draftFilters = [...draftFilters, { column: c, op: 'eq', value: '' }];
    colQuery = '';
    showColMenu = false;
  }
  function onSearchKey(e) {
    if (e.key === 'Enter') {
      if (showColMenu && colQuery.trim() && colMatches.length) pickColumn(colMatches[0]);
      else applyFilters();
    } else if (e.key === 'Escape') {
      showColMenu = false;
    }
  }

  const activeCount = $derived(appliedFilters.length);
  const fmt = (ms) => (ms == null ? '' : `${ms.toFixed(2)} ms`);
</script>

<div class="browser">
  <div class="bar">
    <div class="meta">
      <strong>{table?.name}</strong>
      <span class="mode">{mode === 'keyset' ? `keyset on ${keyCol}` : 'LIMIT/OFFSET (no key)'}</span>
    </div>
    <div class="pager">
      {#if roundTripMs != null}<span class="rt">round-trip: {fmt(roundTripMs)}</span>{/if}
      <span class="pageno">page {page + 1}</span>
      <button onclick={() => fetchPage('first')} disabled={loading || page === 0}>First</button>
      <button onclick={() => fetchPage('next')} disabled={loading || atEnd}>Next →</button>
    </div>
  </div>

  <div class="searchbar">
    <span class="mag" aria-hidden="true">⌕</span>
    <input
      type="text"
      placeholder={searchPlaceholder}
      bind:value={colQuery}
      onfocus={() => (showColMenu = true)}
      onblur={() => setTimeout(() => (showColMenu = false), 120)}
      onkeydown={onSearchKey}
      aria-label="Filter by column"
    />
    {#if activeCount > 0}<span class="active-chip">{activeCount} active</span>{/if}
    {#if showColMenu && colMatches.length}
      <ul class="colmenu">
        {#each colMatches as c}
          <li>
            <!-- mousedown fires before the input's blur, so the pick lands -->
            <button onmousedown={(e) => { e.preventDefault(); pickColumn(c); }}>{c}</button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  {#if draftFilters.length > 0}
    <div class="filters">
      {#each draftFilters as f, i}
        <div class="filter-row">
          <span class="conj">{i === 0 ? 'WHERE' : 'AND'}</span>
          <select bind:value={f.column}>
            {#each colNames as c}<option value={c}>{c}</option>{/each}
          </select>
          <select bind:value={f.op}>
            {#each OPERATORS as o}<option value={o.id}>{o.label}</option>{/each}
          </select>
          {#if !opById(f.op).valueless}
            <input
              type="text"
              placeholder="value"
              bind:value={f.value}
              onkeydown={(e) => e.key === 'Enter' && applyFilters()}
            />
          {:else}
            <span class="spacer"></span>
          {/if}
          <button class="icon" title="Remove filter" onclick={() => removeFilter(i)}>✕</button>
        </div>
      {/each}
      <div class="filter-actions">
        <button class="ghost" onclick={addFilter}>+ Add filter</button>
        <span class="grow"></span>
        {#if activeCount > 0 || draftFilters.length > 0}
          <button class="ghost" onclick={clearFilters}>Clear</button>
        {/if}
        <button onclick={applyFilters} disabled={loading}>Apply</button>
      </div>
    </div>
  {/if}

  {#if error}
    <ErrorBox {error} />
  {:else if loading && !result}
    <p class="muted">Loading…</p>
  {:else if result}
    <ResultsGrid {result} columns={colNames} />
    {#if atEnd}<p class="muted end">End of table.</p>{/if}
  {/if}
</div>

<style>
  .browser {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .meta {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .meta strong {
    font-size: 15px;
  }
  .mode {
    font-size: 11px;
    color: var(--muted);
    font-family: var(--mono);
  }
  .pager {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .rt {
    font-size: 11px;
    color: var(--muted);
    font-family: var(--mono);
  }
  .pageno {
    font-size: 12px;
    color: var(--muted);
  }
  .muted {
    color: var(--muted);
    font-size: 12px;
  }
  .end {
    margin-top: 4px;
  }

  /* ghost/icon buttons override the accent-filled default from app.css
     (which targets `.browser button`). */
  .browser button.ghost,
  .browser button.icon {
    background: none;
    color: var(--text);
    border: 1px solid var(--border);
    font-weight: 500;
  }
  .browser button.icon {
    border: none;
    color: var(--muted);
    padding: 2px 6px;
  }
  .browser button.icon:hover {
    color: var(--err-fg);
  }

  /* Supabase-style filter search bar with a column-suggestion dropdown. */
  .searchbar {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel);
  }
  .searchbar:focus-within {
    border-color: var(--accent);
  }
  .mag {
    color: var(--muted);
    font-size: 16px;
    line-height: 1;
  }
  .searchbar input {
    flex: 1;
    border: none;
    background: none;
    outline: none;
    font-family: inherit;
    font-size: 13px;
    color: var(--text);
  }
  .active-chip {
    font-size: 11px;
    color: var(--accent);
    background: rgba(37, 99, 235, 0.12);
    border-radius: 10px;
    padding: 2px 8px;
    white-space: nowrap;
  }
  .colmenu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 10;
    min-width: 220px;
    max-height: 260px;
    overflow: auto;
    list-style: none;
    margin: 0;
    padding: 4px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
  }
  .colmenu button {
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    padding: 7px 10px;
    font-size: 13px;
    font-family: var(--mono);
    color: var(--text);
    border-radius: 6px;
    cursor: pointer;
  }
  .colmenu button:hover {
    background: var(--panel-alt);
  }

  .filters {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    background: var(--panel-alt);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .filter-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .conj {
    width: 48px;
    font-size: 11px;
    font-family: var(--mono);
    color: var(--muted);
    text-align: right;
  }
  .filter-row select,
  .filter-row input {
    padding: 5px 8px;
    font-size: 12px;
    font-family: inherit;
    color: var(--text);
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .filter-row select:focus,
  .filter-row input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .filter-row input {
    flex: 1;
    min-width: 80px;
  }
  .spacer {
    flex: 1;
  }
  .filter-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .grow {
    flex: 1;
  }
</style>
