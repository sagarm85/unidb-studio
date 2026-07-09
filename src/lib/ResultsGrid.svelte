<script>
  import { formatCell, isNull } from './format.js';

  // One ExecResult from /sql, plus optional real column names (the `rows` wire
  // shape carries none, so we fall back to positional headers).
  let { result, columns = null } = $props();

  const affectedVerb = {
    inserted: 'inserted',
    updated: 'updated',
    deleted: 'deleted',
    truncated: 'truncated',
  };
  const ddlMessage = {
    created_table: 'Table created.',
    created_index: 'Index created.',
    altered_table: 'Table altered.',
    dropped_table: 'Table dropped.',
  };

  const rows = $derived(result?.type === 'rows' ? (result.rows ?? []) : []);
  const colCount = $derived(rows.reduce((m, r) => Math.max(m, r.length), 0));
  // Real names when the caller knows them (record browser); else col 0..n-1.
  const headers = $derived(
    columns && columns.length
      ? columns
      : Array.from({ length: colCount }, (_, i) => `col ${i}`),
  );
</script>

{#if result?.type === 'rows'}
  {#if rows.length === 0}
    <p class="muted">0 rows.</p>
  {:else}
    <div class="grid-wrap">
      <table>
        <thead>
          <tr>
            <th class="rownum">#</th>
            {#each headers as h}<th>{h}</th>{/each}
          </tr>
        </thead>
        <tbody>
          {#each rows as row, ri}
            <tr>
              <td class="rownum">{ri + 1}</td>
              {#each headers as _, ci}
                <td class:null={isNull(row[ci])}>{formatCell(row[ci])}</td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="muted count">{rows.length} row{rows.length === 1 ? '' : 's'}</p>
  {/if}
{:else if affectedVerb[result?.type]}
  <p class="ok">{result.count} row{result.count === 1 ? '' : 's'} {affectedVerb[result.type]}.</p>
{:else if ddlMessage[result?.type]}
  <p class="ok">{ddlMessage[result.type]}</p>
{:else}
  <p class="muted">{result?.type ?? 'unknown result'}</p>
{/if}

<style>
  .grid-wrap {
    overflow: auto;
    max-height: 55vh;
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 13px;
  }
  th,
  td {
    text-align: left;
    padding: 5px 10px;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  thead th {
    position: sticky;
    top: 0;
    background: var(--panel-alt);
    font-weight: 600;
    z-index: 1;
  }
  tbody tr:hover {
    background: var(--panel-alt);
  }
  .rownum {
    color: var(--muted);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  td.null {
    color: var(--muted);
    font-style: italic;
  }
  .muted {
    color: var(--muted);
  }
  .count {
    margin: 6px 2px 0;
    font-size: 12px;
  }
  .ok {
    color: var(--accent);
    font-weight: 500;
  }
</style>
