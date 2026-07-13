<script>
  import { quoteIdent } from './format.js';

  // Modal to build a CREATE TABLE statement. `onSubmit(sql)` runs it; `onClose`
  // dismisses. Types are free text (with a datalist of common ones) so
  // parameterized types like VECTOR(4) / DECIMAL(10,2) just work.
  let { onSubmit, onClose } = $props();

  const TYPES = [
    'INT', 'BIGINT', 'TEXT', 'BOOL',
    'FLOAT', 'DOUBLE', 'DECIMAL(10,2)',
    'TIMESTAMP', 'DATE', 'TIME',
    'UUID', 'JSON', 'BYTEA', 'VECTOR(4)',
  ];

  // Allow typing a custom type (e.g. VECTOR(128)) while keeping the select for common ones.
  // When the user picks from the select, write it to c.type; freeform input also works.
  function pickType(col, val) {
    col.type = val;
  }

  let name = $state('');
  let cols = $state([{ name: 'id', type: 'INT', notNull: true, pk: true }]);
  let error = $state(null);
  let busy = $state(false);

  function addCol() {
    cols = [...cols, { name: '', type: 'TEXT', notNull: false, pk: false }];
  }
  function removeCol(i) {
    cols = cols.filter((_, idx) => idx !== i);
  }

  function buildSql() {
    const tbl = name.trim();
    if (!tbl) throw new Error('table name is required');
    const defs = [];
    const pks = [];
    for (const c of cols) {
      const cn = c.name.trim();
      if (!cn) throw new Error('every column needs a name');
      if (!c.type.trim()) throw new Error(`column "${cn}" needs a type`);
      let line = `${quoteIdent(cn)} ${c.type.trim()}`;
      if (c.notNull && !c.pk) line += ' NOT NULL';
      defs.push(line);
      if (c.pk) pks.push(quoteIdent(cn));
    }
    if (!defs.length) throw new Error('add at least one column');
    if (pks.length) defs.push(`PRIMARY KEY (${pks.join(', ')})`);
    return `CREATE TABLE ${quoteIdent(tbl)} (\n  ${defs.join(',\n  ')}\n)`;
  }

  async function submit() {
    error = null;
    let sql;
    try {
      sql = buildSql();
    } catch (e) {
      error = e.message;
      return;
    }
    busy = true;
    try {
      await onSubmit(sql);
    } catch (e) {
      error = e.message ?? String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="modal-backdrop" role="presentation" onpointerdown={onClose}>
  <div class="modal" role="dialog" aria-label="New table" onpointerdown={(e) => e.stopPropagation()}>
    <div class="modal-head">
      <strong>New table</strong>
      <button class="x" title="Close" onclick={onClose}>✕</button>
    </div>
    <div class="modal-body">
      <label class="row1">
        <span class="lbl">Table name</span>
        <input bind:value={name} placeholder="e.g. customers" spellcheck="false" />
      </label>

      <div class="cols">
        <div class="colhdr">
          <span>Column</span><span>Type</span><span title="NOT NULL">NN</span><span title="Primary key">PK</span><span></span>
        </div>
        {#each cols as c, i}
          <div class="colrow">
            <input bind:value={c.name} placeholder="name" spellcheck="false" />
            <div class="type-cell">
              <select
                value={TYPES.includes(c.type) ? c.type : '__custom__'}
                onchange={(e) => {
                  if (e.target.value !== '__custom__') c.type = e.target.value;
                }}
              >
                {#each TYPES as t}
                  <option value={t}>{t}</option>
                {/each}
                {#if !TYPES.includes(c.type)}
                  <option value="__custom__">{c.type}</option>
                {/if}
              </select>
              {#if !TYPES.includes(c.type)}
                <input class="custom-type" bind:value={c.type} placeholder="custom type" spellcheck="false" />
              {/if}
            </div>
            <input type="checkbox" bind:checked={c.notNull} aria-label="NOT NULL" />
            <input type="checkbox" bind:checked={c.pk} aria-label="Primary key" />
            <button class="x" title="Remove column" onclick={() => removeCol(i)}>✕</button>
          </div>
        {/each}
        <button class="ghost" onclick={addCol}>+ Add column</button>
      </div>
    </div>
    {#if error}<p class="err">{error}</p>{/if}
    <div class="modal-foot">
      <span class="grow"></span>
      <button class="ghost" onclick={onClose}>Cancel</button>
      <button onclick={submit} disabled={busy}>{busy ? 'Creating…' : 'Create table'}</button>
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
    width: min(560px, 100%);
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
    padding: 12px 14px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .row1 {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .lbl {
    font-size: 12px;
    font-weight: 600;
  }
  input[type='text'],
  .row1 input,
  .colrow input:not([type='checkbox']) {
    padding: 6px 9px;
    font-size: 13px;
    font-family: var(--mono);
    color: var(--text);
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .row1 input:focus,
  .colrow input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .cols {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .colhdr,
  .colrow {
    display: grid;
    grid-template-columns: 1fr 1fr 28px 28px 24px;
    gap: 8px;
    align-items: center;
  }
  /* type cell: select fills the column; custom-type input appears below it */
  .type-cell {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .type-cell select {
    width: 100%;
    padding: 6px 9px;
    font-size: 13px;
    font-family: var(--mono);
    color: var(--text);
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
    appearance: auto;
  }
  .type-cell select:focus { outline: none; border-color: var(--accent); }
  .custom-type {
    padding: 5px 8px;
    font-size: 12px;
    font-family: var(--mono);
    color: var(--text);
    background: var(--panel);
    border: 1px solid var(--accent);
    border-radius: 6px;
  }
  .custom-type:focus { outline: none; }
  .colhdr {
    font-size: 11px;
    color: var(--muted);
    font-weight: 600;
    text-align: center;
  }
  .colhdr span:first-child,
  .colhdr span:nth-child(2) {
    text-align: left;
  }
  .colrow input[type='checkbox'] {
    justify-self: center;
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
  .ghost {
    align-self: flex-start;
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    padding: 5px 10px;
    font-size: 12px;
    cursor: pointer;
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
  .modal-foot button:not(.ghost) {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 7px 14px;
    font-size: 13px;
    cursor: pointer;
  }
  .modal-foot button:disabled {
    opacity: 0.5;
  }
</style>
