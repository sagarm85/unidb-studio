import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Minus, Plus, MoreVertical } from 'lucide-react';
import { getSchema } from '@/lib/engine/api.js';
import {
  DEMO_SCHEMA,
  inferRelationships,
  primaryKeyOf,
  tableDDL,
  gridLayout,
  columnAnchorY,
  nodeHeight,
  NODE_WIDTH,
} from '@/lib/engine/schema.js';
import { isVectorType } from '@/lib/engine/format.js';
import { ErrorBox } from './ErrorBox';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from './ui/dropdown-menu';
import type { CatalogTable, CatalogRelationship, CatalogError } from '@/hooks/useCatalog';
import { cn } from '@/lib/utils';

interface Position {
  x: number;
  y: number;
}
interface Edge {
  key: string;
  path: string;
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  inferred: boolean;
}
interface Schema {
  tables: CatalogTable[];
  relationships: CatalogRelationship[];
  source: 'server' | 'inferred' | 'demo';
}

export function SchemaVisualizer({ tables = [] }: { tables?: CatalogTable[] }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CatalogError | null>(null);
  const [schema, setSchema] = useState<Schema>({ tables: [], relationships: [], source: 'server' });
  const [positions, setPositions] = useState<Record<string, Position>>({});
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const [ddlView, setDdlView] = useState<{ table: string; sql: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const s = await getSchema();
      let next: Schema;
      if (s.supported) {
        next = { tables: s.tables, relationships: s.relationships, source: 'server' };
      } else if (tables.length) {
        next = { tables, relationships: inferRelationships(tables), source: 'inferred' };
      } else {
        next = { tables: DEMO_SCHEMA.tables, relationships: DEMO_SCHEMA.relationships, source: 'demo' };
      }
      setSchema(next);
      setPositions(gridLayout(next.tables));
      setPan({ x: 0, y: 0 });
      setZoom(1);
    } catch (e: any) {
      setError({ code: e?.code, message: e?.message ?? String(e), status: e?.status });
    } finally {
      setLoading(false);
    }
  }

  // Re-run when App reloads the catalog.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables]);

  const tableByName = new Map(schema.tables.map((t) => [t.name, t]));
  const pkByTable = new Map(schema.tables.map((t) => [t.name, primaryKeyOf(t)]));
  const fkCols = new Set(schema.relationships.flatMap((r) => r.fromColumns.map((c) => `${r.fromTable}.${c}`)));

  const edges: Edge[] = [];
  for (const r of schema.relationships) {
    const from = tableByName.get(r.fromTable);
    const to = tableByName.get(r.toTable);
    const pf = positions[r.fromTable];
    const pt = positions[r.toTable];
    if (!from || !to || !pf || !pt) continue;

    const fy = pf.y + columnAnchorY(from, r.fromColumns[0]);
    const ty = pt.y + columnAnchorY(to, r.toColumns[0]);
    const fromLeft = pf.x + NODE_WIDTH / 2 <= pt.x + NODE_WIDTH / 2;
    const fx = fromLeft ? pf.x + NODE_WIDTH : pf.x;
    const tx = fromLeft ? pt.x : pt.x + NODE_WIDTH;
    const d = Math.max(40, Math.abs(tx - fx) / 2);
    const c1 = fromLeft ? fx + d : fx - d;
    const c2 = fromLeft ? tx - d : tx + d;
    edges.push({ key: r.name, path: `M ${fx} ${fy} C ${c1} ${fy}, ${c2} ${ty}, ${tx} ${ty}`, fx, fy, tx, ty, inferred: !!r.inferred });
  }

  let boundsW = 800;
  let boundsH = 500;
  for (const t of schema.tables) {
    const p = positions[t.name];
    if (!p) continue;
    boundsW = Math.max(boundsW, p.x + NODE_WIDTH + 80);
    boundsH = Math.max(boundsH, p.y + nodeHeight(t) + 80);
  }

  // ---- drag (nodes) + pan (background) --------------------------------------
  const dragState = useRef<{ type: 'node' | 'pan'; name?: string; startX: number; startY: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const d = dragState.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (d.type === 'node' && d.name) {
        setPositions((prev) => ({ ...prev, [d.name!]: { x: d.ox + dx / zoom, y: d.oy + dy / zoom } }));
      } else {
        setPan({ x: d.ox + dx, y: d.oy + dy });
      }
    }
    function onUp() {
      dragState.current = null;
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [zoom]);

  function onNodeDown(e: React.PointerEvent, name: string) {
    e.stopPropagation();
    const p = positions[name];
    dragState.current = { type: 'node', name, startX: e.clientX, startY: e.clientY, ox: p.x, oy: p.y };
  }
  function onBgDown(e: React.PointerEvent) {
    dragState.current = { type: 'pan', startX: e.clientX, startY: e.clientY, ox: pan.x, oy: pan.y };
  }
  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    setZoom((z) => Math.min(2, Math.max(0.3, z - e.deltaY * 0.0015)));
  }
  function zoomBy(f: number) {
    setZoom((z) => Math.min(2, Math.max(0.3, z * f)));
  }
  function resetView() {
    setPositions(gridLayout(schema.tables));
    setPan({ x: 0, y: 0 });
    setZoom(1);
  }

  // A table's DDL is always reconstructed from catalog metadata — the engine
  // stores no CREATE text.
  function ddlFor(table: CatalogTable) {
    return (table as any).ddl ?? tableDDL(table);
  }
  function openDdl(name: string) {
    const t = tableByName.get(name);
    if (t) setDdlView({ table: name, sql: ddlFor(t) });
    setCopied(false);
  }
  async function copyDdl(sql: string) {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  const banner =
    schema.source === 'demo'
      ? 'Demo schema — the server reported no tables. This is illustrative sample data.'
      : schema.source === 'inferred'
        ? 'Relationships inferred from column names (e.g. user_id → users.id) — the engine catalog (information_schema) isn’t available on this server. Real foreign keys replace these once it is.'
        : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <strong className="text-lg font-medium text-foreground">Schema</strong>
          <span className="text-sm text-text-light">
            {schema.tables.length} tables · {schema.relationships.length} relationships
          </span>
          <span
            className={cn(
              'rounded-sm px-1.5 py-0.5 text-[10px] font-bold tracking-wide uppercase',
              schema.source === 'server' && 'bg-brand-subtle text-brand',
              schema.source === 'inferred' && 'bg-warn-subtle text-warn',
              schema.source === 'demo' && 'bg-secondary text-text-muted',
            )}
          >
            {schema.source}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button className="h-[26px] rounded-md border border-border bg-secondary px-2 text-sm hover:border-border-strong" onClick={resetView} title="Reset layout">
            Reset
          </button>
          <button
            className="flex h-[26px] items-center justify-center rounded-md border border-border bg-secondary px-2 text-sm hover:border-border-strong disabled:opacity-45"
            onClick={load}
            disabled={loading}
            title="Reload schema"
          >
            <RefreshCw className="size-3.5" />
          </button>
        </div>
      </div>

      {banner && <p className="m-0 mb-2 rounded-md border border-warn/30 bg-warn-subtle px-2.5 py-1.5 text-sm text-foreground">{banner}</p>}

      {loading ? (
        <p className="p-0.5 text-sm text-text-light">Loading schema…</p>
      ) : error ? (
        <div className="p-0.5">
          <ErrorBox error={error} />
        </div>
      ) : schema.tables.length === 0 ? (
        <p className="p-0.5 text-sm text-text-light">No tables to visualize.</p>
      ) : (
        <div
          className="relative min-h-0 flex-1 cursor-grab overflow-hidden rounded-lg border border-border bg-background active:cursor-grabbing"
          style={{ backgroundImage: 'radial-gradient(circle, var(--border-muted) 1px, transparent 1px)', backgroundSize: '22px 22px' }}
          onWheel={onWheel}
        >
          <div
            className="absolute top-0 left-0 origin-top-left"
            onPointerDown={onBgDown}
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
          >
            <div className="relative" style={{ width: boundsW, height: boundsH }}>
              <svg width={boundsW} height={boundsH} className="pointer-events-none absolute top-0 left-0 overflow-visible">
                <defs>
                  <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0,0 L8,4 L0,8 z" fill="var(--text-muted)" />
                  </marker>
                </defs>
                {edges.map((e) => (
                  <g key={e.key}>
                    <path
                      d={e.path}
                      fill="none"
                      stroke="var(--text-muted)"
                      strokeWidth={1.5}
                      strokeDasharray={e.inferred ? '5 4' : undefined}
                      markerEnd="url(#arrow)"
                    />
                    <circle cx={e.fx} cy={e.fy} r={3} fill="var(--text-muted)" />
                  </g>
                ))}
              </svg>

              {schema.tables.map((t) => {
                const p = positions[t.name];
                if (!p) return null;
                return (
                  <div
                    key={t.name}
                    className="absolute cursor-grab overflow-hidden rounded-lg border border-border bg-card text-sm shadow-sm select-none active:cursor-grabbing"
                    style={{ left: p.x, top: p.y, width: NODE_WIDTH }}
                    onPointerDown={(e) => onNodeDown(e, t.name)}
                  >
                    <div className="flex h-[34px] items-center justify-between border-b border-border bg-secondary px-2.5">
                      <span className="font-bold text-foreground">{t.name}</span>
                      <span className="flex items-center gap-1">
                        <span className="rounded-full bg-card px-1.5 text-[10px] text-text-muted">{t.columns?.length ?? 0}</span>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              className="flex size-5 items-center justify-center rounded-sm text-text-muted hover:bg-accent hover:text-foreground"
                              title="Table actions"
                              aria-label={`Table actions for ${t.name}`}
                              onPointerDown={(e) => e.stopPropagation()}
                            >
                              <MoreVertical className="size-3.5" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openDdl(t.name)}>View DDL</DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => {
                                const tb = tableByName.get(t.name);
                                if (tb) copyDdl(ddlFor(tb));
                              }}
                            >
                              Copy DDL
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </span>
                    </div>
                    <div className="flex flex-col">
                      {(t.columns ?? []).map((c) => {
                        const isPk = pkByTable.get(t.name) === c.name;
                        const isFk = fkCols.has(`${t.name}.${c.name}`);
                        const isVec = isVectorType(c.type);
                        const isAnn = c.index === 'hnsw';
                        return (
                          <div
                            key={c.name}
                            className={cn('flex h-[26px] items-center gap-1.5 border-b border-border-muted px-2.5 last:border-b-0', (isPk || isFk) && 'bg-brand-subtle')}
                          >
                            <span className="inline-flex w-[58px] shrink-0 gap-0.5">
                              {isPk && (
                                <span className="rounded-sm bg-warn-subtle px-1 text-[9px] font-bold text-warn" title="primary key">
                                  PK
                                </span>
                              )}
                              {isFk && (
                                <span className="rounded-sm bg-info/15 px-1 text-[9px] font-bold text-info" title="foreign key">
                                  FK
                                </span>
                              )}
                              {isVec && (
                                <span className="rounded-sm bg-info/15 px-1 text-[9px] font-bold text-info" title="vector column">
                                  VEC
                                </span>
                              )}
                              {isAnn && (
                                <span className="rounded-sm bg-info px-1 text-[9px] font-bold text-background" title="ANN (HNSW) index">
                                  ANN
                                </span>
                              )}
                            </span>
                            <span className="flex-1 truncate font-mono text-foreground">{c.name}</span>
                            <span className="shrink-0 font-mono text-xs text-text-muted">{c.type ?? ''}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Zoom controls: icon-button cluster, bottom-right of the canvas (DESIGN_SPEC §6) */}
          <div className="absolute right-4 bottom-4 flex items-center gap-1 rounded-md border border-border bg-card p-1 shadow-[var(--shadow-overlay)]">
            <button className="flex size-[26px] items-center justify-center rounded-sm text-text-light hover:bg-accent hover:text-foreground" onClick={() => zoomBy(1 / 1.2)} title="Zoom out">
              <Minus className="size-3.5" />
            </button>
            <span className="w-9 text-center text-xs text-text-muted tabular-nums">{Math.round(zoom * 100)}%</span>
            <button className="flex size-[26px] items-center justify-center rounded-sm text-text-light hover:bg-accent hover:text-foreground" onClick={() => zoomBy(1.2)} title="Zoom in">
              <Plus className="size-3.5" />
            </button>
          </div>
        </div>
      )}

      <Dialog open={!!ddlView} onOpenChange={(open) => !open && setDdlView(null)}>
        <DialogContent className="max-w-[640px] p-0">
          <DialogHeader className="flex-row items-center justify-between space-y-0 border-b border-border px-4 py-3">
            <DialogTitle className="font-mono text-md">{ddlView?.table}</DialogTitle>
            <button
              className="h-[26px] rounded-md border border-border bg-secondary px-2 text-sm hover:border-border-strong"
              onClick={() => ddlView && copyDdl(ddlView.sql)}
            >
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
          </DialogHeader>
          <pre className="m-0 max-h-[60vh] overflow-auto p-3.5 font-mono text-sm leading-normal whitespace-pre text-foreground">{ddlView?.sql}</pre>
          <p className="m-0 border-t border-border bg-secondary px-3.5 py-2 text-xs text-text-muted">
            Reconstructed from catalog metadata — canonical, not the original CREATE text (unidb stores no DDL).
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
