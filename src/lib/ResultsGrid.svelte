<script>
  import { formatCell, fullCellText, isNull } from './format.js';
  import { rowsToCsv, downloadText } from './csv.js';

  // One ExecResult from /sql. The enriched `rows` result carries `columns`
  // (output names in order). `columns` prop is an optional fallback for older
  // servers that predate the enrichment (e.g. from /tables introspection).
  // `columnTypes` (optional, parallel to the resolved headers) lets a caller
  // that knows the schema — e.g. the record browser — render cells by type
  // (compact vectors) and show the type in the header.
  // `onRowAction` (optional) adds a leading action button per row — the record
  // browser uses it for "Find similar" (vector NEAR search).
  // `onCellEdit`/`onRowDelete` (optional) turn the grid into an editor: click a
  // cell to edit → `onCellEdit(rowIndex, column, rawString)`; a per-row ✕ →
  // `onRowDelete(row, rowIndex)`. SqlEditor passes neither (stays read-only).
  let {
    result,
    columns = null,
    columnTypes = null,
    onRowAction = null,
    rowActionIcon = '⌕',
    rowActionTitle = 'Action',
    onCellEdit = null,
    onRowDelete = null,
    onSort = null,
    sortState = null, // { col, dir } | null
    headerMeta = null, // parallel to headers: [{ isPk, isFk }]
  } = $props();

  const metaAt = (ci) => headerMeta?.[ci] ?? null;
  const sortCaret = (h) => (sortState?.col === h ? (sortState.dir === 'asc' ? ' ↑' : ' ↓') : '');

  const hasRowCol = $derived(!!onRowAction || !!onRowDelete);
  const editable = $derived(!!onCellEdit);

  // Inline cell editing.
  let editing = $state(null); // { ri, ci } | null
  let draft = $state('');
  function startEdit(ri, ci, v) {
    if (!editable) return;
    editing = { ri, ci };
    draft = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  function commitEdit() {
    if (!editing) return;
    const { ri, ci } = editing;
    editing = null;
    onCellEdit?.(ri, headers[ci], draft);
  }
  function cancelEdit() {
    editing = null;
  }
  function onEditKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  }
  // Autofocus + select the edit input when it mounts.
  function editFocus(node) {
    node.focus();
    node.select?.();
  }

  function exportCsv() {
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadText(`unidb-export-${ts}.csv`, rowsToCsv(headers, rows));
  }

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
  // Prefer server-provided column names; fall back to caller-supplied names
  // (older servers), then positional col 0..n-1 as a last resort.
  const headers = $derived.by(() => {
    if (result?.columns?.length) return result.columns;
    if (columns && columns.length) return columns;
    return Array.from({ length: colCount }, (_, i) => `col ${i}`);
  });
  // Type per header column, when the caller supplied a parallel list.
  const typeAt = (ci) => columnTypes?.[ci] ?? null;

  // Click-to-copy: track which cell was last copied for a brief affordance.
  let copied = $state(null); // `${ri}:${ci}` | null
  async function copyCell(ri, ci, value) {
    try {
      await navigator.clipboard.writeText(fullCellText(value));
      copied = `${ri}:${ci}`;
      setTimeout(() => {
        if (copied === `${ri}:${ci}`) copied = null;
      }, 1000);
    } catch {
      copied = null;
    }
  }
</script>

