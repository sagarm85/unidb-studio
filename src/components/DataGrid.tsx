import { useState } from 'react';
import { formatCell, fullCellText, isNull } from '@/lib/engine/format.js';
import { rowsToCsv, downloadText } from '@/lib/engine/csv.js';
import { cn } from '@/lib/utils';

// Shared grid for both the SQL editor's results and the record browser.
// `columns` is an optional fallback for servers that predate the /sql column enrichment;
// `columnTypes` (parallel to the resolved headers) lets a caller that knows
// the schema (the record browser) render vectors compactly and show the type
// in the header. `onRowAction` adds a leading per-row button (record browser's
// "Find similar" NEAR search). `onCellEdit`/`onRowDelete` turn the grid into
// an editor — the SQL editor passes neither, so it stays read-only.

export interface DataGridResult {
  type: string;
  rows?: unknown[][];
  columns?: string[];
  count?: number;
}

export interface HeaderMeta {
  isPk?: boolean;
  isFk?: boolean;
}

export interface SortState {
  col: string;
  dir: 'asc' | 'desc';
}

const ROW_DISPLAY_CAP = 1000;

const AFFECTED_VERB: Record<string, string> = {
  inserted: 'inserted',
  updated: 'updated',
  deleted: 'deleted',
  truncated: 'truncated',
};

const DDL_MESSAGE: Record<string, string> = {
  created_table: 'Table created.',
  created_index: 'Index created.',
  altered_table: 'Table altered.',
  dropped_table: 'Table dropped.',
};

const isNumericType = (t: string | null | undefined) =>
  /^(int|integer|bigint|smallint|float|double|real|decimal|numeric)/i.test(t ?? '');

