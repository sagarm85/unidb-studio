<script>
  import { quoteIdent, isVectorType } from './format.js';

  // Manage a single table: add/drop columns, create an index, drop the table.
  // `onRun(sql)` executes DDL + refreshes the catalog (parent re-passes `table`
  // with fresh columns). `onClose` dismisses. `onDropped` fires after DROP TABLE.
  let { table, onRun, onClose, onDropped } = $props();

  const TYPES = ['INT', 'BIGINT', 'TEXT', 'BOOL', 'FLOAT', 'DOUBLE', 'DECIMAL(10,2)', 'TIMESTAMP', 'DATE', 'TIME', 'UUID', 'JSON', 'BYTEA', 'VECTOR(4)'];

  let error = $state(null);
  let busy = $state(false);

  // add column
  let newCol = $state({ name: '', type: 'TEXT', notNull: false });
  // create index
  let idxCol = $state('');
  let idxKind = $state('BTREE');

  const cols = $derived(table?.columns ?? []);

  async function run(sql, after) {
    error = null;
    busy = true;
    try {
      await onRun(sql);
      after?.();
    } catch (e) {
      error = e.message ?? String(e);
    } finally {
      busy = false;
    }
  }

  function addColumn() {
    const n = newCol.name.trim();
    if (!n) return (error = 'column name is required');
    if (!newCol.type.trim()) return (error = 'type is required');
    const nn = newCol.notNull ? ' NOT NULL' : '';
    run(`ALTER TABLE ${quoteIdent(table.name)} ADD COLUMN ${quoteIdent(n)} ${newCol.type.trim()}${nn}`, () => {
      newCol = { name: '', type: 'TEXT', notNull: false };
    });
  }
  function dropColumn(name) {
    if (!confirm(`Drop column "${name}" from ${table.name}?`)) return;
    run(`ALTER TABLE ${quoteIdent(table.name)} DROP COLUMN ${quoteIdent(name)}`);
  }
  function createIndex() {
    if (!idxCol) return (error = 'pick a column');
    const idxName = `idx_${table.name}_${idxCol}`;
    run(`CREATE INDEX ${quoteIdent(idxName)} ON ${quoteIdent(table.name)} USING ${idxKind} (${quoteIdent(idxCol)})`);
  }
  function dropTable() {
    if (!confirm(`Drop table "${table.name}"? This cannot be undone.`)) return;
    run(`DROP TABLE ${quoteIdent(table.name)}`, onDropped);
  }
</script>

<div class="modal-backdrop" role="presentation" onpointerdown={onClose}>
  <div class="modal" role="dialog" aria-label="Manage table {table?.name}" onpointerdown={(e) => e.stopPropagation()}>
    <div class="modal-head">
      <strong>Manage · {table?.name}</strong>
      <button class="x" title="Close" onclick={onClose}>✕</button>
    </div>

    <div class="modal-body">
      <section>
        <h4>Columns</h4>
        <div class="collist">
          <div class="col-hdr">
            <span>Name</span>
            <span>Type</span>
            <span>Nullable</span>
            <span></span>
          </div>
          {#each cols as c}
            <div class="col-row">
              <span class="cn">{c.name}</span>
              <span class="ct">{c.type}{isVectorType(c.type) && c.index === 'hnsw' ? ' · ANN' : ''}</span>
              <span class="cn {c.nullable === false ? 'no' : 'yes'}">{c.nullable === false ? 'No' : 'Yes'}</span>
              <button class="x" title="Drop column" onclick={() => dropColumn(c.name)} disabled={busy}>✕</button>
            </div>
          {/each}
        </div>
      </section>

      <section>
        <h4>Add column</h4>
        <div class="addrow">
          <input bind:value={newCol.name} placeholder="name" spellcheck="false" />
          <input bind:value={newCol.type} list="unidb-types-2" placeholder="type" spellcheck="false" />
          <datalist id="unidb-types-2">{#each TYPES as t}<option value={t}></option>{/each}</datalist>
          <label class="nn"><input type="checkbox" bind:checked={newCol.notNull} /> NOT NULL</label>
          <button onclick={addColumn} disabled={busy}>Add</button>
        </div>
      </section>

      <section>
        <h4>Create index</h4>
        <div class="addrow">
          <select bind:value={idxCol}>
            <option value="" disabled>column…</option>
            {#each cols as c}<option value={c.name}>{c.name}</option>{/each}
          </select>
          <select bind:value={idxKind}>
            <option value="BTREE">BTREE</option>
            <option value="HNSW">HNSW (vector)</option>
            <option value="FULLTEXT">FULLTEXT (text)</option>
          </select>
          <button onclick={createIndex} disabled={busy}>Create</button>
        </div>
      </section>
    </div>

    {#if error}<p class="err">{error}</p>{/if}

    <div class="modal-foot">
      <button class="danger" onclick={dropTable} disabled={busy}>Drop table</button>
      <span class="grow"></span>
      <button class="ghost" onclick={onClose}>Close</button>
    </div>
  </div>
</div>

<style>
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
    max-height: 84vh;
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
  .modal-body {
    padding: 8px 14px 14px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  h4 {
    margin: 10px 0 6px;
    font-size: 12px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .collist {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .col-hdr,
  .col-row {
    display: grid;
    grid-template-columns: 1fr 120px 80px 24px;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
  }
  .col-hdr {
    background: var(--panel-alt);
    border-bottom: 1px solid var(--border);
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .col-row {
    border-bottom: 1px solid var(--border);
  }
  .col-row:last-child {
    border-bottom: none;
  }
  .col-row:hover {
    background: var(--panel-alt);
  }
  .cn {
    font-family: var(--mono);
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cn.yes { color: var(--muted); font-size: 12px; }
  .cn.no  { color: var(--text);  font-size: 12px; }
  .ct {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
  }
  .addrow {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .addrow input:not([type='checkbox']),
  .addrow select {
    padding: 6px 9px;
    font-size: 13px;
    font-family: var(--mono);
    color: var(--text);
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .addrow input:not([type='checkbox']) {
    flex: 1;
    min-width: 90px;
  }
  .addrow input:focus,
  .addrow select:focus {
    outline: none;
    border-color: var(--accent);
  }
  .nn {
    font-size: 12px;
    color: var(--muted);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }
  .addrow button:not(.x) {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 13px;
    cursor: pointer;
  }
  .x {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 13px;
  }
  .x:hover {
    color: var(--err-fg);
  }
  .err {
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
  .grow {
    flex: 1;
  }
  .danger {
    background: none;
    color: var(--err-fg);
    border: 1px solid var(--err-border);
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 13px;
    cursor: pointer;
  }
  .danger:hover {
    background: var(--err-bg);
  }
  .ghost {
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    padding: 6px 12px;
    font-size: 13px;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
  }
</style>
