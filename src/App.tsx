import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  LayoutDashboard,
  Table2,
  Terminal,
  Network,
  Upload,
  HardDrive,
  Zap,
  Activity,
  ScrollText,
  GitCompare,
  Sun,
  Moon,
  Palette,
  Shield,
} from 'lucide-react';
import { BASE_URL, IS_CONFIGURED, runSql } from '@/lib/engine/api.js';
import { quoteIdent } from '@/lib/engine/format.js';
import { useTheme } from '@/lib/theme.tsx';
import { useCatalog, type CatalogTable } from '@/hooks/useCatalog';
import { TokenStatus } from '@/components/TokenStatus';
import { EmptyState } from '@/components/EmptyState';
import { TablesSidebar } from '@/components/TablesSidebar';
import { SqlEditor } from '@/components/SqlEditor';
import { RecordBrowser } from '@/components/RecordBrowser';
import { SchemaVisualizer } from '@/components/SchemaVisualizer';
import { CsvUpload } from '@/components/CsvUpload';
import { TableBuilder } from '@/components/TableBuilder';
import { TableActions } from '@/components/TableActions';
import { StoragePanel } from '@/components/StoragePanel';
import { EventsPanel } from '@/components/EventsPanel';
import { ObservabilityPanel } from '@/components/ObservabilityPanel';
import { LogsPanel } from '@/components/LogsPanel';
import { ComparePanel } from '@/components/ComparePanel';
import { AuthPanel } from '@/components/AuthPanel';
import { Overview } from '@/screens/Overview';
import { Toaster } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';

type Tab =
  | 'overview'
  | 'sql'
  | 'records'
  | 'schema'
  | 'csv'
  | 'storage'
  | 'events'
  | 'auth'
  | 'observability'
  | 'logs'
  | 'compare';

const VALID_TABS = new Set<Tab>([
  'overview',
  'sql',
  'records',
  'schema',
  'csv',
  'storage',
  'events',
  'auth',
  'observability',
  'logs',
  'compare',
]);

const DATA_TABS = new Set<Tab>(['sql', 'records', 'schema', 'csv']);

interface NavItem {
  tab: Tab;
  label: string;
  icon: typeof LayoutDashboard;
}

const DATABASE_ITEMS: NavItem[] = [
  { tab: 'records', label: 'Table Editor', icon: Table2 },
  { tab: 'sql', label: 'SQL Editor', icon: Terminal },
  { tab: 'schema', label: 'Schema', icon: Network },
  { tab: 'csv', label: 'CSV Import', icon: Upload },
];

const PLATFORM_ITEMS: NavItem[] = [
  { tab: 'storage', label: 'Storage', icon: HardDrive },
  { tab: 'events', label: 'Events', icon: Zap },
  { tab: 'auth', label: 'Auth', icon: Shield },
];

const MONITOR_ITEMS: NavItem[] = [
  { tab: 'observability', label: 'Observability', icon: Activity },
  { tab: 'logs', label: 'Logs', icon: ScrollText },
  { tab: 'compare', label: 'Compare', icon: GitCompare },
];

function initialTab(): Tab {
  const urlTab = new URLSearchParams(window.location.search).get('tab') as Tab | null;
  return urlTab && VALID_TABS.has(urlTab) ? urlTab : 'overview';
}

