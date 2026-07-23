import { useState } from 'react';
import { quoteIdent } from '@/lib/engine/format.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog';

interface ColumnDraft {
  name: string;
  type: string;
  notNull: boolean;
  pk: boolean;
}

const TYPES = ['INT', 'BIGINT', 'TEXT', 'BOOL', 'FLOAT', 'DOUBLE', 'DECIMAL(10,2)', 'TIMESTAMP', 'DATE', 'TIME', 'UUID', 'JSON', 'BYTEA', 'VECTOR(4)'];

function buildSql(name: string, cols: ColumnDraft[]): string {
  const tbl = name.trim();
  if (!tbl) throw new Error('table name is required');
  const defs: string[] = [];
  const pks: string[] = [];
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

// Modal to build a CREATE TABLE statement. `onSubmit(sql)` runs it; `onClose`
// dismisses. Types are free text (with a datalist of common ones) so
// parameterized types like VECTOR(4) / DECIMAL(10,2) just work.
export function TableBuilder({ onSubmit, onClose }: { onSubmit: (sql: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState('');
  const [cols, setCols] = useState<ColumnDraft[]>([{ name: 'id', type: 'INT', notNull: true, pk: true }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function addCol() {
    setCols((c) => [...c, { name: '', type: 'TEXT', notNull: false, pk: false }]);
  }
  function removeCol(i: number) {
    setCols((c) => c.filter((_, idx) => idx !== i));
  }
  function updateCol(i: number, patch: Partial<ColumnDraft>) {
    setCols((c) => c.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  }

  async function submit() {
    setError(null);
    let sql: string;
    try {
      sql = buildSql(name, cols);
    } catch (e: any) {
      setError(e.message);
      return;
    }
    setBusy(true);
    try {
      await onSubmit(sql);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[84vh] max-w-[560px] flex-col overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle>New table</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 overflow-auto p-4">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-semibold">Table name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. customers"
              spellCheck={false}
              className="h-8 rounded-md border border-border bg-secondary px-2 font-mono text-md outline-none focus-visible:border-border-strong focus-visible:ring-[2px] focus-visible:ring-ring/40"
            />
          </label>

          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-[1fr_1fr_28px_28px_24px] items-center gap-2 text-center text-xs font-semibold text-text-muted">
              <span className="text-left">Column</span>
              <span className="text-left">Type</span>
              <span title="NOT NULL">NN</span>
              <span title="Primary key">PK</span>
              <span />
            </div>
            {cols.map((c, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_28px_28px_24px] items-center gap-2">
                <input
                  value={c.name}
                  onChange={(e) => updateCol(i, { name: e.target.value })}
                  placeholder="name"
                  spellCheck={false}
                  className="h-8 rounded-md border border-border bg-secondary px-2 font-mono text-md outline-none focus-visible:border-border-strong focus-visible:ring-[2px] focus-visible:ring-ring/40"
                />
                <div className="flex min-w-0 flex-col gap-1">
                  <select
                    value={TYPES.includes(c.type) ? c.type : '__custom__'}
                    onChange={(e) => {
                      if (e.target.value !== '__custom__') updateCol(i, { type: e.target.value });
                    }}
                    className="h-8 w-full rounded-md border border-border bg-secondary px-2 font-mono text-md"
                  >
                    {TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                    {!TYPES.includes(c.type) && <option value="__custom__">{c.type}</option>}
                  </select>
                  {!TYPES.includes(c.type) && (
                    <input
                      value={c.type}
                      onChange={(e) => updateCol(i, { type: e.target.value })}
                      placeholder="custom type"
                      spellCheck={false}
                      className="h-[26px] rounded-md border border-brand bg-secondary px-2 font-mono text-sm outline-none"
                    />
                  )}
                </div>
                <input type="checkbox" checked={c.notNull} onChange={(e) => updateCol(i, { notNull: e.target.checked })} aria-label="NOT NULL" className="justify-self-center" />
                <input type="checkbox" checked={c.pk} onChange={(e) => updateCol(i, { pk: e.target.checked })} aria-label="Primary key" className="justify-self-center" />
                <button className="text-text-muted hover:text-error" title="Remove column" onClick={() => removeCol(i)}>
                  ✕
                </button>
              </div>
            ))}
            <button
              className="h-[26px] self-start rounded-md border border-border bg-secondary px-3 text-sm hover:border-border-strong"
              onClick={addCol}
            >
              + Add column
            </button>
          </div>
        </div>

        {error && <p className="m-0 bg-error-subtle px-4 py-2 text-sm text-error">{error}</p>}

        <DialogFooter className="border-t border-border px-4 py-3">
          <button className="h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong" onClick={onClose}>
            Cancel
          </button>
          <button
            className="h-8 rounded-md bg-brand px-3 text-md text-brand-text-on hover:bg-brand-hover disabled:opacity-45"
            onClick={submit}
            disabled={busy}
          >
            {busy ? 'Creating…' : 'Create table'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
