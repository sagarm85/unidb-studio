import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Shield, KeyRound, FileText, Eye, Users, Plus, X, RefreshCw, UserCircle, ChevronRight,
  Clock, LogIn, Mail, Inbox, ShieldCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  runSql, authPreview, fetchAuthMeta, fetchWhoami,
  authLogin, authSignup, authRefresh, authLogout,
  listSessions, revokeSession,
  mfaEnroll, mfaVerify, mfaChallenge, mfaDisable,
  getOauthProviders, oauthAuthorizeUrl, oauthCallback, OAUTH_PROVIDER_LABELS,
  authRecover, authVerifyRecovery, authMagicLink, authMagicLinkVerify,
  getDevInbox, clearDevInbox,
} from '@/lib/engine/api.js';
import { quoteIdent } from '@/lib/engine/format.js';
import { DataGrid, type DataGridResult } from './DataGrid';
import { Badge } from './ui/badge';
import { Textarea } from './ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog';
import { ErrorBox } from './ErrorBox';
import { cn } from '@/lib/utils';
import type { CatalogError } from '@/hooks/useCatalog';

// unidb's per-user authorization (item-24 Z1/Z4/Z5/Z6 — shipped on unidb's
// main branch 2026-07-20). Reads are catalog SELECTs over POST /sql
// (unidb_catalog.roles/users/role_members/grants/policies); writes are the
// small auth-DDL grammar in unidb's src/authz/mod.rs (CREATE/DROP
// ROLE/POLICY, GRANT/REVOKE) — a hand-written grammar, not sqlparser SQL —
// so identifiers are quoted the same way as elsewhere in the app
// (quoteIdent) but privilege/operation keywords are sent bare.
// See unidb/docs/REST_API.md "Per-user authorization (P6.e)" and
// "Row-level security (RLS) policies".
//
// Deviation from a typical "roles have a superuser flag" mental model: in
// the real grammar SUPERUSER is a CREATE USER attribute only — CREATE ROLE
// has no superuser flag. Roles here are pure permission groups; the
// superuser flag only ever appears on Users.

interface Role {
  name: string;
}
interface AppUser {
  name: string;
  isSuperuser: boolean;
}
interface RoleMember {
  role: string;
  member: string;
}
interface Grant {
  role: string; // grantee — a role or a user name
  table: string;
  operation: string;
}
interface Policy {
  name: string;
  table: string;
  operation: string;
  usingExpr: string;
  withCheckExpr: string | null;
  enforced: boolean;
  // Roles the policy is scoped to (the CREATE POLICY `TO …` clause). Empty =
  // "*" = applies to every role. Sourced from unidb_catalog.policies.target_roles.
  targetRoles: string[];
}
interface AuthMeta {
  open_mode: boolean;
  privilege_types: string[];
  policy_operations: string[];
  catalog_tables: string[];
  dev_login_enabled: boolean;
}
interface WhoamiPrivilege {
  table: string;
  ops: string[];
}
interface Whoami {
  user: string | null;
  is_superuser: boolean;
  roles: string[];
  privileges: WhoamiPrivilege[];
  open_mode: boolean;
}

type SubTab = 'roles' | 'grants' | 'policies' | 'preview' | 'whoami' | 'sessions' | 'flows';
type OpBadgeVariant = 'info' | 'ok' | 'warn' | 'error' | 'outline';

const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;
const POLICY_OPS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL'] as const;
const USERS_PAGE_SIZE = 5;

function opVariant(op: string): OpBadgeVariant {
  switch (op) {
    case 'SELECT':
      return 'info';
    case 'INSERT':
      return 'ok';
    case 'UPDATE':
      return 'warn';
    case 'DELETE':
      return 'error';
    default:
      return 'outline'; // ALL
  }
}

function toCatalogError(e: any): CatalogError {
  const code = e?.code;
  const message = code === 'PERMISSION_DENIED' ? 'Superuser JWT required to manage roles and policies.' : (e?.message ?? String(e));
  return { code, message, status: e?.status };
}

async function execAuthDdl(sql: string, onMutated: () => Promise<void>, successMsg?: string) {
  await runSql(sql);
  await onMutated();
  if (successMsg) toast.success(successMsg);
}

// ---- catalog readers (POST /sql over unidb_catalog.*) ----

async function fetchRoles(): Promise<Role[]> {
  const { results } = await runSql('SELECT name FROM unidb_catalog.roles');
  return (results[0]?.rows ?? []).map((r: any[]) => ({ name: String(r[0]) }));
}
async function fetchUsers(): Promise<AppUser[]> {
  const { results } = await runSql('SELECT name, is_superuser FROM unidb_catalog.users');
  return (results[0]?.rows ?? []).map((r: any[]) => ({ name: String(r[0]), isSuperuser: !!r[1] }));
}
async function fetchRoleMembers(): Promise<RoleMember[]> {
  const { results } = await runSql('SELECT role, member FROM unidb_catalog.role_members');
  return (results[0]?.rows ?? []).map((r: any[]) => ({ role: String(r[0]), member: String(r[1]) }));
}
async function fetchGrants(): Promise<Grant[]> {
  const { results } = await runSql('SELECT role, table_name, operation FROM unidb_catalog.grants');
  return (results[0]?.rows ?? []).map((r: any[]) => ({ role: String(r[0]), table: String(r[1]), operation: String(r[2]) }));
}
async function fetchPolicies(): Promise<Policy[]> {
  const { results } = await runSql(
    'SELECT name, table_name, operation, using_expr, with_check_expr, enforced, target_roles FROM unidb_catalog.policies',
  );
  return (results[0]?.rows ?? []).map((r: any[]) => {
    // target_roles is a comma-separated list; "*" (or null) means every role.
    const raw = r[6] == null ? '' : String(r[6]).trim();
    const targetRoles = raw === '' || raw === '*' ? [] : raw.split(',').map((s) => s.trim()).filter(Boolean);
    return {
      name: String(r[0]),
      table: String(r[1]),
      operation: String(r[2]),
      usingExpr: String(r[3]),
      withCheckExpr: r[4] == null || r[4] === 'NULL' ? null : String(r[4]),
      enforced: !!r[5],
      targetRoles,
    };
  });
}

export function AuthPanel({ tables }: { tables: { name: string }[] }) {
  const [subtab, setSubtab] = useState<SubTab>('roles');

  const [roles, setRoles] = useState<Role[]>([]);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [roleMembers, setRoleMembers] = useState<RoleMember[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [meta, setMeta] = useState<AuthMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<CatalogError | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [r, u, rm, g, p, m] = await Promise.all([
        fetchRoles(),
        fetchUsers(),
        fetchRoleMembers(),
        fetchGrants(),
        fetchPolicies(),
        fetchAuthMeta(),
      ]);
      setRoles(r);
      setUsers(u);
      setRoleMembers(rm);
      setGrants(g);
      setPolicies(p);
      setMeta(m);
    } catch (e: any) {
      setLoadError(toCatalogError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const tableNames = useMemo(() => tables.map((t) => t.name).sort(), [tables]);
  const grantees = useMemo(() => {
    const set = new Set<string>([...roles.map((r) => r.name), ...users.map((u) => u.name)]);
    return Array.from(set).sort();
  }, [roles, users]);

  // GET /auth/meta is the authoritative open-mode signal (item 100) — no
  // more inferring it from users.length client-side.
  const openMode = !loading && !loadError && (meta?.open_mode ?? false);

  const SUBTABS: { id: SubTab; label: string; icon: typeof Shield }[] = [
    { id: 'roles', label: 'Roles', icon: Shield },
    { id: 'grants', label: 'Grants', icon: KeyRound },
    { id: 'policies', label: 'Policies', icon: FileText },
    { id: 'preview', label: 'Preview', icon: Eye },
    { id: 'whoami', label: 'Whoami', icon: UserCircle },
    { id: 'sessions', label: 'Sessions', icon: Clock },
    { id: 'flows', label: 'Sign-in flows', icon: LogIn },
  ];

  return (
    <div className="flex h-full flex-col gap-3.5">
      <div className="flex items-center gap-1 border-b border-border pb-2">
        {SUBTABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setSubtab(t.id)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-md transition-colors',
              subtab === t.id ? 'bg-selected text-foreground [&_svg]:text-brand' : 'text-text-light hover:bg-accent hover:text-foreground',
            )}
          >
            <t.icon className="size-3.5" /> {t.label}
          </button>
        ))}
        <div className="flex-1" />
        <button
          className="flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1 text-sm hover:border-border-strong disabled:opacity-45"
          onClick={loadAll}
          disabled={loading}
        >
          <RefreshCw className={cn('size-3', loading && 'animate-spin')} /> Refresh
        </button>
      </div>

      {loadError && <ErrorBox error={loadError} />}
      {openMode && (
        <div className="rounded-md border border-info/35 bg-info/8 px-3 py-2 text-md text-foreground">
          No users registered. Server running in open mode (all authenticated callers have full access).
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {subtab === 'roles' && (
          <RolesTab roles={roles} users={users} roleMembers={roleMembers} grants={grants} grantees={grantees} onMutated={loadAll} />
        )}
        {subtab === 'grants' && <GrantsTab grants={grants} grantees={grantees} tables={tableNames} onMutated={loadAll} />}
        {subtab === 'policies' && <PoliciesTab policies={policies} tables={tableNames} roles={roles.map((r) => r.name)} onMutated={loadAll} />}
        {subtab === 'preview' && <PreviewTab users={users} />}
        {subtab === 'whoami' && <WhoamiTab />}
        {subtab === 'sessions' && <SessionsTab />}
        {subtab === 'flows' && <FlowsTab />}
      </div>
    </div>
  );
}