{#if result?.type === 'rows'}
  {#if rows.length === 0}
    <p class="muted">0 rows.</p>
  {:else}
    <div class="grid-wrap">
      <table>
        <thead>
          <tr>
            {#if hasRowCol}<th class="rowact" aria-hidden="true"></th>{/if}
            <th class="rownum">#</th>
            {#each headers as h, ci}
              <th class:sortable={onSort} onclick={() => onSort?.(h)}>
                <span class="hname">
                  {#if metaAt(ci)?.isPk}<span class="hbadge pk" title="primary key">🔑</span>{/if}
                  {#if metaAt(ci)?.isFk}<span class="hbadge fk" title="foreign key">🔗</span>{/if}
                  {h}{sortCaret(h)}
                </span>
                {#if typeAt(ci)}<span class="htype">{typeAt(ci)}</span>{/if}
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each rows as row, ri}
            <tr>
              {#if hasRowCol}
                <td class="rowact">
                  {#if onRowAction}
                    <button class="rowact-btn" title={rowActionTitle} onclick={() => onRowAction(row, ri)}>
                      {rowActionIcon}
                    </button>
                  {/if}
                  {#if onRowDelete}
                    <button class="rowact-btn del" title="Delete row" onclick={() => onRowDelete(row, ri)}>✕</button>
                  {/if}
                </td>
              {/if}
              <td class="rownum">{ri + 1}</td>
              {#each headers as _, ci}
                {@const v = row[ci]}
                {#if editing?.ri === ri && editing?.ci === ci}
                  <td class="editing">
                    <input
                      class="celledit"
                      bind:value={draft}
                      use:editFocus
                      onkeydown={onEditKey}
                      onblur={commitEdit}
                      spellcheck="false"
                    />
                  </td>
                {:else}
                  <td
                    class:null={isNull(v)}
                    class:copied={copied === `${ri}:${ci}`}
                    class:editable
                    title={editable
                      ? 'Click to edit'
                      : isNull(v)
                        ? 'NULL'
                        : `${fullCellText(v)}\n\n(click to copy)`}
                    onclick={() => (editable ? startEdit(ri, ci, v) : !isNull(v) && copyCell(ri, ci, v))}
                  >
                    <span class="cellval">{formatCell(v, typeAt(ci))}</span>
                    {#if copied === `${ri}:${ci}`}<span class="copiedtag">copied ✓</span>{/if}
                  </td>
                {/if}
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="footer">
      <span class="muted count">{rows.length} row{rows.length === 1 ? '' : 's'}</span>
      <button class="csvbtn" onclick={exportCsv} title="Download these rows as CSV">Export CSV</button>
    </p>
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
  .hname {
    display: block;
  }
  th.sortable {
    cursor: pointer;
    user-select: none;
  }
  th.sortable:hover {
    background: var(--border);
  }
  .hbadge {
    font-size: 10px;
    margin-right: 2px;
  }
  .htype {
    display: block;
    font-weight: 400;
    font-size: 10px;
    color: var(--muted);
    font-family: var(--mono);
    margin-top: 1px;
  }
  tbody tr:hover {
    background: var(--panel-alt);
  }
  /* Cells are click-to-copy; cap width so a wide value (long text, vector,
     JSON) can't blow out the grid — the full value is in the title + clipboard. */
  td {
    position: relative;
    cursor: default;
  }
  td.null {
    color: var(--muted);
    font-style: italic;
    cursor: default;
  }
  .cellval {
    display: inline-block;
    max-width: 340px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: bottom;
  }
  td.copied {
    background: rgba(37, 99, 235, 0.1);
  }
  .copiedtag {
    position: absolute;
    top: 50%;
    right: 6px;
    transform: translateY(-50%);
    font-size: 10px;
    font-weight: 600;
    color: var(--accent);
    background: var(--panel);
    padding: 1px 5px;
    border-radius: 8px;
    pointer-events: none;
  }
  .rownum {
    color: var(--muted);
    text-align: right;
    font-variant-numeric: tabular-nums;
    cursor: default;
  }
  .rowact {
    width: 1%;
    padding: 2px 4px 2px 8px;
    cursor: default;
  }
  .rowact-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--muted);
    font-size: 13px;
    line-height: 1;
    padding: 3px 6px;
  }
  .rowact-btn {
    margin-right: 3px;
  }
  .rowact-btn:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
  .rowact-btn.del:hover {
    color: var(--err-fg);
    border-color: var(--err-fg);
  }
  /* editable cells: click to edit */
  td.editable {
    cursor: text;
  }
  td.editing {
    padding: 2px 4px;
  }
  .celledit {
    width: 100%;
    min-width: 90px;
    box-sizing: border-box;
    font-family: var(--mono);
    font-size: 13px;
    padding: 3px 6px;
    border: 1px solid var(--accent);
    border-radius: 4px;
    background: var(--panel);
    color: var(--text);
    outline: none;
  }
  .muted {
    color: var(--muted);
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 6px 2px 0;
  }
  .count {
    font-size: 12px;
  }
  .csvbtn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 11px;
    padding: 3px 9px;
    cursor: pointer;
  }
  .csvbtn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .ok {
    color: var(--accent);
    font-weight: 500;
  }
</style>
