import { useMemo, useState } from 'react';
import { Search, Plus, RefreshCw, MoreVertical, ChevronLeft, ChevronRight } from 'lucide-react';
import type { CatalogTable, CatalogError } from '@/hooks/useCatalog';
import { columnSummary } from '@/lib/engine/format.js';
import { EmptyState } from './EmptyState';
import { Skeleton } from './ui/skeleton';
import { cn } from '@/lib/utils';

// Per DESIGN_SPEC §3.4. Presentational — App owns the catalog fetch (useCatalog)
// and passes state in. DDL callbacks (New table / Manage) only render when
// `canDDL` (a live catalog). Search: name matches win; only when NO table name
// matches do we fall back to column-name matches (so "email" still finds the
// table that has that column).
export function TablesSidebar({
  tables,
  loading,
  error,
  supported,
  selected,
  canDDL,
  onSelect,
  onRefresh,
  onNewTable,
  onManageTable,
}: {
  tables: CatalogTable[];
  loading: boolean;
  error: CatalogError | null;
  supported: boolean;
  selected: string | null | undefined;
  canDDL: boolean;
  onSelect: (t: CatalogTable) => void;
  onRefresh: () => void;
  onNewTable: () => void;
  onManageTable: (t: CatalogTable) => void;
}) {
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tables;
    const byName = tables.filter((t) => t.name.toLowerCase().includes(q));
    if (byName.length) return byName;
    return tables.filter((t) => (t.columns ?? []).some((c) => c.name.toLowerCase().includes(q)));
  }, [tables, query]);

  if (!open) {
    return (
      <aside className="flex w-9 shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex justify-center border-b border-border p-1">
          <button
            className="flex size-6 items-center justify-center rounded-sm border border-border text-text-light hover:border-border-strong hover:text-foreground"
            onClick={() => setOpen(true)}
            title="Expand sidebar"
            aria-label="Expand sidebar"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col overflow-hidden border-r border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="flex-1 text-xs font-semibold tracking-wide text-text-muted uppercase">Tables</span>
        <span className="rounded-sm bg-secondary px-1.5 text-xs leading-4 text-text-muted">{tables.length}</span>
        <button
          className="flex size-[22px] items-center justify-center rounded-sm text-text-light hover:bg-accent hover:text-foreground disabled:opacity-45"
          onClick={onRefresh}
          disabled={loading}
          title="Reload tables"
          aria-label="Reload tables"
        >
          <RefreshCw className="size-3.5" />
        </button>
        <button
          className="flex size-6 items-center justify-center rounded-sm border border-border text-text-light hover:border-border-strong hover:text-foreground"
          onClick={() => setOpen(false)}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
        >
          <ChevronLeft className="size-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {canDDL && (
          <button
            className="mb-2 flex h-[26px] w-full items-center justify-center gap-1 rounded-md border border-dashed border-border-strong text-sm font-medium text-brand hover:border-brand hover:bg-brand-subtle"
            onClick={onNewTable}
          >
            <Plus className="size-3.5" /> New table
          </button>
        )}

        {supported && tables.length > 0 && (
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-text-muted" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tables…"
              aria-label="Search tables"
              className="h-8 w-full rounded-md border border-border bg-secondary pr-2 pl-7 text-sm outline-none placeholder:text-text-muted focus-visible:border-border-strong focus-visible:ring-[2px] focus-visible:ring-ring/40"
            />
          </div>
        )}

        {loading ? (
          <div className="flex flex-col gap-1">
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-full" />
          </div>
        ) : error ? (
          <EmptyState message={`${error.code}: ${error.message}`} />
        ) : !supported ? (
          <EmptyState message="GET /tables not available on this server yet. Use the SQL editor to query directly." />
        ) : tables.length === 0 ? (
          <EmptyState message="No tables. Create one in the SQL editor." />
        ) : filtered.length === 0 ? (
          <EmptyState message={`No tables match "${query}".`} />
        ) : (
          <ul className="flex flex-col gap-px">
            {filtered.map((t) => {
              const isSelected = selected === t.name;
              return (
                <li
                  key={t.name}
                  className={cn('group relative flex items-stretch rounded-md', isSelected && 'bg-selected')}
                >
                  {isSelected && <span className="absolute top-0.5 bottom-0.5 left-0 w-0.5 rounded-full bg-brand" />}
                  <button
                    className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left hover:bg-accent"
                    onClick={() => onSelect(t)}
                  >
                    <span className="truncate font-mono text-sm">{t.name}</span>
                    <span className="ml-auto max-w-[40%] truncate font-mono text-xs text-text-muted">
                      {columnSummary(t.columns)}
                    </span>
                  </button>
                  {canDDL && (
                    <button
                      className={cn(
                        'flex w-6 shrink-0 items-center justify-center text-text-muted opacity-0 group-hover:opacity-100 hover:text-foreground',
                        isSelected && 'opacity-100',
                      )}
                      title={`Manage ${t.name}`}
                      aria-label={`Manage ${t.name}`}
                      onClick={() => onManageTable(t)}
                    >
                      <MoreVertical className="size-3.5" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
