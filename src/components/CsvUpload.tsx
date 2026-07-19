import { useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { runSql } from '@/lib/engine/api.js';
import { parseCsv } from '@/lib/engine/csv.js';
import { quoteIdent } from '@/lib/engine/format.js';
import { ErrorBox } from './ErrorBox';
import type { CatalogTable, CatalogError } from '@/hooks/useCatalog';
import { cn } from '@/lib/utils';

interface DoneStats {
  inserted: number;
  wallMs: number;
  rowsPerSec: number;
}

// A SQL literal for a cell: empty string -> NULL, otherwise a single-quoted
// string (quotes doubled). The engine coerces the string to each column's
// real type. Values are quoted, not bound as params, because batching here
// means many `;`-separated statements in ONE /sql body (the documented way
// to run them in a single transaction), and $n numbering across statements
// isn't part of the documented contract.
function lit(v: string | null | undefined) {
  if (v === '' || v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function buildBatch(tableName: string, cols: string[], batchRows: string[][]) {
  const t = quoteIdent(tableName);
  const colList = cols.map(quoteIdent).join(', ');
  return batchRows.map((r) => `INSERT INTO ${t} (${colList}) VALUES (${cols.map((_, i) => lit(r[i])).join(', ')})`).join('; ');
}

export function CsvUpload({ tables = [] }: { tables?: CatalogTable[] }) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [targetTable, setTargetTable] = useState('');
  const [batchSize, setBatchSize] = useState(100);

  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<CatalogError | null>(null);
  const [done, setDone] = useState<DoneStats | null>(null);
  const [progress, setProgress] = useState(0);
  const [parseError, setParseError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  async function handleFile(file: File | undefined | null) {
    setError(null);
    setDone(null);
    setParseError(null);
    if (!file) return;
    setFileName(file.name);
    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      setHeaders(parsed.headers);
      setRows(parsed.rows);
      setTargetTable((t) => t || file.name.replace(/\.[^.]+$/, ''));
    } catch (err: any) {
      setParseError(`Could not parse CSV: ${err?.message}`);
      setHeaders([]);
      setRows([]);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    handleFile(e.dataTransfer?.files?.[0]);
  }

  async function runImport() {
    if (!targetTable || !rows.length) return;
    setImporting(true);
    setError(null);
    setDone(null);
    setProgress(0);

    let inserted = 0;
    const size = Math.max(1, Number(batchSize) || 1);
    const start = performance.now();

    try {
      for (let i = 0; i < rows.length; i += size) {
        const batch = rows.slice(i, i + size);
        const sql = buildBatch(targetTable, headers, batch);
        const { results } = await runSql(sql);
        for (const r of results) if (r.type === 'inserted') inserted += r.count ?? 0;
        setProgress(Math.min(i + size, rows.length));
      }
      const wallMs = performance.now() - start;
      setDone({ inserted, wallMs, rowsPerSec: wallMs > 0 ? (inserted / wallMs) * 1000 : 0 });
    } catch (e: any) {
      setError({
        code: e?.code,
        message: `${e?.message} (imported ${inserted} of ${rows.length} rows before this batch failed & rolled back)`,
        status: e?.status,
      });
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label
        className={cn(
          'relative flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-strong bg-card px-4 py-8 text-center transition-colors',
          'cursor-pointer hover:border-brand hover:bg-brand-subtle',
          dragOver && 'border-brand bg-brand-subtle',
          fileName && 'py-4',
        )}
        onDrop={onDrop}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => handleFile(e.target.files?.[0])}
          className="absolute h-px w-px opacity-0"
        />
        <Upload className={cn('size-6 text-text-muted', dragOver && 'text-brand')} />
        <span className="text-sm text-text-light">
          {fileName ? `${fileName} · ${rows.length.toLocaleString()} rows` : 'Drop a CSV file here, or click to browse'}
        </span>
      </label>

      {parseError && <p className="text-md text-error">{parseError}</p>}

      {headers.length > 0 && (
        <>
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1 text-sm text-text-light">
              target table
              <input
                list="tablenames"
                value={targetTable}
                onChange={(e) => setTargetTable(e.target.value)}
                placeholder="table name"
                className="h-8 w-56 rounded-md border border-border bg-secondary px-2 font-mono text-md outline-none focus-visible:border-border-strong focus-visible:ring-[2px] focus-visible:ring-ring/40"
              />
              <datalist id="tablenames">
                {tables.map((t) => (
                  <option key={t.name} value={t.name} />
                ))}
              </datalist>
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-light">
              batch size
              <input
                type="number"
                min={1}
                value={batchSize}
                onChange={(e) => setBatchSize(Number(e.target.value))}
                className="h-8 w-[90px] rounded-md border border-border bg-secondary px-2 font-mono text-md outline-none focus-visible:border-border-strong focus-visible:ring-[2px] focus-visible:ring-ring/40"
              />
            </label>
            <button
              className="h-8 rounded-md bg-brand px-4 text-md font-medium text-brand-text-on hover:bg-brand-hover disabled:opacity-45"
              onClick={runImport}
              disabled={importing || !targetTable}
            >
              {importing ? `Importing… ${progress}/${rows.length}` : 'Import'}
            </button>
          </div>

          {importing && (
            <div className="h-1 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full bg-brand transition-[width]"
                style={{ width: `${rows.length ? (progress / rows.length) * 100 : 0}%` }}
              />
            </div>
          )}

          <div className="flex flex-col gap-2">
            <div className="text-xs font-semibold tracking-wide text-text-muted uppercase">Mapping preview</div>
            <div className="max-h-56 overflow-auto rounded-md border border-border">
              <table className="w-full border-collapse font-mono text-sm">
                <thead>
                  <tr>
                    {headers.map((h) => (
                      <th
                        key={h}
                        className="sticky top-0 border-b border-border-strong bg-card px-3 py-1 text-left font-sans text-xs font-semibold tracking-wide text-text-muted uppercase"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 5).map((r, ri) => (
                    <tr key={ri}>
                      {r.map((cell, ci) => (
                        <td key={ci} className="h-7 border-b border-border-muted px-3 text-foreground">
                          {cell === '' ? '—' : cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > 5 && <div className="text-xs text-text-muted">+ {(rows.length - 5).toLocaleString()} more rows</div>}
          </div>
        </>
      )}

      <ErrorBox error={error} />

      {done && (
        <div className="flex gap-6 rounded-md border border-border bg-card px-3.5 py-3 text-md">
          <div>
            <b className="text-brand">{done.inserted}</b> rows inserted
          </div>
          <div>
            wall-clock: <b className="text-brand">{done.wallMs.toFixed(1)} ms</b>
          </div>
          <div>
            throughput: <b className="text-brand">{done.rowsPerSec.toFixed(0)} rows/sec</b>
          </div>
        </div>
      )}

      <p className="m-0 text-xs text-text-muted">
        Per-row <code>INSERT</code> batched into one transaction per request — there is no bulk <code>COPY</code>. Use demo-sized
        files.
      </p>
    </div>
  );
}
