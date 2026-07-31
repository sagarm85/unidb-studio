<script>
  import { getAuthzSnapshot, runSql } from './api.js';

  // Roles / grants UI (Workstream G3 — see ../../docs/AUTH_POLICY_PANELS_PLAN.md).
  // Pure UI over the item-24 RBAC engine, which already ships: users, roles,
  // transitive role membership, and per-table GRANT/REVOKE. Everything here
  // reads `unidb_catalog.{users,roles,grants,role_members}` and writes via the
  // hand-rolled auth DDL documented in
  // ../unidb/docs/REST_API.md#authorization--roles-grants-and-rls-item-24.
  //
  // That DDL is parsed by whitespace-splitting (not the SQL tokenizer), so
  // names may not contain whitespace; IDENT_RE enforces that client-side.
  let { tables = [] } = $props();

  const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
  const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  let supported   = $state(true);
  let loading     = $state(true);
  let loadError   = $state(null);
  let users       = $state([]);        // [{name, isSuperuser}]
  let roles       = $state([]);        // [name]
  let grants      = $state([]);        // [{grantee, table, op}]
  let roleMembers = $state([]);        // [{role, member}]

  let selected = $state(null); // { type: 'user'|'role', name }
  let actionBusy  = $state(false);
  let actionError = $state(null);

  // new-user / new-role modals
  let newUserOpen   = $state(false);
  let newUserName   = $state('');
  let newUserSuper  = $state(false);
  let newUserBusy   = $state(false);
  let newUserError  = $state(null);

  let newRoleOpen  = $state(false);
  let newRoleName  = $state('');
  let newRoleBusy  = $state(false);
  let newRoleError = $state(null);

  // add-membership picker
  let addMemberSel = $state('');

  $effect(() => { load(); });

  async function load() {
    loading = true;
    loadError = null;
    try {
      const snap = await getAuthzSnapshot();
      supported = snap.supported;
      users = snap.users;
      roles = snap.roles;
      grants = snap.grants;
      roleMembers = snap.roleMembers;
      if (selected) {
        const stillThere =
          (selected.type === 'user' && users.some((u) => u.name === selected.name)) ||
          (selected.type === 'role' && roles.includes(selected.name));
        if (!stillThere) selected = null;
      }
    } catch (e) {
      loadError = { code: e.code, message: e.message, status: e.status };
    } finally {
      loading = false;
    }
  }

  function select(type, name) {
    selected = { type, name };
    actionError = null;
    addMemberSel = '';
  }

  async function run(sql) {
    actionBusy = true;
    actionError = null;
    try {
      await runSql(sql);
      await load();
    } catch (e) {
      actionError = e.message ?? String(e);
    } finally {
      actionBusy = false;
    }
  }

  // ── users ──────────────────────────────────────────────────────────────
  async function submitNewUser() {
    newUserError = null;
    const n = newUserName.trim();
    if (!IDENT_RE.test(n)) { newUserError = 'Name must start with a letter/underscore and contain only letters, digits, underscore.'; return; }
    if (users.some((u) => u.name === n)) { newUserError = `User "${n}" already exists.`; return; }
    newUserBusy = true;
    try {
      await runSql(`CREATE USER ${n}${newUserSuper ? ' SUPERUSER' : ''}`);
      newUserOpen = false;
      newUserName = '';
      newUserSuper = false;
      await load();
      select('user', n);
    } catch (e) {
      newUserError = e.message ?? String(e);
    } finally {
      newUserBusy = false;
    }
  }

  function deleteUser(name) {
    if (!confirm(`Drop user "${name}"? This revokes all their grants and role memberships.`)) return;
    run(`DROP USER ${name}`);
  }

  // ── roles ──────────────────────────────────────────────────────────────
  async function submitNewRole() {
    newRoleError = null;
    const n = newRoleName.trim();
    if (!IDENT_RE.test(n)) { newRoleError = 'Name must start with a letter/underscore and contain only letters, digits, underscore.'; return; }
    if (roles.includes(n)) { newRoleError = `Role "${n}" already exists.`; return; }
    newRoleBusy = true;
    try {
      await runSql(`CREATE ROLE ${n}`);
      newRoleOpen = false;
      newRoleName = '';
      await load();
      select('role', n);
    } catch (e) {
      newRoleError = e.message ?? String(e);
    } finally {
      newRoleBusy = false;
    }
  }

  function deleteRole(name) {
    if (!confirm(`Drop role "${name}"? This revokes all its grants and memberships.`)) return;
    run(`DROP ROLE ${name}`);
  }

  // ── membership (GRANT <role> TO <grantee> / REVOKE <role> FROM <grantee>) ─
  const memberOf = $derived(
    selected ? roleMembers.filter((m) => m.member === selected.name).map((m) => m.role) : [],
  );
  const membersOf = $derived(
    selected?.type === 'role' ? roleMembers.filter((m) => m.role === selected.name).map((m) => m.member) : [],
  );
  // Candidates for "member of <role>": every role except self (a role can't be its own parent).
  const memberOfCandidates = $derived(
    selected ? roles.filter((r) => r !== selected.name && !memberOf.includes(r)) : [],
  );
  // Candidates to add as a member of the selected role: every user + role except self and existing members.
  const addMemberCandidates = $derived(
    selected?.type === 'role'
      ? [...users.map((u) => u.name), ...roles.filter((r) => r !== selected.name)].filter(
          (n) => n !== selected.name && !membersOf.includes(n),
        )
      : [],
  );

  function addMemberOf(role) {
    if (!selected) return;
    run(`GRANT ${role} TO ${selected.name}`);
  }
  function removeMemberOf(role) {
    if (!selected) return;
    run(`REVOKE ${role} FROM ${selected.name}`);
  }
  function addMember() {
    if (!selected || !addMemberSel) return;
    run(`GRANT ${selected.name} TO ${addMemberSel}`);
    addMemberSel = '';
  }
  function removeMember(member) {
    if (!selected) return;
    run(`REVOKE ${selected.name} FROM ${member}`);
  }

  // ── table grants (GRANT/REVOKE <priv> ON <table> TO/FROM <grantee>) ──────
  function hasPriv(table, priv) {
    return selected
      ? grants.some((g) => g.grantee === selected.name && g.table === table && g.op === priv)
      : false;
  }
  function togglePriv(table, priv) {
    if (!selected) return;
    if (hasPriv(table, priv)) {
      run(`REVOKE ${priv} ON ${table} FROM ${selected.name}`);
    } else {
      run(`GRANT ${priv} ON ${table} TO ${selected.name}`);
    }
  }