export function DataGrid({
  result,
  columns = null,
  columnTypes = null,
  onRowAction = null,
  rowActionIcon = '⌕',
  rowActionTitle = 'Action',
  onCellEdit = null,
  onRowDelete = null,
  onSort = null,
  sortState = null,
  headerMeta = null,
}: {
  result: DataGridResult | null | undefined;
  columns?: string[] | null;
  columnTypes?: (string | null)[] | null;
  onRowAction?: ((row: unknown[], rowIndex: number) => void) | null;
  rowActionIcon?: string;
  rowActionTitle?: string;
  onCellEdit?: ((rowIndex: number, column: string, raw: string) => void) | null;
  onRowDelete?: ((row: unknown[], rowIndex: number) => void) | null;
  onSort?: ((col: string) => void) | null;
  sortState?: SortState | null;
  headerMeta?: (HeaderMeta | null)[] | null;
}) {
  const [editing, setEditing] = useState<{ ri: number; ci: number } | null>(null);
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const hasRowCol = !!onRowAction || !!onRowDelete;
  const editable = !!onCellEdit;
  const metaAt = (ci: number) => headerMeta?.[ci] ?? null;
  const typeAt = (ci: number) => columnTypes?.[ci] ?? null;
  const sortCaret = (h: string) => (sortState?.col === h ? (sortState.dir === 'asc' ? ' ↑' : ' ↓') : '');

  if (result?.type === 'rows') {
    const rows = result.rows ?? [];
    if (rows.length === 0) {
      return <p className="text-sm text-text-light">0 rows.</p>;
    }

    const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const displayRows = rows.slice(0, ROW_DISPLAY_CAP);
    const truncated = rows.length > ROW_DISPLAY_CAP;
    const headers =
      result.columns?.length ? result.columns : columns?.length ? columns : Array.from({ length: colCount }, (_, i) => `col ${i}`);

    function startEdit(ri: number, ci: number, v: unknown) {
      if (!editable) return;
      setEditing({ ri, ci });
      setDraft(v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    function commitEdit() {
      if (!editing) return;
      const { ri, ci } = editing;
      setEditing(null);
      onCellEdit?.(ri, headers[ci], draft);
    }
    function cancelEdit() {
      setEditing(null);
    }
    async function copyCell(ri: number, ci: number, value: unknown) {
      try {
        await navigator.clipboard.writeText(fullCellText(value));
        const key = `${ri}:${ci}`;
        setCopied(key);
        setTimeout(() => setCopied((c) => (c === key ? null : c)), 1000);
      } catch {
        setCopied(null);
      }
    }
    function exportCsv() {
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      downloadText(`unidb-export-${ts}.csv`, rowsToCsv(headers, rows));
    }

    return (
      <div className="flex flex-col gap-2">
        <div className="max-h-[55vh] overflow-auto rounded-md border border-border">
          <table className="w-full border-collapse font-mono text-sm">
            <thead>
              <tr>
                {hasRowCol && <th className="sticky top-0 z-1 w-px border-b border-border-strong bg-panel" aria-hidden="true" />}
                <th className="sticky top-0 z-1 border-b border-border-strong bg-panel px-3 py-2 text-right font-sans text-xs font-semibold tracking-wide text-text-muted uppercase">
                  #
                </th>
                {headers.map((h, ci) => (
                  <th
                    key={h + ci}
                    className={cn(
                      'sticky top-0 z-1 border-b border-border-strong bg-panel px-3 py-2 text-left font-sans text-xs font-semibold tracking-wide text-text-muted uppercase',
                      onSort && 'cursor-pointer select-none hover:bg-secondary',
                      isNumericType(typeAt(ci)) && 'text-right',
                    )}
                    onClick={() => onSort?.(h)}
                  >
                    <span className="block normal-case">
                      {metaAt(ci)?.isPk && (
                        <span className="mr-0.5 text-[10px]" title="primary key">
                          🔑
                        </span>
                      )}
                      {metaAt(ci)?.isFk && (
                        <span className="mr-0.5 text-[10px]" title="foreign key">
                          🔗
                        </span>
                      )}
                      {h}
                      {sortCaret(h)}
                    </span>
                    {typeAt(ci) && <span className="mt-0.5 block font-mono text-[10px] font-normal text-text-muted">{typeAt(ci)}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row, ri) => (
                <tr key={ri} className="hover:bg-secondary">
                  {hasRowCol && (
                    <td className="w-px border-b border-border-muted px-2 py-1">
                      {onRowAction && (
                        <button
                          className="mr-1 inline-flex items-center justify-center rounded-md border border-border px-1.5 py-0.5 text-sm text-text-muted hover:border-brand hover:text-brand"
                          title={rowActionTitle}
                          onClick={() => onRowAction(row, ri)}
                        >
                          {rowActionIcon}
                        </button>
                      )}
                      {onRowDelete && (
                        <button
                          className="inline-flex items-center justify-center rounded-md border border-border px-1.5 py-0.5 text-sm text-text-muted hover:border-error hover:text-error"
                          title="Delete row"
                          onClick={() => onRowDelete(row, ri)}
                        >
                          ✕
                        </button>
                      )}
                    </td>
                  )}
                  <td className="border-b border-border-muted px-3 text-right text-text-muted tabular-nums" style={{ height: 32 }}>
                    {ri + 1}
                  </td>
                  {headers.map((_, ci) => {
                    const v = row[ci];
                    if (editing?.ri === ri && editing?.ci === ci) {
                      return (
                        <td key={ci} className="border-b border-border-muted px-1 py-0.5">
                          <input
                            autoFocus
                            className="w-full min-w-[90px] rounded-sm border border-border-strong bg-secondary px-1.5 py-0.5 font-mono text-sm text-foreground shadow-[var(--focus-ring)] outline-none"
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onFocus={(e) => e.currentTarget.select()}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                commitEdit();
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                cancelEdit();
                              }
                            }}
                            onBlur={commitEdit}
                            spellCheck={false}
                          />
                        </td>
                      );
                    }
                    const key = `${ri}:${ci}`;
                    const isNullVal = isNull(v);
                    return (
                      <td
                        key={ci}
                        className={cn(
                          'relative border-b border-border-muted px-3 whitespace-nowrap',
                          isNullVal ? 'cursor-default text-text-muted italic' : editable ? 'cursor-text' : 'cursor-default',
                          copied === key && 'bg-brand-subtle',
                          isNumericType(typeAt(ci)) && 'text-right',
                        )}
                        style={{ height: 32 }}
                        title={editable ? 'Click to edit' : isNullVal ? 'NULL' : `${fullCellText(v)}\n\n(click to copy)`}
                        onClick={() => (editable ? startEdit(ri, ci, v) : !isNullVal && copyCell(ri, ci, v))}
                      >
                        <span className="inline-block max-w-[340px] overflow-hidden align-bottom text-ellipsis whitespace-nowrap">
                          {formatCell(v, typeAt(ci) as any)}
                        </span>
                        {copied === key && (
                          <span className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-full bg-panel px-1.5 text-[10px] font-semibold text-brand">
                            copied ✓
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {truncated && (
          <p className="m-0 flex items-center gap-1.5 rounded-md border border-warn/30 bg-warn-subtle px-2.5 py-1.5 font-sans text-sm text-warn">
            Showing first {ROW_DISPLAY_CAP.toLocaleString()} of {rows.length.toLocaleString()} rows —{' '}
            <button className="rounded-sm border border-border px-1.5 py-0 text-xs hover:border-border-strong" onClick={exportCsv}>
              Export CSV
            </button>{' '}
            to get all rows.
          </p>
        )}

        <p className="m-0 flex items-center gap-3 font-sans">
          <span className="text-sm text-text-light">
            {rows.length.toLocaleString()} row{rows.length === 1 ? '' : 's'}
          </span>
          <button
            className="rounded-md border border-border px-2 py-0.5 text-xs hover:border-border-strong hover:text-brand"
            onClick={exportCsv}
            title="Download these rows as CSV"
          >
            Export CSV
          </button>
        </p>
      </div>
    );
  }

  if (result?.type && AFFECTED_VERB[result.type]) {
    return (
      <p className="font-medium text-brand">
        {result.count} row{result.count === 1 ? '' : 's'} {AFFECTED_VERB[result.type]}.
      </p>
    );
  }

  if (result?.type && DDL_MESSAGE[result.type]) {
    return <p className="font-medium text-brand">{DDL_MESSAGE[result.type]}</p>;
  }

  return <p className="text-sm text-text-light">{result?.type ?? 'unknown result'}</p>;
}