// ============================== Roles ======================================

function RolesTab({
  roles,
  users,
  roleMembers,
  grants,
  grantees,
  onMutated,
}: {
  roles: Role[];
  users: AppUser[];
  roleMembers: RoleMember[];
  grants: Grant[];
  grantees: string[];
  onMutated: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [newRoleOpen, setNewRoleOpen] = useState(false);
  const [newRoleName, setNewRoleName] = useState('');
  const [addMember, setAddMember] = useState('');
  const [dropConfirm, setDropConfirm] = useState<{ kind: 'role'; name: string } | { kind: 'member'; role: string; member: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CatalogError | null>(null);
  const [userPage, setUserPage] = useState(0);

  useEffect(() => {
    if (selected && !roles.some((r) => r.name === selected)) setSelected(null);
  }, [roles, selected]);

  useEffect(() => {
    const maxPage = Math.max(0, Math.ceil(users.length / USERS_PAGE_SIZE) - 1);
    if (userPage > maxPage) setUserPage(maxPage);
  }, [users, userPage]);

  async function run(sql: string, successMsg: string, after?: () => void) {
    setError(null);
    setBusy(true);
    try {
      await execAuthDdl(sql, onMutated, successMsg);
      after?.();
    } catch (e: any) {
      setError(toCatalogError(e));
    } finally {
      setBusy(false);
    }
  }

  function submitNewRole() {
    const n = newRoleName.trim();
    if (!n) return setError({ message: 'role name is required' });
    run(`CREATE ROLE ${quoteIdent(n)}`, 'Role created', () => {
      setNewRoleName('');
      setNewRoleOpen(false);
    });
  }
  function confirmDrop() {
    if (!dropConfirm) return;
    if (dropConfirm.kind === 'role') {
      run(`DROP ROLE ${quoteIdent(dropConfirm.name)}`, 'Role dropped', () => {
        setDropConfirm(null);
        if (selected === dropConfirm.name) setSelected(null);
      });
    } else {
      run(`REVOKE ${quoteIdent(dropConfirm.role)} FROM ${quoteIdent(dropConfirm.member)}`, 'Member removed', () => setDropConfirm(null));
    }
  }
  function submitAddMember() {
    if (!selected || !addMember) return;
    run(`GRANT ${quoteIdent(selected)} TO ${quoteIdent(addMember)}`, 'Member added', () => setAddMember(''));
  }

  const memberCount = (roleName: string) => roleMembers.filter((m) => m.role === roleName).length;
  const membersOf = (roleName: string) => roleMembers.filter((m) => m.role === roleName).map((m) => m.member);
  const grantsOf = (roleName: string) => {
    const byTable = new Map<string, Set<string>>();
    for (const g of grants) {
      if (g.role !== roleName) continue;
      if (!byTable.has(g.table)) byTable.set(g.table, new Set());
      byTable.get(g.table)!.add(g.operation);
    }
    return Array.from(byTable.entries()).map(([table, ops]) => ({ table, ops: Array.from(ops) }));
  };
  const addableMembers = selected ? grantees.filter((g) => g !== selected && !membersOf(selected).includes(g)) : [];

  const totalUserPages = Math.max(1, Math.ceil(users.length / USERS_PAGE_SIZE));
  const pagedUsers = users.slice(userPage * USERS_PAGE_SIZE, (userPage + 1) * USERS_PAGE_SIZE);

  return (
    <div className="flex flex-col gap-6">
      {/* Users — compact, paginated, at the top: a small reference list, not
          the main focus of this tab. `bg-card` lifts this off the page
          background (`bg-background`) so it reads as a distinct panel — the
          hairline border alone wasn't enough separation between sections. */}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border bg-secondary px-3 py-2">
          <h3 className="m-0 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-text-muted uppercase">
            <Users className="size-3.5" /> Users
          </h3>
          {users.length > USERS_PAGE_SIZE && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-muted">
                page {userPage + 1} of {totalUserPages}
              </span>
              <button
                className="h-[26px] rounded-md border border-border bg-secondary px-3 text-sm hover:border-border-strong disabled:opacity-45"
                onClick={() => setUserPage((p) => Math.max(0, p - 1))}
                disabled={userPage === 0}
              >
                ← Prev
              </button>
              <button
                className="h-[26px] rounded-md border border-border bg-secondary px-3 text-sm hover:border-border-strong disabled:opacity-45"
                onClick={() => setUserPage((p) => Math.min(totalUserPages - 1, p + 1))}
                disabled={userPage >= totalUserPages - 1}
              >
                Next →
              </button>
            </div>
          )}
        </div>
        {users.length === 0 ? (
          <p className="m-0 p-3 text-sm text-text-light">No users registered (open mode).</p>
        ) : (
          pagedUsers.map((u) => (
            <div key={u.name} className="flex items-center justify-between border-b border-border-muted px-3 py-2 last:border-b-0">
              <span className="font-mono text-md">{u.name}</span>
              {u.isSuperuser && <Badge variant="warn">SUPERUSER</Badge>}
            </div>
          ))
        )}
      </div>

      {/* Roles — a full-width table (not a narrow sidebar list). */}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border bg-secondary px-3 py-2">
          <h3 className="m-0 text-xs font-semibold tracking-wide text-text-muted uppercase">Roles</h3>
          <button
            className="flex items-center gap-1 rounded-md bg-brand px-2 py-1 text-sm font-medium text-brand-text-on hover:bg-brand-hover"
            onClick={() => setNewRoleOpen(true)}
          >
            <Plus className="size-3.5" /> New Role
          </button>
        </div>
        <div className="grid grid-cols-[1fr_140px_160px_48px] items-center gap-2 border-b border-border-muted px-3 py-1.5 text-xs font-semibold tracking-wide text-text-muted uppercase">
          <span>Name</span>
          <span>Members</span>
          <span>Tables granted</span>
          <span />
        </div>
        {roles.length === 0 ? (
          <p className="m-0 p-3 text-sm text-text-light">No roles yet.</p>
        ) : (
          roles.map((r) => (
            <button
              key={r.name}
              onClick={() => setSelected((s) => (s === r.name ? null : r.name))}
              className={cn(
                'grid w-full grid-cols-[1fr_140px_160px_48px] items-center gap-2 border-b border-border-muted px-3 py-2 text-left text-md last:border-b-0 hover:bg-accent',
                selected === r.name && 'bg-selected',
              )}
            >
              <span className="flex items-center gap-1.5 truncate font-mono" title={r.name}>
                <Shield className={cn('size-3.5 shrink-0 text-text-muted', selected === r.name && 'text-brand')} />
                {r.name}
              </span>
              <span className="text-sm text-text-light">
                {memberCount(r.name)} member{memberCount(r.name) === 1 ? '' : 's'}
              </span>
              <span className="text-sm text-text-light">
                {grantsOf(r.name).length} table{grantsOf(r.name).length === 1 ? '' : 's'}
              </span>
              <span
                role="button"
                tabIndex={0}
                className="justify-self-end text-text-muted hover:text-error"
                title="Drop role"
                onClick={(e) => {
                  e.stopPropagation();
                  setDropConfirm({ kind: 'role', name: r.name });
                }}
              >
                <X className="size-3.5" />
              </span>
            </button>
          ))
        )}
      </div>

      {/* Detail grid: Members | Granted on tables, side by side, below the
          roles table once a role is selected. */}
      {selected && (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex items-center gap-1.5 border-b border-border bg-secondary px-3 py-2">
            <Shield className="size-3.5 text-brand" />
            <h3 className="m-0 font-mono text-md font-semibold">{selected}</h3>
          </div>
          <div className="grid grid-cols-2 gap-4 p-4">
            <section>
              <h4 className="m-0 mb-2 text-xs font-semibold tracking-wide text-text-muted uppercase">Members</h4>
              <div className="flex flex-col overflow-hidden rounded-lg border border-border">
                {membersOf(selected).length === 0 ? (
                  <p className="m-0 p-3 text-sm text-text-light">No members.</p>
                ) : (
                  membersOf(selected).map((m) => (
                    <div key={m} className="flex items-center justify-between border-b border-border-muted px-3 py-2 last:border-b-0">
                      <span className="font-mono text-md">{m}</span>
                      <button
                        className="text-sm text-text-muted hover:text-error"
                        onClick={() => setDropConfirm({ kind: 'member', role: selected, member: m })}
                      >
                        Remove
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <select
                  value={addMember}
                  onChange={(e) => setAddMember(e.target.value)}
                  className="h-8 flex-1 rounded-md border border-border bg-secondary px-2 text-md"
                >
                  <option value="">add member…</option>
                  {addableMembers.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
                <button
                  className="h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong disabled:opacity-45"
                  onClick={submitAddMember}
                  disabled={!addMember || busy}
                >
                  Add
                </button>
              </div>
            </section>

            <section>
              <h4 className="m-0 mb-2 text-xs font-semibold tracking-wide text-text-muted uppercase">Granted on tables</h4>
              <div className="flex flex-col overflow-hidden rounded-lg border border-border">
                {grantsOf(selected).length === 0 ? (
                  <p className="m-0 p-3 text-sm text-text-light">No table grants.</p>
                ) : (
                  grantsOf(selected).map(({ table, ops }) => (
                    <div key={table} className="flex items-center gap-2 border-b border-border-muted px-3 py-2 last:border-b-0">
                      <span className="w-32 shrink-0 truncate font-mono text-md" title={table}>
                        {table}
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {ops.map((op) => (
                          <Badge key={op} variant={opVariant(op)}>
                            {op}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </div>
      )}

      {error && <ErrorBox error={error} />}

      <Dialog open={newRoleOpen} onOpenChange={(open) => !open && setNewRoleOpen(false)}>
        <DialogContent className="max-w-[380px] p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>New role</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2 p-4">
            <input
              autoFocus
              value={newRoleName}
              onChange={(e) => setNewRoleName(e.target.value)}
              placeholder="role name"
              spellCheck={false}
              className="h-8 rounded-md border border-border bg-secondary px-2 font-mono text-md outline-none focus-visible:border-border-strong focus-visible:ring-[2px] focus-visible:ring-ring/40"
            />
            <p className="m-0 text-xs text-text-muted">
              Roles are permission groups — the superuser flag is a user attribute (created via <code>CREATE USER … SUPERUSER</code>), not
              available on roles.
            </p>
          </div>
          <DialogFooter className="border-t border-border px-4 py-3">
            <button className="h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong" onClick={() => setNewRoleOpen(false)}>
              Cancel
            </button>
            <button
              className="h-8 rounded-md bg-brand px-3 text-md font-semibold text-brand-text-on hover:bg-brand-hover disabled:opacity-45"
              onClick={submitNewRole}
              disabled={busy || !newRoleName.trim()}
            >
              Create
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!dropConfirm} onOpenChange={(open) => !open && setDropConfirm(null)}>
        <DialogContent className="max-w-[420px] p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>{dropConfirm?.kind === 'role' ? 'Drop role' : 'Remove member'}</DialogTitle>
          </DialogHeader>
          <div className="p-4">
            <p className="m-0 text-md leading-relaxed">
              {dropConfirm?.kind === 'role' ? (
                <>
                  This will permanently drop role <code className="rounded-sm border border-border bg-secondary px-1 font-mono text-sm">{dropConfirm.name}</code>. This
                  cannot be undone.
                </>
              ) : dropConfirm ? (
                <>
                  Remove <code className="rounded-sm border border-border bg-secondary px-1 font-mono text-sm">{dropConfirm.member}</code> from role{' '}
                  <code className="rounded-sm border border-border bg-secondary px-1 font-mono text-sm">{dropConfirm.role}</code>?
                </>
              ) : null}
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
              {dropConfirm?.kind === 'role' ? 'Drop' : 'Remove'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================== Grants ======================================

function GrantsTab({
  grants,
  grantees,
  tables,
  onMutated,
}: {
  grants: Grant[];
  grantees: string[];
  tables: string[];
  onMutated: () => Promise<void>;
}) {
  const [filterGrantee, setFilterGrantee] = useState('');
  const [filterTable, setFilterTable] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [draftGrantee, setDraftGrantee] = useState('');
  const [draftTable, setDraftTable] = useState('');
  const [draftPrivs, setDraftPrivs] = useState<Set<string>>(new Set());
  const [draftAll, setDraftAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CatalogError | null>(null);
  const [revokeConfirm, setRevokeConfirm] = useState<Grant | null>(null);

  const filtered = grants.filter((g) => (!filterGrantee || g.role === filterGrantee) && (!filterTable || g.table === filterTable));

  async function run(sql: string, successMsg: string, after?: () => void) {
    setError(null);
    setBusy(true);
    try {
      await execAuthDdl(sql, onMutated, successMsg);
      after?.();
    } catch (e: any) {
      setError(toCatalogError(e));
    } finally {
      setBusy(false);
    }
  }

  function togglePriv(p: string) {
    setDraftPrivs((s) => {
      const next = new Set(s);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }
  function submitNewGrant() {
    if (!draftGrantee || !draftTable) return setError({ message: 'grantee and table are required' });
    const privClause = draftAll ? 'ALL' : Array.from(draftPrivs).join(', ');
    if (!privClause) return setError({ message: 'pick at least one privilege' });
    run(`GRANT ${privClause} ON ${quoteIdent(draftTable)} TO ${quoteIdent(draftGrantee)}`, 'Grant added', () => {
      setDraftGrantee('');
      setDraftTable('');
      setDraftPrivs(new Set());
      setDraftAll(false);
      setNewOpen(false);
    });
  }
  function revoke(g: Grant) {
    run(`REVOKE ${g.operation} ON ${quoteIdent(g.table)} FROM ${quoteIdent(g.role)}`, 'Grant revoked', () =>
      setRevokeConfirm(null),
    );
  }

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <select value={filterGrantee} onChange={(e) => setFilterGrantee(e.target.value)} className="h-8 rounded-md border border-border bg-secondary px-2 text-md">
          <option value="">all grantees</option>
          {grantees.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <select value={filterTable} onChange={(e) => setFilterTable(e.target.value)} className="h-8 rounded-md border border-border bg-secondary px-2 text-md">
          <option value="">all tables</option>
          {tables.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <div className="flex-1" />
        <button
          className="flex items-center gap-1 rounded-md bg-brand px-2.5 py-1.5 text-sm font-medium text-brand-text-on hover:bg-brand-hover"
          onClick={() => setNewOpen(true)}
        >
          <Plus className="size-3.5" /> New Grant
        </button>
      </div>

      {error && <ErrorBox error={error} />}

      <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
        <div className="grid grid-cols-[1fr_1fr_100px_80px] items-center gap-2 border-b border-border bg-secondary px-3 py-1.5 text-xs font-semibold tracking-wide text-text-muted uppercase">
          <span>Grantee</span>
          <span>Table</span>
          <span>Privilege</span>
          <span />
        </div>
        {filtered.length === 0 ? (
          <p className="m-0 p-3 text-sm text-text-light">No grants.</p>
        ) : (
          filtered.map((g, i) => (
            <div key={`${g.role}-${g.table}-${g.operation}-${i}`} className="grid grid-cols-[1fr_1fr_100px_80px] items-center gap-2 border-b border-border-muted px-3 py-2 last:border-b-0 hover:bg-accent">
              <span className="truncate font-mono text-md" title={g.role}>
                {g.role}
              </span>
              <span className="truncate font-mono text-md" title={g.table}>
                {g.table}
              </span>
              <Badge variant={opVariant(g.operation)}>{g.operation}</Badge>
              <button className="justify-self-end text-sm text-text-muted hover:text-error" onClick={() => setRevokeConfirm(g)} disabled={busy}>
                Revoke
              </button>
            </div>
          ))
        )}
      </div>

      <Dialog open={newOpen} onOpenChange={(open) => !open && setNewOpen(false)}>
        <DialogContent className="max-w-[420px] p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>New grant</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 p-4">
            <label className="flex flex-col gap-1 text-sm text-text-light">
              Grantee
              <select value={draftGrantee} onChange={(e) => setDraftGrantee(e.target.value)} className="h-8 rounded-md border border-border bg-secondary px-2 text-md">
                <option value="">choose…</option>
                {grantees.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-light">
              Table
              <select value={draftTable} onChange={(e) => setDraftTable(e.target.value)} className="h-8 rounded-md border border-border bg-secondary px-2 text-md">
                <option value="">choose…</option>
                {tables.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-col gap-1">
              <span className="text-sm text-text-light">Privileges</span>
              <div className="flex flex-wrap gap-3">
                {PRIVILEGES.map((p) => (
                  <label key={p} className="inline-flex items-center gap-1.5 text-md">
                    <input type="checkbox" checked={draftAll || draftPrivs.has(p)} disabled={draftAll} onChange={() => togglePriv(p)} />
                    {p}
                  </label>
                ))}
                <label className="inline-flex items-center gap-1.5 text-md font-semibold">
                  <input
                    type="checkbox"
                    checked={draftAll}
                    onChange={(e) => {
                      setDraftAll(e.target.checked);
                      if (e.target.checked) setDraftPrivs(new Set());
                    }}
                  />
                  ALL
                </label>
              </div>
            </div>
          </div>
          <DialogFooter className="border-t border-border px-4 py-3">
            <button className="h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong" onClick={() => setNewOpen(false)}>
              Cancel
            </button>
            <button
              className="h-8 rounded-md bg-brand px-3 text-md font-semibold text-brand-text-on hover:bg-brand-hover disabled:opacity-45"
              onClick={submitNewGrant}
              disabled={busy || !draftGrantee || !draftTable || (!draftAll && draftPrivs.size === 0)}
            >
              Grant
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!revokeConfirm} onOpenChange={(open) => !open && setRevokeConfirm(null)}>
        <DialogContent className="max-w-[420px] p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>Revoke grant</DialogTitle>
          </DialogHeader>
          <div className="p-4">
            <p className="m-0 text-md leading-relaxed">
              This will revoke <code className="rounded-sm border border-border bg-secondary px-1 font-mono text-sm">{revokeConfirm?.operation}</code> on{' '}
              <code className="rounded-sm border border-border bg-secondary px-1 font-mono text-sm">{revokeConfirm?.table}</code> from{' '}
              <code className="rounded-sm border border-border bg-secondary px-1 font-mono text-sm">{revokeConfirm?.role}</code>. This cannot be undone.
            </p>
          </div>
          <DialogFooter className="border-t border-border px-4 py-3">
            <button className="h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong" onClick={() => setRevokeConfirm(null)}>
              Cancel
            </button>
            <button
              className="h-8 rounded-md bg-error px-3 text-md font-semibold text-background hover:brightness-110 disabled:opacity-45"
              onClick={() => revokeConfirm && revoke(revokeConfirm)}
              disabled={busy}
            >
              Revoke
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================== Policies ====================================

// Starter predicates for the New Policy templates panel — Supabase-style
// quick-fill, scoped to what unidb's CREATE POLICY grammar actually supports
// (no Permissive/Restrictive, no TO <role> — just ON/FOR/USING/WITH CHECK).
const POLICY_TEMPLATES: {
  label: string;
  desc: string;
  op: (typeof POLICY_OPS)[number];
  namePrefix: string;
  predicate: string;
  withCheck?: string;
}[] = [
  {
    label: 'Owner only',
    desc: 'Rows are only visible to the user named in the owner column.',
    op: 'SELECT',
    namePrefix: 'owner_only',
    predicate: 'owner = current_user',
  },
  {
    label: 'Public read',
    desc: 'Every authenticated caller can read every row.',
    op: 'SELECT',
    namePrefix: 'public_read',
    predicate: 'true',
  },
  {
    label: 'Tenant isolation',
    desc: 'Rows are scoped to a tenant/org id matching the caller.',
    op: 'SELECT',
    namePrefix: 'tenant_isolation',
    predicate: 'tenant_id = current_user',
  },
  {
    label: 'Own writes only',
    desc: 'A caller can only insert rows attributed to themselves.',
    op: 'INSERT',
    namePrefix: 'own_writes_only',
    predicate: 'owner = current_user',
  },
  {
    label: 'Update own rows',
    desc: "USING gates which rows can be touched; WITH CHECK stops a row being reassigned away from its owner.",
    op: 'UPDATE',
    namePrefix: 'update_own_rows',
    predicate: 'owner = current_user',
    withCheck: 'owner = current_user',
  },
  {
    label: 'Full access for owner',
    desc: 'Owner can select/insert/update/delete their own rows — one policy, every operation.',
    op: 'ALL',
    namePrefix: 'owner_full_access',
    predicate: 'owner = current_user',
    withCheck: 'owner = current_user',
  },
];

function buildPolicySql(name: string, table: string, op: string, roles: string[], predicate: string, withCheck: string): string {
  const n = name.trim() || '<name>';
  const t = table || '<table>';
  const pred = predicate.trim() || '<predicate>';
  // Scope the policy to specific roles when chosen; omit TO → applies to all roles.
  const toClause = roles.length ? ` TO ${roles.map(quoteIdent).join(', ')}` : '';
  const withCheckClause = withCheck.trim() ? ` WITH CHECK (${withCheck.trim()})` : '';
  return `CREATE POLICY ${quoteIdent(n)} ON ${quoteIdent(t)} FOR ${op}${toClause} USING (${pred})${withCheckClause}`;
}

function PoliciesTab({ policies, tables, roles, onMutated }: { policies: Policy[]; tables: string[]; roles: string[]; onMutated: () => Promise<void> }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [newOpen, setNewOpen] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftTable, setDraftTable] = useState('');
  const [draftOp, setDraftOp] = useState<(typeof POLICY_OPS)[number]>('SELECT');
  const [draftRoles, setDraftRoles] = useState<Set<string>>(new Set());
  const [draftPredicate, setDraftPredicate] = useState('');
  const [draftWithCheck, setDraftWithCheck] = useState('');
  const toggleRole = (r: string) =>
    setDraftRoles((s) => { const n = new Set(s); n.has(r) ? n.delete(r) : n.add(r); return n; });
  const [dropConfirm, setDropConfirm] = useState<{ name: string; table: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CatalogError | null>(null);

  async function run(sql: string, successMsg: string, after?: () => void) {
    setError(null);
    setBusy(true);
    try {
      await execAuthDdl(sql, onMutated, successMsg);
      after?.();
    } catch (e: any) {
      setError(toCatalogError(e));
    } finally {
      setBusy(false);
    }
  }

  function submitNewPolicy() {
    const n = draftName.trim();
    const pred = draftPredicate.trim();
    if (!n || !draftTable || !pred) return setError({ message: 'name, table, and predicate are all required' });
    run(buildPolicySql(n, draftTable, draftOp, Array.from(draftRoles), pred, draftWithCheck), 'Policy created', () => {
      setDraftName('');
      setDraftTable('');
      setDraftOp('SELECT');
      setDraftRoles(new Set());
      setDraftPredicate('');
      setDraftWithCheck('');
      setNewOpen(false);
    });
  }
  function applyTemplate(t: (typeof POLICY_TEMPLATES)[number]) {
    setDraftOp(t.op);
    setDraftPredicate(t.predicate);
    setDraftWithCheck(t.withCheck ?? '');
    if (!draftName.trim()) setDraftName(t.namePrefix);
  }
  function confirmDrop() {
    if (!dropConfirm) return;
    run(`DROP POLICY ${quoteIdent(dropConfirm.name)} ON ${quoteIdent(dropConfirm.table)}`, 'Policy dropped', () => setDropConfirm(null));
  }
  function toggleExpand(key: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const byTable = useMemo(() => {
    const m = new Map<string, Policy[]>();
    for (const p of policies) {
      if (!m.has(p.table)) m.set(p.table, []);
      m.get(p.table)!.push(p);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [policies]);

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center justify-between">
        <h3 className="m-0 text-xs font-semibold tracking-wide text-text-muted uppercase">Policies</h3>
        <button
          className="flex items-center gap-1 rounded-md bg-brand px-2.5 py-1.5 text-sm font-medium text-brand-text-on hover:bg-brand-hover"
          onClick={() => setNewOpen(true)}
        >
          <Plus className="size-3.5" /> New Policy
        </button>
      </div>

      {error && <ErrorBox error={error} />}

      {byTable.length === 0 ? (
        <p className="text-md text-text-light">No policies defined.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {byTable.map(([table, rows]) => (
            <div key={table} className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="border-b border-border bg-secondary px-3 py-1.5 font-mono text-md font-semibold">{table}</div>
              {rows.map((p) => {
                const key = `${table}::${p.name}`;
                const isOpen = expanded.has(key);
                return (
                  <div key={key} className="flex items-start gap-2 border-b border-border-muted px-3 py-2 last:border-b-0 hover:bg-accent">
                    <span className="w-52 shrink-0 truncate font-mono text-md" title={p.name}>
                      {p.name}
                    </span>
                    <div className="flex shrink-0 gap-1">
                      <Badge variant={opVariant(p.operation)}>{p.operation}</Badge>
                      {!p.enforced && (
                        <Badge variant="warn" title="RLS is inactive (bootstrap mode — no users exist yet)">
                          inactive
                        </Badge>
                      )}
                    </div>
                    <div className="flex w-40 shrink-0 flex-wrap items-center gap-1" title="Roles this policy is scoped to (the CREATE POLICY TO clause)">
                      {p.targetRoles.length > 0 ? (
                        p.targetRoles.map((r) => (
                          <span key={r} className="rounded-full border border-border bg-secondary px-1.5 py-0 font-mono text-[11px] text-text-muted">
                            {r}
                          </span>
                        ))
                      ) : (
                        <span className="text-xs text-text-faint italic">all roles</span>
                      )}
                    </div>
                    <button
                      className="flex min-w-0 flex-1 items-start gap-1 text-left"
                      onClick={() => toggleExpand(key)}
                      title="Click to expand/collapse"
                    >
                      <ChevronRight className={cn('mt-0.5 size-3 shrink-0 text-text-muted transition-transform', isOpen && 'rotate-90')} />
                      <div className="min-w-0 flex-1">
                        <div className={cn('font-mono text-sm text-text-light', !isOpen && 'truncate')}>{p.usingExpr}</div>
                        {p.withCheckExpr != null && (
                          <div className={cn('font-mono text-sm text-warn', !isOpen && 'truncate')}>WITH CHECK: {p.withCheckExpr}</div>
                        )}
                      </div>
                    </button>
                    <button
                      className="shrink-0 text-sm text-text-muted hover:text-error"
                      onClick={() => setDropConfirm({ name: p.name, table })}
                      disabled={busy}
                    >
                      Drop
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      <Dialog open={newOpen} onOpenChange={(open) => !open && setNewOpen(false)}>
        <DialogContent className="max-w-[700px] p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>New policy</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-[1fr_220px] gap-0 max-h-[70vh] overflow-hidden">
            <div className="flex flex-col gap-3 overflow-y-auto p-4">
              <label className="flex flex-col gap-1 text-sm text-text-light">
                Policy name
                <input
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder="policy name"
                  spellCheck={false}
                  className="h-8 rounded-md border border-border bg-secondary px-2 font-mono text-md outline-none focus-visible:border-border-strong focus-visible:ring-[2px] focus-visible:ring-ring/40"
                />
              </label>
              <div className="flex gap-2">
                <label className="flex flex-1 flex-col gap-1 text-sm text-text-light">
                  Table
                  <select value={draftTable} onChange={(e) => setDraftTable(e.target.value)} className="h-8 rounded-md border border-border bg-secondary px-2 text-md">
                    <option value="">choose…</option>
                    {tables.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm text-text-light">
                  Command
                  <select value={draftOp} onChange={(e) => setDraftOp(e.target.value as typeof draftOp)} className="h-8 rounded-md border border-border bg-secondary px-2 text-md">
                    {POLICY_OPS.map((op) => (
                      <option key={op} value={op}>
                        {op}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="flex flex-col gap-1 text-sm text-text-light">
                Apply to roles
                {roles.length === 0 ? (
                  <span className="text-xs text-text-muted">No roles defined — the policy will apply to all roles.</span>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {roles.map((r) => {
                      const on = draftRoles.has(r);
                      return (
                        <button
                          key={r}
                          type="button"
                          onClick={() => toggleRole(r)}
                          className={cn(
                            'rounded-full border px-2.5 py-0.5 font-mono text-xs',
                            on ? 'border-brand bg-brand-subtle text-brand' : 'border-border bg-secondary text-text-light hover:border-border-strong',
                          )}
                        >
                          {r}
                        </button>
                      );
                    })}
                  </div>
                )}
                <span className="text-xs text-text-muted">
                  {draftRoles.size === 0 ? 'None selected → applies to every role (no TO clause).' : `Scoped to: ${Array.from(draftRoles).join(', ')}`}
                </span>
              </div>
              <label className="flex flex-col gap-1 text-sm text-text-light">
                USING expression
                <Textarea
                  value={draftPredicate}
                  onChange={(e) => setDraftPredicate(e.target.value)}
                  placeholder="e.g.  owner = current_user  or  tenant_id = 42"
                  spellCheck={false}
                  className="min-h-10"
                />
                <span className="text-xs text-text-muted">Use <code>current_user</code> (no parentheses) for the caller's identity.</span>
              </label>
              {(draftOp === 'UPDATE' || draftOp === 'ALL') && (
                <label className="flex flex-col gap-1 text-sm text-text-light">
                  WITH CHECK expression (optional, defaults to USING)
                  <Textarea
                    value={draftWithCheck}
                    onChange={(e) => setDraftWithCheck(e.target.value)}
                    placeholder="validates the NEW row on write — leave blank to reuse the USING predicate"
                    spellCheck={false}
                    className="min-h-10"
                  />
                </label>
              )}

              <div className="flex flex-col gap-1">
                <span className="text-xs font-semibold tracking-wide text-text-muted uppercase">SQL preview</span>
                <pre className="m-0 overflow-x-auto rounded-md border border-border bg-secondary px-3 py-2 font-mono text-sm leading-relaxed whitespace-pre-wrap text-text-light">
                  {buildPolicySql(draftName, draftTable, draftOp, Array.from(draftRoles), draftPredicate, draftWithCheck)}
                </pre>
              </div>
            </div>

            <div className="flex flex-col gap-1 overflow-y-auto border-l border-border bg-secondary/40 p-3">
              <span className="mb-1 text-xs font-semibold tracking-wide text-text-muted uppercase">Templates</span>
              {POLICY_TEMPLATES.map((t) => (
                <button
                  key={t.label}
                  onClick={() => applyTemplate(t)}
                  className="flex flex-col gap-1 rounded-md border border-border bg-card px-2.5 py-2 text-left hover:border-border-strong hover:bg-accent"
                >
                  <span className="flex items-center gap-1.5">
                    <Badge variant={opVariant(t.op)} className="shrink-0">
                      {t.op}
                    </Badge>
                    <span className="text-sm font-semibold">{t.label}</span>
                  </span>
                  <span className="text-xs leading-snug text-text-muted">{t.desc}</span>
                </button>
              ))}
            </div>
          </div>
          <DialogFooter className="border-t border-border px-4 py-3">
            <button className="h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong" onClick={() => setNewOpen(false)}>
              Cancel
            </button>
            <button
              className="h-8 rounded-md bg-brand px-3 text-md font-semibold text-brand-text-on hover:bg-brand-hover disabled:opacity-45"
              onClick={submitNewPolicy}
              disabled={busy || !draftName.trim() || !draftTable || !draftPredicate.trim()}
            >
              Create
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!dropConfirm} onOpenChange={(open) => !open && setDropConfirm(null)}>
        <DialogContent className="max-w-[420px] p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>Drop policy</DialogTitle>
          </DialogHeader>
          <div className="p-4">
            <p className="m-0 text-md leading-relaxed">
              This will permanently drop policy <code className="rounded-sm border border-border bg-secondary px-1 font-mono text-sm">{dropConfirm?.name}</code> on{' '}
              <code className="rounded-sm border border-border bg-secondary px-1 font-mono text-sm">{dropConfirm?.table}</code>. This cannot be undone.
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
    </div>
  );
}

// ============================== Preview =====================================

function PreviewTab({ users }: { users: AppUser[] }) {
  const [asRole, setAsRole] = useState('');
  const [sql, setSql] = useState('SELECT * FROM ');
  const [result, setResult] = useState<DataGridResult | null>(null);
  const [ranAs, setRanAs] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CatalogError | null>(null);

  useEffect(() => {
    if (!asRole && users.length) setAsRole(users[0].name);
  }, [users, asRole]);

  async function runPreview() {
    if (!asRole || !sql.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authPreview(asRole, sql.trim());
      setResult(res);
      setRanAs(asRole);
    } catch (e: any) {
      setError(toCatalogError(e));
      setResult(null);
      setRanAs(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3.5">
      {users.length === 0 ? (
        <p className="text-md text-text-light">No users registered — preview requires at least one registered user to impersonate.</p>
      ) : (
        <>
          <label className="flex flex-col gap-1 text-sm text-text-light">
            Run as user
            <select value={asRole} onChange={(e) => setAsRole(e.target.value)} className="h-8 w-56 rounded-md border border-border bg-secondary px-2 text-md">
              {users.map((u) => (
                <option key={u.name} value={u.name}>
                  {u.name}
                  {u.isSuperuser ? ' (superuser)' : ''}
                </option>
              ))}
            </select>
          </label>

          <Textarea value={sql} onChange={(e) => setSql(e.target.value)} className="min-h-24" spellCheck={false} />

          <div>
            <button
              className="h-8 rounded-md bg-brand px-4 text-md font-medium text-brand-text-on hover:bg-brand-hover disabled:opacity-45"
              onClick={runPreview}
              disabled={busy || !asRole || !sql.trim()}
            >
              {busy ? 'Running…' : 'Run Preview'}
            </button>
          </div>

          {error && <ErrorBox error={error} />}

          {result && ranAs && (
            <>
              <div className="rounded-md border border-info/35 bg-info/8 px-3 py-2 text-md">
                Showing results as <span className="font-mono font-semibold">{ranAs}</span> — RLS policies applied
              </div>
              <DataGrid result={result} />
            </>
          )}
        </>
      )}
    </div>
  );
}

// ============================== Whoami ======================================

function WhoamiTab() {
  const [who, setWho] = useState<Whoami | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CatalogError | null>(null);
  const [noToken, setNoToken] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNoToken(false);
    try {
      setWho(await fetchWhoami());
    } catch (e: any) {
      if (e?.status === 401 || e?.status === 403) {
        setNoToken(true);
      } else {
        setError(toCatalogError(e));
      }
      setWho(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center justify-between">
        <h3 className="m-0 text-xs font-semibold tracking-wide text-text-muted uppercase">Whoami</h3>
        <button
          className="flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1 text-sm hover:border-border-strong disabled:opacity-45"
          onClick={load}
          disabled={loading}
        >
          <RefreshCw className={cn('size-3', loading && 'animate-spin')} /> Refresh
        </button>
      </div>

      {noToken ? (
        <p className="text-md text-text-light">No token configured — set a bearer token to see identity.</p>
      ) : error ? (
        <ErrorBox error={error} />
      ) : who ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2">
            <span className="w-28 shrink-0 text-sm text-text-muted">User</span>
            {who.user ? <code className="font-mono text-md font-semibold">{who.user}</code> : <span className="text-md text-text-light">anonymous / open mode</span>}
          </div>
          <div className="flex items-center gap-2">
            <span className="w-28 shrink-0 text-sm text-text-muted">Superuser</span>
            <span className="text-md">{who.is_superuser ? 'yes' : 'no'}</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="w-28 shrink-0 pt-0.5 text-sm text-text-muted">Roles</span>
            {who.roles.length === 0 ? (
              <span className="text-md text-text-light">none</span>
            ) : (
              <div className="flex flex-wrap gap-1">
                {who.roles.map((r) => (
                  <Badge key={r} variant="outline">
                    {r}
                  </Badge>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-start gap-2">
            <span className="w-28 shrink-0 pt-0.5 text-sm text-text-muted">Privileges</span>
            {who.privileges.length === 0 ? (
              <span className="text-md text-text-light">none</span>
            ) : (
              <div className="flex flex-1 flex-col overflow-hidden rounded-md border border-border">
                {who.privileges.map((p) => (
                  <div key={p.table} className="flex items-center gap-2 border-b border-border-muted px-2 py-1.5 last:border-b-0">
                    <span className="w-40 shrink-0 truncate font-mono text-sm" title={p.table}>
                      {p.table}
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {p.ops.map((op) => (
                        <Badge key={op} variant={opVariant(op)}>
                          {op}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="w-28 shrink-0 text-sm text-text-muted">Open mode</span>
            <span className="text-md">{who.open_mode ? 'yes' : 'no'}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ============================== Sessions ====================================
// `unidb_catalog.sessions` (item 4) — one row per refresh-token session.
// Never a raw refresh token or its hash, only the metadata.

interface SessionRow {
  sessionId: string;
  username: string | null;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
}

function fmtEpochSecs(secs: number) {
  return new Date(secs * 1000).toLocaleString();
}

function SessionsTab() {
  const [supported, setSupported] = useState(true);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CatalogError | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const out = await listSessions();
      setSupported(out.supported);
      setSessions(out.sessions as SessionRow[]);
    } catch (e: any) {
      setError(toCatalogError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function doRevoke(sessionId: string) {
    setRevoking(sessionId);
    try {
      await revokeSession(sessionId);
      toast.success('Session revoked');
      await load();
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    } finally {
      setRevoking(null);
    }
  }

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex items-center justify-between">
        <h3 className="m-0 text-xs font-semibold tracking-wide text-text-muted uppercase">Active sessions</h3>
        <button
          className="flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1 text-sm hover:border-border-strong disabled:opacity-45"
          onClick={load}
          disabled={loading}
        >
          <RefreshCw className={cn('size-3', loading && 'animate-spin')} /> Refresh
        </button>
      </div>

      {error && <ErrorBox error={error} />}

      {!supported ? (
        <p className="text-md text-text-light">
          Not available on this server — <code>unidb_catalog.sessions</code> requires item 4, not present on this engine build.
        </p>
      ) : sessions.length === 0 ? (
        <p className="text-md text-text-light">No sessions.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="grid grid-cols-[1fr_180px_180px_100px_90px] items-center gap-2 border-b border-border bg-secondary px-3 py-1.5 text-xs font-semibold tracking-wide text-text-muted uppercase">
            <span>User</span>
            <span>Created</span>
            <span>Expires</span>
            <span>Status</span>
            <span />
          </div>
          {sessions.map((s) => (
            <div
              key={s.sessionId}
              className={cn(
                'grid grid-cols-[1fr_180px_180px_100px_90px] items-center gap-2 border-b border-border-muted px-3 py-2 text-md last:border-b-0',
                s.revoked && 'opacity-50',
              )}
            >
              <span className="truncate font-mono" title={s.username ?? ''}>
                {s.username ?? <span className="text-text-light">(no sub)</span>}
              </span>
              <span className="text-sm text-text-light">{fmtEpochSecs(s.createdAt)}</span>
              <span className="text-sm text-text-light">{fmtEpochSecs(s.expiresAt)}</span>
              <Badge variant={s.revoked ? 'error' : 'ok'}>{s.revoked ? 'revoked' : 'active'}</Badge>
              <button
                className="justify-self-end text-sm text-text-muted hover:text-error disabled:opacity-45"
                onClick={() => doRevoke(s.sessionId)}
                disabled={s.revoked || revoking === s.sessionId}
              >
                {revoking === s.sessionId ? 'Revoking…' : 'Revoke'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================== Sign-in flows ===============================
// Real POST /auth/{login,signup,refresh,logout} + TOTP MFA (item 127) +
// OAuth social login (item 128, all 7 presets via item 143 part 2) + email
// recovery/magic-link (item 138) + a live dev-inbox viewer (item 145).
// Every token here is kept in component state only — never persisted, never
// swapped into the Studio's own bearer token.

interface SessionResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

const OAUTH_PENDING_KEY = 'unidb_studio_v2_oauth_pending_provider';

function FlowsTab() {
  // ---- credential flow tester ----
  const [flowUsername, setFlowUsername] = useState('');
  const [flowPassword, setFlowPassword] = useState('');
  const [flowRefreshInput, setFlowRefreshInput] = useState('');
  const [flowBusy, setFlowBusy] = useState<string | null>(null);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionResult | null>(null);
  const [mfaLoginChallenge, setMfaLoginChallenge] = useState<{ challenge: string } | null>(null);
  const [mfaLoginCode, setMfaLoginCode] = useState('');
  const [mfaLoginBusy, setMfaLoginBusy] = useState(false);
  const [mfaLoginError, setMfaLoginError] = useState<string | null>(null);

  function applySession(s: SessionResult) {
    setSession(s);
    setFlowRefreshInput(s.refreshToken);
  }

  async function doLogin() {
    setFlowBusy('login');
    setFlowError(null);
    setMfaLoginChallenge(null);
    try {
      const res = await authLogin(flowUsername, flowPassword);
      if (res.mfaRequired) {
        setMfaLoginChallenge({ challenge: res.challenge! });
      } else {
        applySession(res as SessionResult);
      }
    } catch (e: any) {
      setFlowError(e?.message ?? String(e));
    } finally {
      setFlowBusy(null);
    }
  }
  async function doMfaLoginChallenge() {
    if (!mfaLoginChallenge) return;
    setMfaLoginBusy(true);
    setMfaLoginError(null);
    try {
      applySession(await mfaChallenge(mfaLoginChallenge.challenge, mfaLoginCode.trim()));
      setMfaLoginChallenge(null);
      setMfaLoginCode('');
    } catch (e: any) {
      setMfaLoginError(e?.message ?? String(e));
    } finally {
      setMfaLoginBusy(false);
    }
  }
  async function doSignup() {
    setFlowBusy('signup');
    setFlowError(null);
    try {
      applySession(await authSignup(flowUsername, flowPassword));
    } catch (e: any) {
      setFlowError(e?.message ?? String(e));
    } finally {
      setFlowBusy(null);
    }
  }
  async function doRefresh() {
    setFlowBusy('refresh');
    setFlowError(null);
    try {
      applySession(await authRefresh(flowRefreshInput));
    } catch (e: any) {
      setFlowError(e?.message ?? String(e));
    } finally {
      setFlowBusy(null);
    }
  }
  async function doLogout() {
    setFlowBusy('logout');
    setFlowError(null);
    try {
      await authLogout(flowRefreshInput);
      setSession(null);
      setFlowRefreshInput('');
      toast.success('Logged out');
    } catch (e: any) {
      setFlowError(e?.message ?? String(e));
    } finally {
      setFlowBusy(null);
    }
  }

  // ---- MFA (against the signed-in session's own account, via login) ----
  const [mfaSecret, setMfaSecret] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaRecoveryCodes, setMfaRecoveryCodes] = useState<string[] | null>(null);
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [mfaDisableCode, setMfaDisableCode] = useState('');
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaError, setMfaError] = useState<string | null>(null);

  async function doMfaEnroll() {
    setMfaBusy(true);
    setMfaError(null);
    try {
      const out = await mfaEnroll();
      if (!out.supported) {
        setMfaError('Not available on this server (pre-item-127 engine).');
      } else {
        setMfaSecret({ secret: out.secret!, otpauthUrl: out.otpauthUrl! });
      }
    } catch (e: any) {
      setMfaError(e?.message ?? String(e));
    } finally {
      setMfaBusy(false);
    }
  }
  async function doMfaVerify() {
    setMfaBusy(true);
    setMfaError(null);
    try {
      const out = await mfaVerify(mfaCode.trim());
      setMfaEnabled(out.enabled);
      setMfaRecoveryCodes(out.recoveryCodes);
      setMfaCode('');
    } catch (e: any) {
      setMfaError(e?.message ?? String(e));
    } finally {
      setMfaBusy(false);
    }
  }
  async function doMfaDisable() {
    setMfaBusy(true);
    setMfaError(null);
    try {
      await mfaDisable(mfaDisableCode.trim() || undefined);
      setMfaEnabled(false);
      setMfaSecret(null);
      setMfaRecoveryCodes(null);
      setMfaDisableCode('');
      toast.success('MFA disabled');
    } catch (e: any) {
      setMfaError(e?.message ?? String(e));
    } finally {
      setMfaBusy(false);
    }
  }

  // ---- OAuth (7 presets, feature-detected) ----
  const [oauthProviders, setOauthProviders] = useState<Record<string, boolean>>({});
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  useEffect(() => {
    getOauthProviders().then(setOauthProviders);
  }, []);

  useEffect(() => {
    // Detect landing back from a provider redirect: ?code=&state= in this
    // tab's own URL, with the provider name stashed in sessionStorage
    // before navigating away (the callback URL itself carries no provider
    // name — see REST_API.md's OAuth callback contract).
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');
    const oauthErr = params.get('error');
    const pending = sessionStorage.getItem(OAUTH_PENDING_KEY);
    if (!pending) return;
    sessionStorage.removeItem(OAUTH_PENDING_KEY);
    if (oauthErr) {
      setOauthError(`Provider denied the request: ${oauthErr}`);
      return;
    }
    if (!code || !state) return;
    setOauthBusy(true);
    oauthCallback(pending, code, state)
      .then((s) => {
        applySession(s);
        window.history.replaceState({}, '', window.location.pathname);
      })
      .catch((e) => setOauthError(e?.message ?? String(e)))
      .finally(() => setOauthBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startOauth(provider: string) {
    sessionStorage.setItem(OAUTH_PENDING_KEY, provider);
    window.location.href = oauthAuthorizeUrl(provider);
  }

  // ---- Email auth flows (item 138) ----
  const [recoverEmail, setRecoverEmail] = useState('');
  const [recoverBusy, setRecoverBusy] = useState(false);
  const [recoverSent, setRecoverSent] = useState(false);
  const [recoverError, setRecoverError] = useState<string | null>(null);
  const [recoverToken, setRecoverToken] = useState('');
  const [recoverNewPass, setRecoverNewPass] = useState('');
  const [recoverVerifyBusy, setRecoverVerifyBusy] = useState(false);
  const [recoverVerifyDone, setRecoverVerifyDone] = useState(false);
  const [recoverVerifyError, setRecoverVerifyError] = useState<string | null>(null);

  const [magicEmail, setMagicEmail] = useState('');
  const [magicBusy, setMagicBusy] = useState(false);
  const [magicSent, setMagicSent] = useState(false);
  const [magicError, setMagicError] = useState<string | null>(null);
  const [magicToken, setMagicToken] = useState('');
  const [magicVerifyBusy, setMagicVerifyBusy] = useState(false);
  const [magicVerifyError, setMagicVerifyError] = useState<string | null>(null);

  async function doRecover() {
    setRecoverError(null);
    setRecoverSent(false);
    if (!recoverEmail.trim()) return setRecoverError('Enter an email/username.');
    setRecoverBusy(true);
    try {
      await authRecover(recoverEmail.trim());
      setRecoverSent(true);
    } catch (e: any) {
      setRecoverError(e?.message ?? String(e));
    } finally {
      setRecoverBusy(false);
    }
  }
  async function doRecoverVerify() {
    setRecoverVerifyError(null);
    setRecoverVerifyDone(false);
    if (!recoverToken.trim() || !recoverNewPass) return setRecoverVerifyError('Enter both the token and a new password.');
    setRecoverVerifyBusy(true);
    try {
      await authVerifyRecovery(recoverToken.trim(), recoverNewPass);
      setRecoverVerifyDone(true);
      setRecoverToken('');
      setRecoverNewPass('');
    } catch (e: any) {
      setRecoverVerifyError(e?.message ?? String(e));
    } finally {
      setRecoverVerifyBusy(false);
    }
  }
  async function doMagicLink() {
    setMagicError(null);
    setMagicSent(false);
    if (!magicEmail.trim()) return setMagicError('Enter an email/username.');
    setMagicBusy(true);
    try {
      await authMagicLink(magicEmail.trim());
      setMagicSent(true);
    } catch (e: any) {
      setMagicError(e?.message ?? String(e));
    } finally {
      setMagicBusy(false);
    }
  }
  async function doMagicVerify() {
    setMagicVerifyError(null);
    if (!magicToken.trim()) return setMagicVerifyError('Enter the token from the magic-link email.');
    setMagicVerifyBusy(true);
    try {
      applySession(await authMagicLinkVerify(magicToken.trim()));
      setMagicToken('');
    } catch (e: any) {
      setMagicVerifyError(e?.message ?? String(e));
    } finally {
      setMagicVerifyBusy(false);
    }
  }

  // ---- Dev-inbox viewer (item 145) ----
  const [devInboxSupported, setDevInboxSupported] = useState<boolean | null>(null);
  const [devInboxEntries, setDevInboxEntries] = useState<any[]>([]);
  const [devInboxBusy, setDevInboxBusy] = useState(false);
  const [devInboxError, setDevInboxError] = useState<string | null>(null);

  const loadDevInbox = useCallback(async () => {
    setDevInboxBusy(true);
    setDevInboxError(null);
    try {
      const out = await getDevInbox({ limit: 50 });
      setDevInboxSupported(out.supported);
      setDevInboxEntries(out.emails);
    } catch (e: any) {
      setDevInboxSupported(null);
      setDevInboxError(e?.message ?? String(e));
    } finally {
      setDevInboxBusy(false);
    }
  }, []);

  useEffect(() => {
    loadDevInbox();
  }, [loadDevInbox]);

  async function doClearDevInbox() {
    setDevInboxBusy(true);
    setDevInboxError(null);
    try {
      await clearDevInbox();
      setDevInboxEntries([]);
    } catch (e: any) {
      setDevInboxError(e?.message ?? String(e));
    } finally {
      setDevInboxBusy(false);
    }
  }

  function devInboxToken(entry: any): string | null {
    return entry.text_body?.match(/token=([0-9a-fA-F]+)/)?.[1] ?? null;
  }
  function devInboxKind(entry: any): 'magiclink' | 'recovery' | null {
    if (entry.text_body?.includes('/auth/magiclink/verify')) return 'magiclink';
    if (entry.text_body?.includes('/auth/verify')) return 'recovery';
    return null;
  }
  function useDevInboxToken(entry: any) {
    const token = devInboxToken(entry);
    if (!token) return;
    if (devInboxKind(entry) === 'magiclink') setMagicToken(token);
    else setRecoverToken(token);
  }

  const inputCls =
    'h-8 rounded-md border border-border bg-secondary px-2 text-md outline-none focus-visible:border-border-strong focus-visible:ring-[2px] focus-visible:ring-ring/40';
  const btnCls = 'h-8 rounded-md bg-brand px-3 text-md font-semibold text-brand-text-on hover:bg-brand-hover disabled:opacity-45';
  const ghostBtnCls = 'h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong disabled:opacity-45';

  return (
    <div className="flex flex-col gap-4">
      {/* Credential flow tester */}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="border-b border-border bg-secondary px-3 py-2 text-xs font-semibold tracking-wide text-text-muted uppercase">
          Credential flow tester — POST /auth/{'{login,signup,refresh,logout}'}
        </div>
        <div className="flex flex-col gap-3 p-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm text-text-light">
              Username
              <input value={flowUsername} onChange={(e) => setFlowUsername(e.target.value)} placeholder="alice" spellCheck={false} className={inputCls} />
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-light">
              Password
              <input type="password" value={flowPassword} onChange={(e) => setFlowPassword(e.target.value)} className={inputCls} />
            </label>
          </div>
          <div className="flex gap-2">
            <button className={btnCls} onClick={doLogin} disabled={flowBusy !== null || !flowUsername || !flowPassword}>
              {flowBusy === 'login' ? 'Logging in…' : 'Login'}
            </button>
            <button className={ghostBtnCls} onClick={doSignup} disabled={flowBusy !== null || !flowUsername || !flowPassword}>
              {flowBusy === 'signup' ? 'Signing up…' : 'Signup'}
            </button>
          </div>

          {mfaLoginChallenge && (
            <div className="flex flex-col gap-2 rounded-md border border-warn/35 bg-warn/8 px-3 py-2">
              <span className="text-md">This account has MFA enabled — enter a live TOTP or recovery code.</span>
              <div className="flex gap-2">
                <input
                  value={mfaLoginCode}
                  onChange={(e) => setMfaLoginCode(e.target.value)}
                  placeholder="123456"
                  className={cn(inputCls, 'flex-1')}
                  onKeyDown={(e) => e.key === 'Enter' && doMfaLoginChallenge()}
                />
                <button className={btnCls} onClick={doMfaLoginChallenge} disabled={mfaLoginBusy || !mfaLoginCode}>
                  {mfaLoginBusy ? 'Verifying…' : 'Verify'}
                </button>
              </div>
              {mfaLoginError && <p className="m-0 text-sm text-error">{mfaLoginError}</p>}
            </div>
          )}

          {Object.values(oauthProviders).some(Boolean) && (
            <div className="flex flex-col gap-1.5 border-t border-border-muted pt-3">
              <span className="text-sm text-text-light">Or sign in with</span>
              <div className="flex flex-wrap gap-2">
                {Object.entries(OAUTH_PROVIDER_LABELS)
                  .filter(([p]) => oauthProviders[p])
                  .map(([p, label]) => (
                    <button key={p} className={ghostBtnCls} onClick={() => startOauth(p)}>
                      {label}
                    </button>
                  ))}
              </div>
              <p className="m-0 text-xs text-text-muted">
                Real browser redirect to <code>GET /auth/oauth/&lt;provider&gt;/authorize</code> — leaves this page.
              </p>
            </div>
          )}
          {oauthBusy && <p className="m-0 text-sm text-text-light">Completing OAuth sign-in…</p>}
          {oauthError && <p className="m-0 text-sm text-error">{oauthError}</p>}

          <div className="flex items-end gap-2 border-t border-border-muted pt-3">
            <label className="flex flex-1 flex-col gap-1 text-sm text-text-light">
              Refresh token
              <input
                value={flowRefreshInput}
                onChange={(e) => setFlowRefreshInput(e.target.value)}
                placeholder="(from a login/signup/refresh above)"
                spellCheck={false}
                className={cn(inputCls, 'font-mono')}
              />
            </label>
            <button className={ghostBtnCls} onClick={doRefresh} disabled={flowBusy !== null || !flowRefreshInput}>
              {flowBusy === 'refresh' ? 'Refreshing…' : 'Refresh'}
            </button>
            <button className={ghostBtnCls} onClick={doLogout} disabled={flowBusy !== null || !flowRefreshInput}>
              {flowBusy === 'logout' ? 'Logging out…' : 'Logout'}
            </button>
          </div>

          {flowError && <ErrorBox error={{ message: flowError }} />}

          {session && (
            <div className="flex flex-col gap-1 rounded-md border border-ok/35 bg-ok/8 px-3 py-2 font-mono text-sm">
              <div className="truncate">access_token: {session.accessToken}</div>
              <div className="truncate">refresh_token: {session.refreshToken}</div>
              <div>expires_in: {session.expiresIn}s</div>
              <p className="m-0 font-sans text-xs text-text-muted">In-memory only — never persisted, never applied as this Studio's own bearer token.</p>
            </div>
          )}
        </div>
      </div>

      {/* TOTP MFA */}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center gap-1.5 border-b border-border bg-secondary px-3 py-2 text-xs font-semibold tracking-wide text-text-muted uppercase">
          <ShieldCheck className="size-3.5" /> TOTP multi-factor auth (item 127) — acts on the account you're logged in as above
        </div>
        <div className="flex flex-col gap-3 p-4">
          {!mfaSecret && !mfaEnabled && (
            <button className={ghostBtnCls} onClick={doMfaEnroll} disabled={mfaBusy}>
              {mfaBusy ? 'Enrolling…' : 'Enroll'}
            </button>
          )}
          {mfaSecret && !mfaEnabled && (
            <div className="flex flex-col gap-2">
              <p className="m-0 text-sm text-text-light">
                Add this to your authenticator app — QR rendering is deliberately not built (see the code comment in this file for why); the secret and
                URI below both work for manual entry.
              </p>
              <code className="rounded-md border border-border bg-secondary px-2 py-1 font-mono text-sm break-all">{mfaSecret.secret}</code>
              <code className="rounded-md border border-border bg-secondary px-2 py-1 font-mono text-xs break-all text-text-muted">{mfaSecret.otpauthUrl}</code>
              <div className="flex gap-2">
                <input value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} placeholder="123456" className={inputCls} />
                <button className={btnCls} onClick={doMfaVerify} disabled={mfaBusy || !mfaCode}>
                  {mfaBusy ? 'Verifying…' : 'Verify & enable'}
                </button>
              </div>
            </div>
          )}
          {mfaRecoveryCodes && (
            <div className="flex flex-col gap-1 rounded-md border border-warn/35 bg-warn/8 px-3 py-2">
              <span className="text-sm font-semibold">Recovery codes — shown once, save them now:</span>
              <div className="grid grid-cols-4 gap-1 font-mono text-sm">
                {mfaRecoveryCodes.map((c) => (
                  <span key={c}>{c}</span>
                ))}
              </div>
            </div>
          )}
          {mfaEnabled && (
            <div className="flex items-end gap-2">
              <label className="flex flex-col gap-1 text-sm text-text-light">
                Disable code (blank if superuser)
                <input value={mfaDisableCode} onChange={(e) => setMfaDisableCode(e.target.value)} placeholder="123456" className={inputCls} />
              </label>
              <button className={ghostBtnCls} onClick={doMfaDisable} disabled={mfaBusy}>
                {mfaBusy ? 'Disabling…' : 'Disable MFA'}
              </button>
            </div>
          )}
          {mfaError && <p className="m-0 text-sm text-error">{mfaError}</p>}
        </div>
      </div>

      {/* Email auth flows + dev-inbox */}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center gap-1.5 border-b border-border bg-secondary px-3 py-2 text-xs font-semibold tracking-wide text-text-muted uppercase">
          <Mail className="size-3.5" /> Email auth flows (item 138) + dev inbox (item 145)
        </div>
        <div className="grid grid-cols-2 gap-4 p-4">
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold tracking-wide text-text-muted uppercase">Password recovery</span>
            <label className="flex flex-col gap-1 text-sm text-text-light">
              Email / username
              <input value={recoverEmail} onChange={(e) => setRecoverEmail(e.target.value)} placeholder="alice" spellCheck={false} className={inputCls} />
            </label>
            <button className={ghostBtnCls} onClick={doRecover} disabled={recoverBusy || !recoverEmail}>
              {recoverBusy ? 'Sending…' : 'Send recovery email'}
            </button>
            {recoverSent && <p className="m-0 text-sm text-ok">Request accepted (200) — if that account exists, an email was sent.</p>}
            {recoverError && <p className="m-0 text-sm text-error">{recoverError}</p>}
            <label className="mt-2 flex flex-col gap-1 text-sm text-text-light">
              Recovery token
              <input value={recoverToken} onChange={(e) => setRecoverToken(e.target.value)} placeholder="opaque hex token" spellCheck={false} className={cn(inputCls, 'font-mono')} />
            </label>
            <label className="flex flex-col gap-1 text-sm text-text-light">
              New password
              <input type="password" value={recoverNewPass} onChange={(e) => setRecoverNewPass(e.target.value)} className={inputCls} />
            </label>
            <button className={ghostBtnCls} onClick={doRecoverVerify} disabled={recoverVerifyBusy || !recoverToken || !recoverNewPass}>
              {recoverVerifyBusy ? 'Resetting…' : 'Redeem token'}
            </button>
            {recoverVerifyDone && <p className="m-0 text-sm text-ok">Password reset. Every existing session for that user is now revoked.</p>}
            {recoverVerifyError && <p className="m-0 text-sm text-error">{recoverVerifyError}</p>}
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold tracking-wide text-text-muted uppercase">Magic link</span>
            <label className="flex flex-col gap-1 text-sm text-text-light">
              Email / username
              <input value={magicEmail} onChange={(e) => setMagicEmail(e.target.value)} placeholder="alice" spellCheck={false} className={inputCls} />
            </label>
            <button className={ghostBtnCls} onClick={doMagicLink} disabled={magicBusy || !magicEmail}>
              {magicBusy ? 'Sending…' : 'Send magic link'}
            </button>
            {magicSent && <p className="m-0 text-sm text-ok">Request accepted (200) — if that account exists, an email was sent.</p>}
            {magicError && <p className="m-0 text-sm text-error">{magicError}</p>}
            <label className="mt-2 flex flex-col gap-1 text-sm text-text-light">
              Magic-link token
              <input value={magicToken} onChange={(e) => setMagicToken(e.target.value)} placeholder="opaque hex token" spellCheck={false} className={cn(inputCls, 'font-mono')} />
            </label>
            <button className={ghostBtnCls} onClick={doMagicVerify} disabled={magicVerifyBusy || !magicToken}>
              {magicVerifyBusy ? 'Redeeming…' : 'Redeem token → sign in'}
            </button>
            {magicVerifyError && <p className="m-0 text-sm text-error">{magicVerifyError}</p>}
          </div>
        </div>

        <div className="border-t border-border p-4">
          {devInboxBusy && devInboxSupported === null && !devInboxError ? (
            <p className="m-0 text-sm text-text-light">Checking dev-inbox availability…</p>
          ) : devInboxSupported ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-text-muted uppercase">
                  <Inbox className="size-3.5" /> Dev inbox
                </span>
                <div className="flex gap-2">
                  <button className={ghostBtnCls} onClick={loadDevInbox} disabled={devInboxBusy}>
                    {devInboxBusy ? 'Loading…' : 'Refresh'}
                  </button>
                  <button className={ghostBtnCls} onClick={doClearDevInbox} disabled={devInboxBusy || !devInboxEntries.length}>
                    Clear
                  </button>
                </div>
              </div>
              {devInboxEntries.length === 0 ? (
                <p className="m-0 text-sm text-text-light">No captured emails yet — send a recovery or magic-link request above.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {devInboxEntries.map((entry, i) => (
                    <div key={i} className="flex flex-col gap-1 rounded-md border border-border bg-secondary px-3 py-2">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="font-mono text-sm font-semibold">{entry.to}</span>
                        <span className="text-sm">{entry.subject}</span>
                        <span className="text-xs text-text-muted">{new Date(entry.ts * 1000).toLocaleString()}</span>
                      </div>
                      {devInboxToken(entry) && (
                        <button className={cn(ghostBtnCls, 'h-6 self-start px-2 text-xs')} onClick={() => useDevInboxToken(entry)}>
                          Use this {devInboxKind(entry) === 'magiclink' ? 'magic-link' : 'recovery'} token →
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : devInboxError ? (
            <p className="m-0 text-sm text-error">Dev inbox: {devInboxError}</p>
          ) : (
            <p className="m-0 text-sm text-text-light">
              Dev inbox not available — this server's <code>UNIDB_EMAIL_TRANSPORT</code> is <code>smtp</code>, so <code>GET /auth/dev-inbox</code> is a 404 by
              design (item 145's first gate). Paste a token above from wherever the real email landed.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
