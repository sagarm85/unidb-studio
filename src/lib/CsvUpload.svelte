<script>
  import { runSql } from './api.js';
  import { parseCsv } from './csv.js';
  import { quoteIdent } from './format.js';
  import ErrorBox from './ErrorBox.svelte';

  let { tables = [] } = $props();

  let fileName = $state('');
  let headers = $state([]);
  let rows = $state([]);
  let targetTable = $state('');
  let batchSize = $state(100);

  let importing = $state(false);
  let error = $state(null);
  let done = $state(null); // { inserted, wallMs, rowsPerSec }
  let progress = $state(0);
  let parseError = $state(null);

  async function onFile(e) {
    error = null;
    done = null;
    parseError = null;
    const file = e.target.files?.[0];
    if (!file) return;
    fileName = file.name;
    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      headers = parsed.headers;
      rows = parsed.rows;
      if (!targetTable) targetTable = file.name.replace(/\.[^.]+$/, '');
    } catch (err) {
      parseError = `Could not parse CSV: ${err.message}`;
      headers = [];
      rows = [];
    }
  }

  // A SQL literal for a cell: empty string -> NULL, otherwise a single-quoted
  // string (quotes doubled). The engine coerces the string to each column's
  // real type (per REST_API.md: a text value is "later coerced to the column's
  // type"). Values are quoted, not bound as params, because batching here means
  // many `;`-separated statements in ONE /sql body (the documented way to run
  // them in a single transaction), and $n numbering across statements isn't
  // part of the documented contract.
  function lit(v) {
    if (v === '' || v === null || v === undefined) return 'NULL';
    return `'${String(v).replace(/'/g, "''")}'`;
  }

  function buildBatch(tableName, cols, batchRows) {
    const t = quoteIdent(tableName);
    const colList = cols.map(quoteIdent).join(', ');
    return batchRows
      .map((r) => `INSERT INTO ${t} (${colList}) VALUES (${cols.map((_, i) => lit(r[i])).join(', ')})`)
      .join('; ');
  }

  async function runImport() {
    if (!targetTable || !rows.length) return;
    importing = true;
    error = null;
    done = null;
    progress = 0;

    let inserted = 0;
    const size = Math.max(1, Number(batchSize) || 1);
    const start = performance.now();

    try {
      for (let i = 0; i < rows.length; i += size) {
        const batch = rows.slice(i, i + size);
        const sql = buildBatch(targetTable, headers, batch);
        const { results } = await runSql(sql);
        // One "inserted" result per statement in the batch.
        for (const r of results) if (r.type === 'inserted') inserted += r.count ?? 0;
        progress = Math.min(i + size, rows.length);
      }
      const wallMs = performance.now() - start;
      done = {
        inserted,
        wallMs,
        rowsPerSec: wallMs > 0 ? (inserted / wallMs) * 1000 : 0,
      };
    } catch (e) {
      error = {
        code: e.code,
        message: `${e.message} (imported ${inserted} of ${rows.length} rows before this batch failed & rolled back)`,
        status: e.status,
      };
    } finally {
      importing = false;
    }
  }
</script>

<div class="csv">
  <div class="row">
    <input type="file" accept=".csv,text/csv" onchange={onFile} />
    {#if fileName}<span class="muted">{fileName} · {rows.length} rows</span>{/if}
  </div>

  {#if parseError}
    <p class="err">{parseError}</p>
  {/if}

  {#if headers.length}
    <div class="config">
      <label>
        target table
        <input list="tablenames" bind:value={targetTable} placeholder="table name" />
        <datalist id="tablenames">
          {#each tables as t}<option value={t.name}></option>{/each}
        </datalist>
      </label>
      <label>
        batch size
        <input type="number" min="1" bind:value={batchSize} class="num" />
      </label>
      <button onclick={runImport} disabled={importing || !targetTable}>
        {importing ? `Importing… ${progress}/${rows.length}` : 'Import'}
      </button>
    </div>

    <div class="preview">
      <div class="cols">columns: <code>{headers.join(', ')}</code></div>
      {#if rows.length}
        <div class="cols muted">first row: <code>{rows[0].join(' | ')}</code></div>
      {/if}
    </div>
  {/if}

  {#if error}
    <ErrorBox {error} />
  {/if}

  {#if done}
    <div class="done">
      <div><b>{done.inserted}</b> rows inserted</div>
      <div>wall-clock: <b>{done.wallMs.toFixed(1)} ms</b></div>
      <div>throughput: <b>{done.rowsPerSec.toFixed(0)} rows/sec</b></div>
    </div>
  {/if}

  <p class="caveat">
    Per-row <code>INSERT</code> batched into one transaction per request — there is no bulk
    <code>COPY</code>. Use demo-sized files.
  </p>
</div>

<style>
  .csv {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .config {
    display: flex;
    align-items: flex-end;
    gap: 14px;
    flex-wrap: wrap;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--muted);
  }
  input:not([type='file']):not([type='number']),
  .num {
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel);
    color: var(--text);
    font-family: var(--mono);
    font-size: 13px;
  }
  .num {
    width: 90px;
  }
  .preview {
    font-size: 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  code {
    font-family: var(--mono);
    background: var(--panel-alt);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .done {
    display: flex;
    gap: 22px;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--panel-alt);
    font-size: 13px;
  }
  .done b {
    color: var(--accent);
  }
  .muted {
    color: var(--muted);
  }
  .err {
    color: var(--err-fg);
    font-size: 13px;
  }
  .caveat {
    font-size: 11px;
    color: var(--muted);
    margin: 0;
  }
</style>
