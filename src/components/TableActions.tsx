import { useState } from 'react';
import { quoteIdent, isVectorType } from '@/lib/engine/format.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog';
import type { CatalogTable } from '@/hooks/useCatalog';

const TYPES = ['INT', 'BIGINT', 'TEXT', 'BOOL', 'FLOAT', 'DOUBLE', 'DECIMAL(10,2)', 'TIMESTAMP', 'DATE', 'TIME', 'UUID', 'JSON', 'BYTEA', 'VECTOR(4)'];

// Manage a single table: add/drop columns, create an index, drop the table.
// `onRun(sql)` executes DDL + refreshes the catalog (parent re-passes `table`
// with fresh columns). `onClose` dismisses. `onDropped` fires after DROP TABLE.
// Drop confirmations use an in-app danger dialog instead of window.confirm()
// (same pattern as RecordBrowser's row-delete confirm), echoing the target
// name in mono per DESIGN_SPEC §4.
export function TableActions({
  table,
  onRun,
  onClose,
  onDropped,
}: {
  table: CatalogTable;
  onRun: (sql: string) => Promise<void>;
  onClose: () => void;
  onDropped: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newCol, setNewCol] = useState({ name: '', type: 'TEXT', notNull: false });
  const [idxCol, setIdxCol] = useState('');
  const [idxKind, setIdxKind] = useState('BTREE');
  const [dropConfirm, setDropConfirm] = useState<{ kind: 'column' | 'table'; name: string } | null>(null);

  const cols = table?.columns ?? [];

  async function run(sql: string, after?: () => void) {
    setError(null);
    setBusy(true);
    try {
      await onRun(sql);
      after?.();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  function addColumn() {
    const n = newCol.name.trim();
    if (!n) return setError('column name is required');
    if (!newCol.type.trim()) return setError('type is required');
    const nn = newCol.notNull ? ' NOT NULL' : '';
    run(`ALTER TABLE ${quoteIdent(table.name)} ADD COLUMN ${quoteIdent(n)} ${newCol.type.trim()}${nn}`, () => {
      setNewCol({ name: '', type: 'TEXT', notNull: false });
    });
  }
  function createIndex() {
    if (!idxCol) return setError('pick a column');
    const idxName = `idx_${table.name}_${idxCol}`;
    run(`CREATE INDEX ${quoteIdent(idxName)} ON ${quoteIdent(table.name)} USING ${idxKind} (${quoteIdent(idxCol)})`);
  }
  function confirmDrop() {
    if (!dropConfirm) return;
    const { kind, name } = dropConfirm;
    setDropConfirm(null);
    if (kind === 'column') {
      run(`ALTER TABLE ${quoteIdent(table.name)} DROP COLUMN ${quoteIdent(name)}`);
    } else {
      run(`DROP TABLE ${quoteIdent(name)}`, onDropped);
    }
  }

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="flex max-h-[84vh] max-w-[520px] flex-col overflow-hidden p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle className="font-mono">Manage · {table?.name}</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4 overflow-auto p-4">
            <section>
              <h4 className="m-0 mb-2 text-xs font-semibold tracking-wide text-text-muted uppercase">Columns</h4>
              <div className="flex flex-col overflow-hidden rounded-lg border border-border">
                <div className="grid grid-cols-[1fr_120px_80px_24px] items-center gap-2 border-b border-border bg-secondary px-3 py-1.5 text-xs font-semibold tracking-wide text-text-muted uppercase">
                  <span>Name</span>
                  <span>Type</span>
                  <span>Nullable</span>
                  <span />
                </div>
                {cols.map((c) => (
                  <div key={c.name} className="grid grid-cols-[1fr_120px_80px_24px] items-center gap-2 border-b border-border-muted px-3 py-2 last:border-b-0 hover:bg-accent">
                    <span className="truncate font-mono text-md">{c.name}</span>
                    <span className="font-mono text-sm text-text-muted">
                      {c.type}
                      {isVectorType(c.type) && c.index === 'hnsw' ? ' · ANN' : ''}
                    </span>
                    <span className={c.nullable === false ? 'text-sm text-foreground' : 'text-sm text-text-muted'}>
                      {c.nullable === false ? 'No' : 'Yes'}
                    </span>
                    <button
                      className="text-text-muted hover:text-error"
                      title="Drop column"
                      onClick={() => setDropConfirm({ kind: 'column', name: c.name })}
                      disabled={busy}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h4 className="m-0 mb-2 text-xs font-semibold tracking-wide text-text-muted uppercase">Add column</h4>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={newCol.name}
                  onChange={(e) => setNewCol((n) => ({ ...n, name: e.target.value }))}
                  placeholder="name"
                  spellCheck={false}
                  className="h-8 min-w-[90px] flex-1 rounded-md border border-border bg-secondary px-2 font-mono text-md outline-none focus-visible:border-border-strong focus-visible:ring-[2px] focus-visible:ring-ring/40"
                />
                <input
                  value={newCol.type}
                  onChange={(e) => setNewCol((n) => ({ ...n, type: e.target.value }))}
                  list="unidb-types-2"
                  placeholder="type"
                  spellCheck={false}
                  className="h-8 min-w-[90px] flex-1 rounded-md border border-border bg-secondary px-2 font-mono text-md outline-none focus-visible:border-border-strong focus-visible:ring-[2px] focus-visible:ring-ring/40"
                />
                <datalist id="unidb-types-2">
                  {TYPES.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
                <label className="inline-flex items-center gap-1 text-sm whitespace-nowrap text-text-light">
                  <input type="checkbox" checked={newCol.notNull} onChange={(e) => setNewCol((n) => ({ ...n, notNull: e.target.checked }))} /> NOT NULL
                </label>
                <button
                  className="h-8 rounded-md bg-brand px-3 text-md text-brand-text-on hover:bg-brand-hover disabled:opacity-45"
                  onClick={addColumn}
                  disabled={busy}
                >
                  Add
                </button>
              </div>
            </section>

            <section>
              <h4 className="m-0 mb-2 text-xs font-semibold tracking-wide text-text-muted uppercase">Create index</h4>
              <div className="flex flex-wrap items-center gap-2">
                <select value={idxCol} onChange={(e) => setIdxCol(e.target.value)} className="h-8 rounded-md border border-border bg-secondary px-2 text-md">
                  <option value="" disabled>
                    column…
                  </option>
                  {cols.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <select value={idxKind} onChange={(e) => setIdxKind(e.target.value)} className="h-8 rounded-md border border-border bg-secondary px-2 text-md">
                  <option value="BTREE">BTREE</option>
                  <option value="HNSW">HNSW (vector)</option>
                  <option value="FULLTEXT">FULLTEXT (text)</option>
                </select>
                <button
                  className="h-8 rounded-md bg-brand px-3 text-md text-brand-text-on hover:bg-brand-hover disabled:opacity-45"
                  onClick={createIndex}
                  disabled={busy}
                >
                  Create
                </button>
              </div>
            </section>
          </div>

          {error && <p className="m-0 bg-error-subtle px-4 py-2 text-sm text-error">{error}</p>}

          <DialogFooter className="border-t border-border px-4 py-3">
            <button
              className="h-8 rounded-md border border-error/35 bg-error-subtle px-3 text-md text-error hover:brightness-110 disabled:opacity-45"
              onClick={() => setDropConfirm({ kind: 'table', name: table.name })}
              disabled={busy}
            >
              Drop table
            </button>
            <span className="flex-1" />
            <button className="h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong" onClick={onClose}>
              Close
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!dropConfirm} onOpenChange={(open) => !open && setDropConfirm(null)}>
        <DialogContent className="max-w-[420px] p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>{dropConfirm?.kind === 'table' ? 'Drop table' : 'Drop column'}</DialogTitle>
          </DialogHeader>
          <div className="p-4">
            <p className="m-0 text-md leading-relaxed">
              {dropConfirm?.kind === 'table' ? (
                <>
                  This will permanently drop table <code className="rounded-sm border border-border bg-secondary px-1 font-mono text-sm">{dropConfirm?.name}</code>. This
                  cannot be undone.
                </>
              ) : (
                <>
                  This will permanently drop column <code className="rounded-sm border border-border bg-secondary px-1 font-mono text-sm">{dropConfirm?.name}</code> from{' '}
                  <code className="rounded-sm border border-border bg-secondary px-1 font-mono text-sm">{table.name}</code>. This cannot be undone.
                </>
              )}
            </p>
          </div>
          <DialogFooter className="border-t border-border px-4 py-3">
            <button className="h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong" onClick={() => setDropConfirm(null)}>
              Cancel
            </button>
            <button
              className="h-8 rounded-md bg-error px-3 text-md font-semibold text-background hover:brightness-110 disabled:opacity-45"
              onClick={confirmDrop}
              disabled={busy}
            >
              Drop
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