export default function App() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const { theme, toggleTheme, accent, setAccent } = useTheme();
  const catalog = useCatalog();

  // Keep `?tab=` in sync so a reload/share lands on the same screen —
  // no router library, just history.replaceState (DESIGN_SPEC / plan Phase 1).
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tab);
    window.history.replaceState({}, '', url);
  }, [tab]);

  // A schema-read PERMISSION_DENIED (the current user just isn't grantted
  // information_schema/unidb_catalog access — expected for a non-superuser)
  // is not the same fact as the server being unreachable. Conflating them
  // as one "OFFLINE" badge is actively misleading: the server is fine, this
  // identity just can't see the catalog. Only a genuine transport/other
  // failure earns "OFFLINE".
  const connectionState: 'not-configured' | 'connecting' | 'offline' | 'restricted' | 'connected' = !IS_CONFIGURED
    ? 'not-configured'
    : catalog.tablesLoading
      ? 'connecting'
      : catalog.tablesError
        ? catalog.tablesError.code === 'PERMISSION_DENIED'
          ? 'restricted'
          : 'offline'
        : 'connected';

  function selectTable(t: CatalogTable) {
    catalog.setSelectedTable(t);
    setTab('records');
  }

  // ---- SQL editor state (lifted so RecordBrowser's "Open in SQL editor"
  // handoff and DDL modals can push a query / refresh from here). ----
  const [sql, setSql] = useState('SELECT 1;');
  const [paramsText, setParamsText] = useState('');

  function queryTableInEditor() {
    if (!catalog.selectedTable) return;
    setSql(`SELECT * FROM ${quoteIdent(catalog.selectedTable.name)} LIMIT 50;`);
    setParamsText('');
    setTab('sql');
  }

  // ---- DDL (schema management) ---------------------------------------------
  const [newTableOpen, setNewTableOpen] = useState(false);
  const [actionsTarget, setActionsTarget] = useState<CatalogTable | null>(null);

  // Heuristic label for the DDL success toast — every DDL success in the app
  // (new table, add/drop column, create index, drop table) funnels through
  // runDDL below, so this is the one place to surface it.
  function ddlSuccessLabel(sql: string): string {
    const s = sql.trim().toUpperCase();
    if (s.startsWith('CREATE TABLE')) return 'Table created';
    if (s.startsWith('DROP TABLE')) return 'Table dropped';
    if (/^ALTER TABLE .* ADD COLUMN/.test(s)) return 'Column added';
    if (/^ALTER TABLE .* DROP COLUMN/.test(s)) return 'Column dropped';
    if (s.startsWith('CREATE INDEX')) return 'Index created';
    return 'Done';
  }

  // Run a DDL statement, then refresh the catalog and re-point any open target.
  async function runDDL(ddlSql: string) {
    await runSql(ddlSql);
    await catalog.loadTables();
    toast.success(ddlSuccessLabel(ddlSql));
  }
  async function onNewTableSubmit(sqlText: string) {
    await runDDL(sqlText);
    setNewTableOpen(false);
  }
  function onTableDropped() {
    const dropped = actionsTarget?.name;
    setActionsTarget(null);
    if (catalog.selectedTable?.name === dropped) {
      catalog.setSelectedTable(null);
      if (tab === 'records') setTab('sql');
    }
  }
  // Re-point the open "manage table" target at the refreshed table object
  // after the catalog reloads (DDL success), so it shows fresh columns.
  useEffect(() => {
    if (!actionsTarget) return;
    const fresh = catalog.tables.find((t) => t.name === actionsTarget.name);
    if (fresh && fresh !== actionsTarget) setActionsTarget(fresh);
    else if (!fresh) setActionsTarget(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog.tables]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {/* Top bar */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Zap className="size-[18px] shrink-0 fill-brand text-brand" />
          <span className="text-md font-semibold text-foreground">unidb</span>
          <span className="text-text-muted">/</span>
          <span className="text-md text-text-light">studio</span>
          <span className="text-text-muted">/</span>
          {connectionState === 'connected' && (
            <span className="rounded-sm bg-ok-subtle px-2 py-0.5 text-xs font-semibold tracking-wide text-ok">
              CONNECTED
            </span>
          )}
          {connectionState === 'connecting' && (
            <span className="rounded-sm bg-secondary px-2 py-0.5 text-xs font-semibold tracking-wide text-text-light">
              CONNECTING
            </span>
          )}
          {connectionState === 'offline' && (
            <span className="rounded-sm bg-warn-subtle px-2 py-0.5 text-xs font-semibold tracking-wide text-warn">
              OFFLINE
            </span>
          )}
          {connectionState === 'restricted' && (
            <span
              className="rounded-sm bg-info/12 px-2 py-0.5 text-xs font-semibold tracking-wide text-info"
              title="Server is reachable — this signed-in user just isn't granted schema/catalog access. Table names typed by hand still work."
            >
              LIMITED ACCESS
            </span>
          )}
          {connectionState === 'not-configured' && (
            <span className="rounded-sm bg-warn-subtle px-2 py-0.5 text-xs font-semibold tracking-wide text-warn">
              NOT CONFIGURED
            </span>
          )}
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-4">
          {IS_CONFIGURED && (
            <>
              <code
                className="max-w-[220px] overflow-hidden font-mono text-xs text-ellipsis whitespace-nowrap text-text-light"
                title={BASE_URL}
              >
                {BASE_URL.replace(/^https?:\/\//, '')}
              </code>
              <TokenStatus />
            </>
          )}
          <button
            className={cn(
              'flex size-7 items-center justify-center rounded-md text-text-light hover:bg-accent hover:text-foreground',
              accent === 'claude' && 'text-brand',
            )}
            onClick={() => setAccent(accent === 'claude' ? 'default' : 'claude')}
            title={accent === 'claude' ? 'Switch to default accent' : 'Switch to Claude accent'}
            aria-label="Toggle accent color"
          >
            <Palette className="size-4" />
          </button>
          <button
            className="flex size-7 items-center justify-center rounded-md text-text-light hover:bg-accent hover:text-foreground"
            onClick={toggleTheme}
            title="Toggle theme"
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? <Moon className="size-4" /> : <Sun className="size-4" />}
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left nav */}
        <nav className="flex w-14 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface p-2 lg:w-56">
          <NavButton
            active={tab === 'overview'}
            icon={<LayoutDashboard className="size-4" />}
            label="Project Overview"
            onClick={() => setTab('overview')}
          />

          <div className="mx-2 my-3 h-px bg-border-muted" />

          <NavGroup label="Database" items={DATABASE_ITEMS} tab={tab} setTab={setTab} />

          <div className="mx-2 my-3 h-px bg-border-muted" />

          <NavGroup label="Platform" items={PLATFORM_ITEMS} tab={tab} setTab={setTab} />

          <div className="mx-2 my-3 h-px bg-border-muted" />

          <NavGroup label="Monitor" items={MONITOR_ITEMS} tab={tab} setTab={setTab} />
        </nav>

        {/* Body: tables sidebar (data tabs only) + content */}
        <div className="flex min-w-0 flex-1 overflow-hidden">
          {DATA_TABS.has(tab) && (
            <TablesSidebar
              tables={catalog.tables}
              loading={catalog.tablesLoading}
              error={catalog.tablesError}
              supported={catalog.tablesSupported}
              selected={catalog.selectedTable?.name}
              canDDL={catalog.canDDL}
              onSelect={selectTable}
              onRefresh={catalog.loadTables}
              onNewTable={() => setNewTableOpen(true)}
              onManageTable={(t) => setActionsTarget(t)}
            />
          )}

          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {!IS_CONFIGURED && (
              <div className="shrink-0 border-b border-error bg-error-subtle px-4 py-2 text-md" role="alert">
                <strong>Not configured.</strong> Copy <code>.env.example</code> to <code>.env.local</code>, set{' '}
                <code>VITE_UNIDB_URL</code> and <code>VITE_UNIDB_TOKEN</code>, then restart <code>npm run dev</code>.
              </div>
            )}
            <section className={cn('flex flex-1 flex-col', tab === 'overview' || tab === 'storage' ? 'overflow-hidden' : 'overflow-auto p-4')}>
              {tab === 'overview' ? (
                <Overview
                  tables={catalog.tables}
                  tablesLoading={catalog.tablesLoading}
                  tablesError={catalog.tablesError}
                  catalogSource={catalog.catalogSource}
                  onGoTab={setTab}
                />
              ) : tab === 'sql' ? (
                <SqlEditor sql={sql} onSqlChange={setSql} paramsText={paramsText} onParamsTextChange={setParamsText} />
              ) : tab === 'records' ? (
                catalog.selectedTable ? (
                  <>
                    <div className="mb-2.5">
                      <button className="text-sm text-brand hover:underline" onClick={queryTableInEditor}>
                        Open in SQL editor →
                      </button>
                    </div>
                    <RecordBrowser
                      table={catalog.selectedTable}
                      relationships={catalog.relationships}
                      editable={catalog.catalogSource === 'catalog'}
                    />
                  </>
                ) : (
                  <EmptyState message="Pick a table from the sidebar." />
                )
              ) : tab === 'schema' ? (
                <SchemaVisualizer tables={catalog.tables} />
              ) : tab === 'csv' ? (
                <CsvUpload tables={catalog.tables} />
              ) : tab === 'storage' ? (
                <StoragePanel />
              ) : tab === 'events' ? (
                <EventsPanel tables={catalog.tables} />
              ) : tab === 'auth' ? (
                <AuthPanel tables={catalog.tables} />
              ) : tab === 'observability' ? (
                <ObservabilityPanel />
              ) : tab === 'logs' ? (
                <LogsPanel />
              ) : tab === 'compare' ? (
                <ComparePanel />
              ) : null}
            </section>
          </main>
        </div>
      </div>

      {newTableOpen && <TableBuilder onSubmit={onNewTableSubmit} onClose={() => setNewTableOpen(false)} />}
      {actionsTarget && (
        <TableActions table={actionsTarget} onRun={runDDL} onClose={() => setActionsTarget(null)} onDropped={onTableDropped} />
      )}
      <Toaster />
    </div>
  );
}

function NavGroup({
  label,
  items,
  tab,
  setTab,
}: {
  label: string;
  items: NavItem[];
  tab: Tab;
  setTab: (t: Tab) => void;
}) {
  return (
    <div className="flex flex-col gap-px">
      <span className="hidden px-3 pt-4 pb-1 text-xs font-semibold tracking-wide text-text-muted uppercase lg:block">{label}</span>
      {items.map((item) => (
        <NavButton
          key={item.tab}
          active={tab === item.tab}
          icon={<item.icon className="size-4" />}
          label={item.label}
          onClick={() => setTab(item.tab)}
        />
      ))}
    </div>
  );
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      className={cn(
        'mx-2 my-px flex h-8 items-center justify-center gap-2 rounded-md px-3 text-md text-text-light transition-colors lg:justify-start',
        active ? 'bg-selected text-foreground [&_svg]:text-brand' : 'hover:bg-accent hover:text-foreground',
      )}
      style={{ width: 'calc(100% - 1rem)' }}
      onClick={onClick}
      title={label}
    >
      {icon}
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}