</script>

<div class="roles">
  {#if loadError}
    <div class="unsupported">
      <h3>Couldn't load roles</h3>
      <p class="err">{loadError.code}: {loadError.message}</p>
    </div>
  {:else if !loading && !supported}
    <div class="unsupported">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6l7-3z"/>
      </svg>
      <h3>Roles & grants not available</h3>
      <p>This server doesn't expose <code>unidb_catalog.users/roles/grants</code> yet
        (needs item-24 authorization support).</p>
    </div>
  {:else}
    <div class="layout">
      <!-- ── Users / Roles sidebar ── -->
      <aside class="rsidebar">
        <div class="sidebar-head">
          <span class="sidebar-title">Users</span>
          <button class="icon-btn" title="New user" onclick={() => (newUserOpen = true)}>+</button>
        </div>
        {#if loading}
          <p class="muted small">Loading…</p>
        {:else if users.length === 0}
          <p class="muted small">No users yet — server is in open mode.</p>
        {:else}
          <ul class="entity-list">
            {#each users as u}
              <li class:active={selected?.type === 'user' && selected.name === u.name}>
                <button class="entity-btn" onclick={() => select('user', u.name)}>
                  <span class="ename">{u.name}</span>
                  {#if u.isSuperuser}<span class="pill super">superuser</span>{/if}
                </button>
                <button class="del-btn" title="Drop user" onclick={(e) => { e.stopPropagation(); deleteUser(u.name); }}>✕</button>
              </li>
            {/each}
          </ul>
        {/if}

        <div class="sidebar-head">
          <span class="sidebar-title">Roles</span>
          <button class="icon-btn" title="New role" onclick={() => (newRoleOpen = true)}>+</button>
        </div>
        {#if !loading}
          {#if roles.length === 0}
            <p class="muted small">No roles yet.</p>
          {:else}
            <ul class="entity-list">
              {#each roles as r}
                <li class:active={selected?.type === 'role' && selected.name === r}>
                  <button class="entity-btn" onclick={() => select('role', r)}>
                    <span class="ename">{r}</span>
                  </button>
                  <button class="del-btn" title="Drop role" onclick={(e) => { e.stopPropagation(); deleteRole(r); }}>✕</button>
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
      </aside>

      <!-- ── Detail ── -->
      <div class="detail">
        {#if !selected}
          <div class="empty-state">
            <p>Select a user or role to manage its memberships and table grants.</p>
          </div>
        {:else}
          {@const isUser = selected.type === 'user'}
          {@const u = isUser ? users.find((x) => x.name === selected.name) : null}
          <div class="detail-head">
            <span class="kind-badge">{isUser ? 'User' : 'Role'}</span>
            <strong class="detail-name">{selected.name}</strong>
            {#if u?.isSuperuser}<span class="pill super">superuser</span>{/if}
          </div>

          {#if actionError}<p class="err small">{actionError}</p>{/if}

          <div class="detail-body">
            <section class="block">
              <h4>Member of</h4>
              {#if memberOf.length === 0}
                <p class="muted small">Not a member of any role.</p>
              {:else}
                <ul class="chip-list">
                  {#each memberOf as r}
                    <li class="chip">
                      {r}
                      <button title="Remove from {r}" onclick={() => removeMemberOf(r)} disabled={actionBusy}>✕</button>
                    </li>
                  {/each}
                </ul>
              {/if}
              {#if memberOfCandidates.length > 0}
                <select class="add-select" value="" disabled={actionBusy}
                  onchange={(e) => { const v = e.target.value; if (v) addMemberOf(v); e.target.value = ''; }}>
                  <option value="" disabled selected>+ Add to role…</option>
                  {#each memberOfCandidates as r}<option value={r}>{r}</option>{/each}
                </select>
              {/if}
            </section>

            {#if !isUser}
              <section class="block">
                <h4>Members</h4>
                {#if membersOf.length === 0}
                  <p class="muted small">No members yet.</p>
                {:else}
                  <ul class="chip-list">
                    {#each membersOf as m}
                      <li class="chip">
                        {m}
                        <button title="Remove {m} from {selected.name}" onclick={() => removeMember(m)} disabled={actionBusy}>✕</button>
                      </li>
                    {/each}
                  </ul>
                {/if}
                {#if addMemberCandidates.length > 0}
                  <div class="add-row">
                    <select bind:value={addMemberSel} disabled={actionBusy}>
                      <option value="">Pick a user or role…</option>
                      {#each addMemberCandidates as n}<option value={n}>{n}</option>{/each}
                    </select>
                    <button onclick={addMember} disabled={actionBusy || !addMemberSel}>Add</button>
                  </div>
                {/if}
              </section>
            {/if}

            <section class="block">
              <h4>Table grants</h4>
              {#if tables.length === 0}
                <p class="muted small">No tables yet.</p>
              {:else}
                <table class="grant-table">
                  <thead>
                    <tr>
                      <th>Table</th>
                      {#each PRIVS as p}<th class="center">{p}</th>{/each}
                    </tr>
                  </thead>
                  <tbody>
                    {#each tables as t}
                      <tr>
                        <td class="tname">{t.name}</td>
                        {#each PRIVS as p}
                          <td class="center">
                            <input
                              type="checkbox"
                              checked={hasPriv(t.name, p)}
                              disabled={actionBusy}
                              onchange={() => togglePriv(t.name, p)}
                              aria-label="{p} on {t.name} for {selected.name}"
                            />
                          </td>
                        {/each}
                      </tr>
                    {/each}
                  </tbody>
                </table>
              {/if}
            </section>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<!-- ── New user modal ── -->
{#if newUserOpen}
  <div class="modal-backdrop" role="presentation" onpointerdown={() => (newUserOpen = false)}>
    <div class="modal" role="dialog" aria-label="New user" onpointerdown={(e) => e.stopPropagation()}>
      <div class="modal-head">
        <strong>New user</strong>
        <button class="x" onclick={() => (newUserOpen = false)}>✕</button>
      </div>
      <div class="modal-body">
        <label class="field">
          <span class="flabel">Username</span>
          <input bind:value={newUserName} placeholder="e.g. analyst" spellcheck="false"
                 onkeydown={(e) => e.key === 'Enter' && submitNewUser()} />
        </label>
        <label class="check-field">
          <input type="checkbox" bind:checked={newUserSuper} />
          Superuser (bypasses all grants and RLS)
        </label>
        {#if newUserError}<p class="err">{newUserError}</p>{/if}
      </div>
      <div class="modal-foot">
        <span class="grow"></span>
        <button class="ghost" onclick={() => (newUserOpen = false)}>Cancel</button>
        <button onclick={submitNewUser} disabled={newUserBusy}>
          {newUserBusy ? 'Creating…' : 'Create user'}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- ── New role modal ── -->
{#if newRoleOpen}
  <div class="modal-backdrop" role="presentation" onpointerdown={() => (newRoleOpen = false)}>
    <div class="modal" role="dialog" aria-label="New role" onpointerdown={(e) => e.stopPropagation()}>
      <div class="modal-head">
        <strong>New role</strong>
        <button class="x" onclick={() => (newRoleOpen = false)}>✕</button>
      </div>
      <div class="modal-body">
        <label class="field">
          <span class="flabel">Role name</span>
          <input bind:value={newRoleName} placeholder="e.g. analyst" spellcheck="false"
                 onkeydown={(e) => e.key === 'Enter' && submitNewRole()} />
        </label>
        {#if newRoleError}<p class="err">{newRoleError}</p>{/if}
      </div>
      <div class="modal-foot">
        <span class="grow"></span>
        <button class="ghost" onclick={() => (newRoleOpen = false)}>Cancel</button>
        <button onclick={submitNewRole} disabled={newRoleBusy}>
          {newRoleBusy ? 'Creating…' : 'Create role'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .roles { display: flex; flex-direction: column; height: 100%; }

  .unsupported {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 12px; height: 100%; color: var(--muted); text-align: center; padding: 40px;
  }
  .unsupported h3 { margin: 0; font-size: 16px; color: var(--text); }
  .unsupported p  { margin: 0; font-size: 13px; line-height: 1.6; }

  .layout { display: flex; height: 100%; min-height: 0; }

  /* ── sidebar ── */
  .rsidebar {
    width: 240px; flex-shrink: 0;
    border-right: 1px solid var(--border);
    display: flex; flex-direction: column;
    background: var(--panel-alt);
    overflow-y: auto;
  }
  .sidebar-head {
    display: flex; align-items: center; gap: 4px;
    padding: 10px 12px 8px;
    border-bottom: 1px solid var(--border);
  }
  .sidebar-title {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.07em; color: var(--muted); flex: 1;
  }
  .icon-btn {
    background: none; border: 1px solid var(--border); border-radius: 4px;
    color: var(--muted); font-size: 14px; width: 22px; height: 22px;
    display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0;
  }
  .icon-btn:hover { color: var(--text); border-color: var(--accent); }

  .entity-list { list-style: none; margin: 0; padding: 4px 0 8px; }
  .entity-list li {
    display: flex; align-items: center; padding: 0 6px;
    border-radius: 6px; margin: 1px 4px;
  }
  .entity-list li.active { background: var(--accent); }
  .entity-list li.active .entity-btn { color: #fff; }
  .entity-list li.active .del-btn { color: rgba(255,255,255,0.6); }
  .entity-btn {
    flex: 1; display: flex; align-items: center; gap: 6px;
    background: none; border: none; padding: 7px 4px; cursor: pointer;
    color: var(--text); font-size: 13px; text-align: left; min-width: 0;
  }
  .ename { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pill {
    font-size: 9px; font-weight: 700; text-transform: uppercase;
    border-radius: 3px; padding: 1px 4px; flex-shrink: 0;
  }
  .pill.super { background: rgba(217,119,6,0.15); color: #b45309; }
  .del-btn {
    background: none; border: none; color: var(--muted); cursor: pointer;
    font-size: 12px; padding: 2px 4px; opacity: 0; flex-shrink: 0;
  }
  .entity-list li:hover .del-btn, .entity-list li.active .del-btn { opacity: 1; }
  .del-btn:hover { color: var(--err-fg); }

  /* ── detail ── */
  .detail { flex: 1; min-width: 0; overflow-y: auto; padding: 16px 20px; }
  .empty-state {
    display: flex; align-items: center; justify-content: center;
    height: 100%; color: var(--muted); font-size: 13px; text-align: center; padding: 40px;
  }
  .detail-head { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
  .kind-badge {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent);
    border-radius: 4px; padding: 2px 6px;
  }
  .detail-name { font-size: 16px; font-family: var(--mono); }

  .detail-body { display: flex; flex-direction: column; gap: 20px; max-width: 640px; }
  .block h4 {
    margin: 0 0 8px; font-size: 12px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.05em; color: var(--muted);
  }

  .chip-list { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    display: flex; align-items: center; gap: 6px;
    background: var(--panel-alt); border: 1px solid var(--border); border-radius: 14px;
    padding: 3px 6px 3px 10px; font-size: 12px; font-family: var(--mono);
  }
  .chip button {
    background: none; border: none; color: var(--muted); cursor: pointer;
    font-size: 11px; padding: 0 2px;
  }
  .chip button:hover { color: var(--err-fg); }

  .add-select {
    font-size: 12px; padding: 5px 8px; border-radius: 6px;
    border: 1px solid var(--border); background: var(--panel); color: var(--text);
  }
  .add-row { display: flex; gap: 8px; align-items: center; }
  .add-row select {
    font-size: 12px; padding: 5px 8px; border-radius: 6px;
    border: 1px solid var(--border); background: var(--panel); color: var(--text);
  }
  .add-row button {
    background: var(--accent); color: #fff; border: none; border-radius: 6px;
    padding: 5px 12px; font-size: 12px; cursor: pointer;
  }
  .add-row button:disabled { opacity: 0.5; cursor: default; }

  .grant-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .grant-table th, .grant-table td {
    padding: 7px 10px; border-bottom: 1px solid var(--border); text-align: left;
  }
  .grant-table th {
    font-size: 11px; font-weight: 600; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .grant-table .center { text-align: center; }
  .grant-table .tname { font-family: var(--mono); }
  .grant-table tr:last-child td { border-bottom: none; }
  .grant-table input[type=checkbox] { cursor: pointer; }

  .muted { color: var(--muted); }
  .small { font-size: 12px; }
  .err { color: var(--err-fg); }

  /* ── modals (shared pattern with StoragePanel) ── */
  .modal-backdrop {
    position: fixed; inset: 0; z-index: 30;
    background: rgba(0,0,0,0.4);
    display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  .modal {
    width: min(420px, 100%); display: flex; flex-direction: column;
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.3); overflow: hidden;
  }
  .modal-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 14px; border-bottom: 1px solid var(--border);
  }
  .modal-body { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
  .modal-foot { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--border); }
  .grow { flex: 1; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .flabel { font-size: 12px; font-weight: 600; }
  .field input {
    padding: 7px 10px; font-size: 13px; font-family: var(--mono);
    color: var(--text); background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
  }
  .field input:focus { outline: none; border-color: var(--accent); }
  .check-field { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text); cursor: pointer; }
  .x { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 13px; }
  .x:hover { color: var(--err-fg); }
  .ghost {
    background: none; border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); padding: 6px 12px; font-size: 13px; cursor: pointer;
  }
  .modal-foot button:not(.ghost) {
    background: var(--accent); color: #fff; border: none;
    border-radius: 6px; padding: 7px 14px; font-size: 13px; cursor: pointer;
  }
  .modal-foot button:disabled { opacity: 0.5; cursor: default; }
</style>
