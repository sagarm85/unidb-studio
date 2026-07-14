<script>
  import { untrack } from 'svelte';
  import { runSql } from './api.js';
  import { quoteIdent, isVectorType, bindForColumn } from './format.js';
  import ResultsGrid from './ResultsGrid.svelte';
  import ErrorBox from './ErrorBox.svelte';

  // `editable` gates row mutations (needs a primary key to target a row).
  // `relationships` are catalog FKs (for header badges). `onChanged` reloads the
  // shared catalog after an insert/update/delete/DDL.
  let { table, relationships = [], editable = false, onChanged = null } = $props();

  const PAGE = 50;

  // Filter operators the engine actually supports. `valueless` ops (IS NULL /
  // IS NOT NULL) bind no value. NOTE: unidb has no `LIKE` — substring/pattern
  // matching is out (its text search is the FULLTEXT index, not `LIKE`), so
  // contains/starts-with/ends-with are deliberately absent rather than emitting
  // a query the engine rejects with SQL_UNSUPPORTED.
  const OPERATORS = [
    { id: 'eq', label: '=', sql: '=' },
    { id: 'neq', label: '≠', sql: '!=' },
    { id: 'gt', label: '>', sql: '>' },
    { id: 'gte', label: '≥', sql: '>=' },
    { id: 'lt', label: '<', sql: '<' },
    { id: 'lte', label: '≤', sql: '<=' },
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
  let totalCount = $state(null); // COUNT(*) under the active filters (null = unknown)

  // Draft filters (being edited) vs. the applied set that shapes the query.
  let draftFilters = $state([]); // [{ column, op, value }]
  let appliedFilters = $state([]);

  const colNames = $derived((table?.columns ?? []).map((c) => c.name));
  const colTypes = $derived((table?.columns ?? []).map((c) => c.type ?? null));
  // name -> { type, nullable, default } for value coercion on edit/insert.
  const columnMeta = $derived(
    new Map((table?.columns ?? []).map((c) => [c.name, { type: c.type, nullable: c.nullable !== false, default: c.default ?? null }])),
  );

  // Vector support: the first VECTOR(n) column, and whether it carries the
  // durable ANN index NEAR() needs. "Find similar" is only offered when indexed.
  const vectorCol = $derived((table?.columns ?? []).find((c) => isVectorType(c.type)) ?? null);
  const vectorIndexed = $derived(!!vectorCol && vectorCol.index === 'hnsw');
  const vectorIndex = $derived(vectorCol ? colNames.indexOf(vectorCol.name) : -1);

  // Real primary key from the catalog (single-column PK is the keyset key).
  const pkCols = $derived(
    Array.isArray(table?.primaryKey) ? table.primaryKey : [],
  );
  // Row editing needs a single-column PK to target a row uniquely.
  const canEdit = $derived(editable && pkCols.length === 1);

  // "Obvious key" for keyset paging: the real PK, else an indexed column, else a
  // column named "id". If none, we page with LIMIT/OFFSET (the fallback).
  const keyCol = $derived.by(() => {
    const cols = table?.columns ?? [];
    if (pkCols.length === 1) return pkCols[0];
    return cols.find((c) => c.index)?.name ?? cols.find((c) => c.name.toLowerCase() === 'id')?.name ?? null;
  });
  const keyIndex = $derived(keyCol ? colNames.indexOf(keyCol) : -1);
  const mode = $derived(keyCol ? 'keyset' : 'offset');

  // Sort (click a header). A custom sort forces offset paging (see fetchPage).
  let sortCol = $state(null);
  let sortDir = $state('asc'); // 'asc' | 'desc'
  const effectiveMode = $derived(sortCol ? 'offset' : mode);
  const sortState = $derived(sortCol ? { col: sortCol, dir: sortDir } : null);

  function handleSort(col) {
    if (sortCol !== col) {
      sortCol = col;
      sortDir = 'asc';
    } else if (sortDir === 'asc') {
      sortDir = 'desc';
    } else {
      sortCol = null; // cycle back to the natural (keyset) order
      sortDir = 'asc';
    }
    resetPaging();
    fetchPage('first');
  }

  // Per-column PK/FK flags for the grid header badges (parallel to colNames).
  const headerMeta = $derived(
    (table?.columns ?? []).map((c) => ({
      isPk: pkCols.includes(c.name),
      isFk: relationships.some((r) => r.fromTable === table?.name && r.fromColumns?.includes(c.name)),
    })),
  );

  let lastKey = $state(null); // last seen key value (keyset mode)

  // "Find similar" (vector NEAR) mode: overrides normal paging with a k-NN
  // ranked result set. `simFrom` labels the source row for the active chip.
  let simMode = $state(false);
  let simVector = $state(null); // number[] — the query vector
  let simFrom = $state(null); // display label of the source row
  let k = $state(5);

  // Turn applied filters into WHERE conditions + positional params, numbering
  // placeholders from `start` so the keyset condition can append after them.
  // `skipValueless` drops IS NULL / IS NOT NULL terms — the NEAR (vector) path
  // evaluates AND'd filters on the row engine, which supports comparisons but
  // not IS NULL, so composing them there would error (SQL_UNSUPPORTED).
  function buildFilterClauses(start, { skipValueless = false } = {}) {
    const conds = [];
    const params = [];
    let n = start;
    for (const f of appliedFilters) {
      if (!f.column) continue;
      const op = opById(f.op);
      const col = quoteIdent(f.column);
      if (op.valueless) {
        if (skipValueless) continue;
        conds.push(`${col} ${op.id === 'isnull' ? 'IS NULL' : 'IS NOT NULL'}`);
        continue;
      }
      conds.push(`${col} ${op.sql} $${n}`);
      const colType = columnMeta.get(f.column)?.type;
      try {
        const bind = bindForColumn(colType, f.value);
        params.push('literal' in bind ? f.value : bind.param);
      } catch {
        params.push(f.value);
      }
      n += 1;
    }
    return { conds, params };
  }

  // Applied IS NULL / IS NOT NULL filters that "Find similar" can't honor.
  const droppedInSimilar = $derived(
    appliedFilters.filter((f) => f.column && opById(f.op)?.valueless).length,
  );

  // Companion COUNT(*) under the same filters — cheap-enough context for the
  // pager. Non-fatal: a failure just leaves the count unknown.
  async function fetchCount() {
    if (!table) return;
    const t = quoteIdent(table.name);
    const { conds, params } = buildFilterClauses(1);
    const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    try {
      const out = await runSql(`SELECT COUNT(*) FROM ${t} ${whereSql}`.trim(), params);
      const r = out.results.find((x) => x.type === 'rows');
      const n = r?.rows?.[0]?.[0];
      totalCount = typeof n === 'number' ? n : Number(n);
      if (!Number.isFinite(totalCount)) totalCount = null;
    } catch {
      totalCount = null;
    }
  }

  async function fetchPage(direction) {
    if (!table) return;
    loading = true;
    error = null;

    const t = quoteIdent(table.name);
    // A custom sort can't keyset-page (keyset must order by its key), so it falls
    // back to LIMIT/OFFSET; otherwise keyset when we have a key, else offset.
    const usingSort = !!sortCol;
    const pagingMode = usingSort ? 'offset' : mode;
    const orderExpr = usingSort
      ? `${quoteIdent(sortCol)} ${sortDir === 'desc' ? 'DESC' : 'ASC'}`
      : mode === 'keyset'
        ? quoteIdent(keyCol)
        : '1';
    // Filter placeholders come first ($1..$k); keyset's boundary is $(k+1).
    const { conds, params } = buildFilterClauses(1);
    let sql;

    if (pagingMode === 'keyset') {
      const key = quoteIdent(keyCol);
      const where = [...conds];
      if (direction === 'next' && lastKey != null) {
        where.push(`${key} > $${params.length + 1}`);
        params.push(lastKey);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      sql = `SELECT * FROM ${t} ${whereSql} ORDER BY ${orderExpr} LIMIT ${PAGE}`;
    } else {
      const nextPage =
        direction === 'next' ? page + 1 : direction === 'prev' ? Math.max(0, page - 1) : 0;
      const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
      sql = `SELECT * FROM ${t} ${whereSql} ORDER BY ${orderExpr} LIMIT ${PAGE} OFFSET ${nextPage * PAGE}`;
    }

    try {
      const finalSql = sql.replace(/\s+/g, ' ').trim();
      lastSql = finalSql;
      lastParams = params;
      const out = await runSql(finalSql, params);
      roundTripMs = out.roundTripMs;
      const r = out.results.find((x) => x.type === 'rows') ?? { type: 'rows', rows: [] };
      result = r;
      const rows = r.rows ?? [];
      atEnd = rows.length < PAGE;

      if (direction === 'next') page += 1;
      else if (direction === 'prev') page = Math.max(0, page - 1);
      else page = 0;

      if (!sortCol && mode === 'keyset' && rows.length) {
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

  // ---- row mutations (Table Editor) --------------------------------------
  let lastSql = $state(null);
  let lastParams = $state([]);

  // Re-run the exact query behind the current view (after an insert/edit/delete)
  // so the grid reflects the change without jumping pages.
  async function reloadCurrent() {
    if (simMode) return runSimilar();
    if (!lastSql) return fetchPage('first');
    loading = true;
    try {
      const out = await runSql(lastSql, lastParams);
      roundTripMs = out.roundTripMs;
      const r = out.results.find((x) => x.type === 'rows') ?? { type: 'rows', rows: [] };
      result = r;
      atEnd = (r.rows ?? []).length < PAGE;
    } catch (e) {
      error = { code: e.code, message: e.message, status: e.status };
    } finally {
      loading = false;
    }
  }

  // Place a bound value into a mutation: a `$n` param, or an inline literal for
  // types the engine won't bind (DECIMAL). Mutates `params`; returns the SQL slot.
  function slot(bind, params) {
    if ('literal' in bind) return bind.literal;
    params.push(bind.param);
    return `$${params.length}`;
  }

  const pkCol = $derived(pkCols.length === 1 ? pkCols[0] : null);

  // Inline cell edit -> UPDATE <t> SET <col> = <v> WHERE <pk> = <pkval>.
  async function handleCellEdit(rowIndex, column, raw) {
    if (!canEdit || !pkCol) return;
    const rows = result?.rows ?? [];
    const row = rows[rowIndex];
    if (!row) return;
    const meta = columnMeta.get(column);
    const pkVal = row[colNames.indexOf(pkCol)];

    error = null;
    try {
      const params = [];
      const isNull = raw === '' && meta?.nullable;
      const setSlot = slot(bindForColumn(meta?.type, raw, isNull), params);
      const pkSlot = slot(bindForColumn(columnMeta.get(pkCol)?.type, String(pkVal)), params);
      const sql = `UPDATE ${quoteIdent(table.name)} SET ${quoteIdent(column)} = ${setSlot} WHERE ${quoteIdent(pkCol)} = ${pkSlot}`;
      await runSql(sql, params);
      await reloadCurrent();
    } catch (e) {
      error = { code: e.code ?? 'EDIT_ERROR', message: e.message, status: e.status ?? 0 };
    }
  }

  // Per-row delete — shows an in-app confirmation modal instead of window.confirm.
  let deleteConfirm = $state(null); // { row, pkVal } when pending

  function requestRowDelete(row) {
    if (!canEdit || !pkCol) return;
    deleteConfirm = { row, pkVal: row[colNames.indexOf(pkCol)] };
  }

  async function confirmRowDelete() {
    if (!deleteConfirm) return;
    const { row } = deleteConfirm;
    deleteConfirm = null;
    error = null;
    try {
      const params = [];
      const pkSlot = slot(bindForColumn(columnMeta.get(pkCol)?.type, String(row[colNames.indexOf(pkCol)])), params);
      await runSql(`DELETE FROM ${quoteIdent(table.name)} WHERE ${quoteIdent(pkCol)} = ${pkSlot}`, params);
      await reloadCurrent();
      fetchCount();
    } catch (e) {
      error = { code: e.code ?? 'DELETE_ERROR', message: e.message, status: e.status ?? 0 };
    }
  }

  // ---- insert-row form ---------------------------------------------------
  let showInsert = $state(false);
  let insertDraft = $state({}); // colName -> string
  let insertError = $state(null);

  function openInsert() {
    insertDraft = Object.fromEntries(colNames.map((c) => [c, '']));
    insertError = null;
    showInsert = true;
  }

  async function submitInsert() {
    insertError = null;
    const cols = [];
    const slots = [];
    const params = [];
    try {
      for (const name of colNames) {
        const raw = insertDraft[name] ?? '';
        const meta = columnMeta.get(name);
        if (raw === '') {
          // Empty: omit if the column has a default; NULL if nullable; else required.
          if (meta?.default != null) continue; // let the engine apply the default
          if (meta?.nullable) {
            cols.push(quoteIdent(name));
            slots.push(slot(bindForColumn(meta.type, '', true), params));
            continue;
          }
          throw new Error(`"${name}" is required`);
        }
        cols.push(quoteIdent(name));
        slots.push(slot(bindForColumn(meta?.type, raw), params));
      }
      if (!cols.length) throw new Error('nothing to insert');
      const sql = `INSERT INTO ${quoteIdent(table.name)} (${cols.join(', ')}) VALUES (${slots.join(', ')})`;
      await runSql(sql, params);
      showInsert = false;
      await reloadCurrent();
      fetchCount();
    } catch (e) {
      insertError = e.message;
    }
  }

  // ---- vector "Find similar" (NEAR) --------------------------------------
  // NEAR's query vector must be a numeric LITERAL (the parser rejects a bound
  // param there), so we interpolate the source row's own vector — trusted
  // numbers straight off the engine. Applied filters still compose as AND'd
  // params, and NEAR itself binds nothing.
  function vecLiteral(vec) {
    return `[${vec.filter((n) => Number.isFinite(n)).join(', ')}]`;
  }

  async function runSimilar() {
    if (!table || !vectorCol || !simVector) return;
    loading = true;
    error = null;

    const t = quoteIdent(table.name);
    const col = quoteIdent(vectorCol.name);
    const kk = Math.max(1, Math.floor(k) || 1);
    // IS NULL terms can't ride the NEAR row path — drop them (see buildFilterClauses).
    const { conds, params } = buildFilterClauses(1, { skipValueless: true });
    const where = [`NEAR(${col}, ${vecLiteral(simVector)}, ${kk})`, ...conds];
    const sql = `SELECT * FROM ${t} WHERE ${where.join(' AND ')}`;

    try {
      const out = await runSql(sql.replace(/\s+/g, ' ').trim(), params);
      roundTripMs = out.roundTripMs;
      result = out.results.find((x) => x.type === 'rows') ?? { type: 'rows', rows: [] };
      atEnd = true; // NEAR returns a single ranked set, no paging
    } catch (e) {
      error = { code: e.code, message: e.message, status: e.status };
    } finally {
      loading = false;
    }
  }

  function findSimilar(row, ri) {
    if (vectorIndex < 0) return;
    const vec = row[vectorIndex];
    if (!Array.isArray(vec)) return;
    const idCol = keyIndex >= 0 ? row[keyIndex] : ri + 1;
    simFrom = keyIndex >= 0 ? `${keyCol}=${idCol}` : `row ${ri + 1}`;
    simVector = vec;
    simMode = true;
    runSimilar();
  }

  function exitSimilar() {
    simMode = false;
    simVector = null;
    simFrom = null;
    resetPaging();
    fetchPage('first');
    fetchCount();
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
      simMode = false;
      simVector = null;
      simFrom = null;
      totalCount = null;
      result = null;
      fetchPage('first');
      fetchCount();
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
    if (simMode) runSimilar();
    else fetchPage('first');
    fetchCount();
  }
  function clearFilters() {
    draftFilters = [];
    appliedFilters = [];
    resetPaging();
    if (simMode) runSimilar();
    else fetchPage('first');
    fetchCount();
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
  const rowCount = $derived(result?.rows?.length ?? 0);
  const fmt = (ms) => (ms == null ? '' : `${ms.toFixed(2)} ms`);
</script>

<div class="browser">
  <div class="bar">
    <div class="meta">
      <strong>{table?.name}</strong>
      <span class="mode">
        {#if sortCol}sorted by {sortCol} {sortDir === 'asc' ? '↑' : '↓'}
        {:else if mode === 'keyset'}keyset on {keyCol}
        {:else}LIMIT/OFFSET (no key){/if}
      </span>
      {#if vectorCol}
        <span class="vecchip" title="{vectorCol.name} {vectorCol.type}{vectorIndexed ? ' · ANN indexed' : ''}">
          VEC{#if vectorIndexed}<span class="ann">ANN</span>{/if}
        </span>
      {/if}
      {#if editable && !canEdit}
        <span class="ro" title="Editing needs a single-column primary key">read-only (no PK)</span>
      {/if}
    </div>
    <div class="pager">
      {#if roundTripMs != null}<span class="rt">round-trip: {fmt(roundTripMs)}</span>{/if}
      {#if canEdit && !simMode}
        <button class="insert" onclick={openInsert} disabled={loading}>+ Insert</button>
      {/if}
      {#if !simMode}
        {#if totalCount != null}<span class="total">{totalCount.toLocaleString()} rows</span>{/if}
        <span class="pageno">page {page + 1}</span>
        <button onclick={() => fetchPage('first')} disabled={loading || page === 0}>First</button>
        {#if effectiveMode === 'offset'}
          <button onclick={() => fetchPage('prev')} disabled={loading || page === 0}>← Prev</button>
        {/if}
        <button onclick={() => fetchPage('next')} disabled={loading || atEnd}>Next →</button>
      {/if}
    </div>
  </div>

  {#if simMode}
    <div class="simbar">
      <span class="simchip">≈ similar to {simFrom}</span>
      <label class="klab">
        k
        <input
          class="kinput"
          type="number"
          min="1"
          max="100"
          bind:value={k}
          onchange={runSimilar}
          onkeydown={(e) => e.key === 'Enter' && runSimilar()}
        />
      </label>
      {#if droppedInSimilar > 0}
        <span class="simnote" title="unidb can't combine IS NULL with a vector NEAR search">
          IS NULL filter ignored while similar
        </span>
      {/if}
      <span class="grow"></span>
      <button class="ghost" onclick={exitSimilar}>Back to browsing</button>
    </div>
  {/if}

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
    <ResultsGrid
      {result}
      columns={colNames}
      columnTypes={colTypes}
      onRowAction={vectorIndexed && !simMode ? findSimilar : null}
      rowActionIcon="≈"
      rowActionTitle="Find similar rows (vector NEAR search)"
      onCellEdit={canEdit && !simMode ? handleCellEdit : null}
      onRowDelete={canEdit && !simMode ? requestRowDelete : null}
      onSort={simMode ? null : handleSort}
      {sortState}
      {headerMeta}
    />
    {#if rowCount === 0 && appliedFilters.length > 0}
      <p class="muted end">No rows match the filters.</p>
    {:else if simMode}
      <p class="muted end">Top {rowCount} nearest by {vectorCol?.name}.</p>
    {:else if atEnd}
      <p class="muted end">End of table.</p>
    {/if}
  {/if}

  {#if showInsert}
    <div class="modal-backdrop" role="presentation" onpointerdown={() => (showInsert = false)}>
      <div class="modal" role="dialog" aria-label="Insert row into {table?.name}" onpointerdown={(e) => e.stopPropagation()}>
        <div class="modal-head">
          <strong>Insert row · {table?.name}</strong>
          <button class="icon" title="Close" onclick={() => (showInsert = false)}>✕</button>
        </div>
        <div class="modal-body">
          {#each table?.columns ?? [] as c}
            <label class="field">
              <span class="flabel">
                {c.name}
                <span class="ftype">{c.type}{c.nullable === false ? ' · required' : ''}{c.default != null ? ` · default ${c.default}` : ''}</span>
              </span>
              <input
                class="finput"
                bind:value={insertDraft[c.name]}
                placeholder={c.default != null ? 'default' : c.nullable ? 'NULL' : ''}
                spellcheck="false"
              />
            </label>
          {/each}
        </div>
        {#if insertError}<p class="insert-err">{insertError}</p>{/if}
        <div class="modal-foot">
          <span class="hint">Blank = {'{'}default if any, else NULL{'}'}. Vectors/JSON as JSON, e.g. [0.1, 0.2].</span>
          <button class="ghost" onclick={() => (showInsert = false)}>Cancel</button>
          <button onclick={submitInsert} disabled={loading}>Insert</button>
        </div>
      </div>
    </div>
  {/if}

  {#if deleteConfirm}
    <div class="modal-backdrop" role="presentation" onpointerdown={() => (deleteConfirm = null)}>
      <div class="modal del-modal" role="dialog" aria-label="Confirm delete" onpointerdown={(e) => e.stopPropagation()}>
        <div class="modal-head">
          <strong>Delete row</strong>
          <button class="icon" title="Close" onclick={() => (deleteConfirm = null)}>✕</button>
        </div>
        <div class="modal-body">
          <p class="del-msg">
            This will permanently delete the row where
            <code>{pkCol} = {deleteConfirm.pkVal}</code>
            from <strong>{table?.name}</strong>. This cannot be undone.
          </p>
        </div>
        <div class="modal-foot">
          <span class="grow"></span>
          <button class="ghost" onclick={() => (deleteConfirm = null)}>Cancel</button>
          <button class="del-btn" onclick={confirmRowDelete} disabled={loading}>Delete</button>
        </div>
      </div>
    </div>
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
  .vecchip {
    align-self: center;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 2px 5px;
    border-radius: 6px;
    background: rgba(147, 51, 234, 0.16);
    color: #9333ea;
  }
  .vecchip .ann {
    background: rgba(147, 51, 234, 0.9);
    color: #fff;
    padding: 0 3px;
    border-radius: 4px;
  }
  .pager {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ro {
    align-self: center;
    font-size: 11px;
    color: var(--muted);
    font-style: italic;
  }
  .browser button.insert {
    background: var(--accent);
    color: #fff;
    padding: 5px 12px;
  }
  .rt {
    font-size: 11px;
    color: var(--muted);
    font-family: var(--mono);
  }
  .total {
    font-size: 12px;
    color: var(--text);
    font-variant-numeric: tabular-nums;
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

  /* vector similar-search bar */
  .simbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 10px;
    border: 1px solid rgba(147, 51, 234, 0.35);
    border-radius: 8px;
    background: rgba(147, 51, 234, 0.07);
  }
  .simchip {
    font-size: 12px;
    font-weight: 600;
    color: #9333ea;
  }
  .simnote {
    font-size: 11px;
    color: var(--muted);
    font-style: italic;
  }
  .klab {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: var(--muted);
  }
  .kinput {
    width: 56px;
    padding: 4px 6px;
    font-size: 12px;
    font-family: inherit;
    color: var(--text);
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .kinput:focus {
    outline: none;
    border-color: var(--accent);
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

  /* insert-row modal */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 30;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .modal {
    width: min(520px, 100%);
    max-height: 82vh;
    display: flex;
    flex-direction: column;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
    overflow: hidden;
  }
  .modal-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
  }
  .modal-head strong {
    font-size: 14px;
  }
  .modal-body {
    padding: 12px 14px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .flabel {
    font-size: 12px;
    font-weight: 600;
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .ftype {
    font-weight: 400;
    font-size: 11px;
    color: var(--muted);
    font-family: var(--mono);
  }
  .finput {
    padding: 6px 9px;
    font-size: 13px;
    font-family: var(--mono);
    color: var(--text);
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .finput:focus {
    outline: none;
    border-color: var(--accent);
  }
  .insert-err {
    margin: 0;
    padding: 8px 14px;
    color: var(--err-fg);
    background: var(--err-bg);
    font-size: 12px;
  }
  .modal-foot {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-top: 1px solid var(--border);
  }
  .modal-foot .hint {
    flex: 1;
    font-size: 11px;
    color: var(--muted);
  }
  .modal-foot .grow { flex: 1; }

  /* delete confirmation modal */
  .del-modal { width: min(400px, 100%); }
  .del-msg {
    margin: 0;
    font-size: 13.5px;
    line-height: 1.6;
    color: var(--text);
  }
  .del-msg code {
    font-family: var(--mono);
    font-size: 12.5px;
    background: var(--panel-alt);
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid var(--border);
  }
  .del-btn {
    background: var(--err-fg, #ef4444);
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 7px 16px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .del-btn:hover   { opacity: 0.88; }
  .del-btn:disabled { opacity: 0.5; cursor: default; }
</style>
