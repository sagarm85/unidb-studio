<script>
  import { runSql } from './api.js';
  import { quoteIdent } from './format.js';
  import ResultsGrid from './ResultsGrid.svelte';
  import ErrorBox from './ErrorBox.svelte';

  let { table } = $props();

  const PAGE = 50;

  let loading = $state(false);
  let error = $state(null);
  let result = $state(null); // last { type: 'rows', rows }
  let page = $state(0); // 0-based page index
  let atEnd = $state(false); // last fetch returned < PAGE rows
  let roundTripMs = $state(null);

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

  async function fetchPage(direction) {
    if (!table) return;
    loading = true;
    error = null;

    const t = quoteIdent(table.name);
    let sql;
    let params = [];

    if (mode === 'keyset') {
      const k = quoteIdent(keyCol);
      if (direction === 'next' && lastKey != null) {
        sql = `SELECT * FROM ${t} WHERE ${k} > $1 ORDER BY ${k} LIMIT ${PAGE}`;
        params = [lastKey];
      } else {
        sql = `SELECT * FROM ${t} ORDER BY ${k} LIMIT ${PAGE}`;
      }
    } else {
      // Fallback: no obvious key -> LIMIT/OFFSET, ordered by the first column
      // ordinal for stable-ish paging.
      const nextPage = direction === 'next' ? page + 1 : 0;
      sql = `SELECT * FROM ${t} ORDER BY 1 LIMIT ${PAGE} OFFSET ${nextPage * PAGE}`;
    }

    try {
      const out = await runSql(sql, params);
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

  // Reload from the top whenever the selected table changes.
  $effect(() => {
    if (table) {
      page = 0;
      lastKey = null;
      atEnd = false;
      result = null;
      fetchPage('first');
    }
  });

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
</style>
