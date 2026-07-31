<script>
  import { getAuthMeta, getWhoami } from './api.js';

  // Authentication panel (Workstream G1 — see ../../docs/AUTH_POLICY_PANELS_PLAN.md).
  //
  // Per CLAUDE.md: never show mock/hardcoded data. Everything rendered here is
  // real, live engine data (GET /auth/meta + GET /auth/whoami, both item 100,
  // already shipped). Credentialed signup/login/sessions depend on engine
  // Workstream A (../unidb/docs/backlog/121_auth_core.md) — NOT STARTED — so
  // those sections are explicit "not available yet" status cards, not fake
  // forms that would silently do nothing.
  //
  // User/role administration (create/drop user, superuser flag) is already
  // real today via item 24 — that lives in the Roles tab (G3), not duplicated
  // here.

  let loading  = $state(true);
  let error    = $state(null);
  let meta     = $state(null); // GET /auth/meta
  let whoami   = $state(null); // GET /auth/whoami

  $effect(() => { load(); });

  async function load() {
    loading = true;
    error = null;
    try {
      const [m, w] = await Promise.all([getAuthMeta(), getWhoami()]);
      meta = m;
      whoami = w;
    } catch (e) {
      error = { code: e.code, message: e.message, status: e.status };
    } finally {
      loading = false;
    }
  }

  // Workstream A (item 121) scope — none of this exists on the engine yet.
  const PENDING = [
    { name: 'Password credential store', detail: "CREATE USER … PASSWORD '…' + argon2id hashing", ref: 'A1' },
    { name: 'Password login', detail: 'POST /auth/login verifies a real password (today it only checks the user exists)', ref: 'A2' },
    { name: 'Signup', detail: 'POST /auth/signup (opt-in, UNIDB_ALLOW_SIGNUP)', ref: 'A3' },
    { name: 'Refresh tokens & sessions', detail: 'POST /auth/refresh, POST /auth/logout, session revocation', ref: 'A4' },
    { name: 'Production token issuer', detail: 'Un-gate issuance from UNIDB_DEV_LOGIN behind an explicit signing-key config', ref: 'A5' },
    { name: 'Asymmetric JWT / JWKS', detail: 'RS256/ES256 verification + GET /.well-known/jwks.json', ref: 'A6' },
  ];
</script>

<div class="auth">
  {#if loading}
    <p class="muted">Loading…</p>
  {:else if error}
    <p class="err">{error.code}: {error.message}</p>
  {:else}
    <div class="grid">
      <section class="card">
        <h3>Server auth configuration</h3>
        {#if !meta?.supported}
          <p class="muted small">GET /auth/meta not available on this server.</p>
        {:else}
          <dl>
            <dt>Mode</dt>
            <dd>
              {#if meta.open_mode}
                <span class="pill warn">open mode — no users registered, everyone has full access</span>
              {:else}
                <span class="pill ok">enforced — per-user privileges active</span>
              {/if}
            </dd>
            <dt>Dev login (<code>POST /auth/login</code>)</dt>
            <dd>
              {#if meta.dev_login_enabled}
                <span class="pill warn">enabled — passwordless, dev/demo only</span>
              {:else}
                <span class="pill muted">disabled</span>
              {/if}
            </dd>
            {#if meta.privilege_types?.length}
              <dt>Privilege types</dt>
              <dd class="mono">{meta.privilege_types.join(', ')}</dd>
            {/if}
            {#if meta.catalog_tables?.length}
              <dt>Auth catalog relations</dt>
              <dd class="mono">{meta.catalog_tables.join(', ')}</dd>
            {/if}
          </dl>
        {/if}
      </section>

      <section class="card">
        <h3>Signed in as</h3>
        {#if !whoami?.supported}
          <p class="muted small">GET /auth/whoami not available on this server.</p>
        {:else}
          <dl>
            <dt>User</dt>
            <dd class="mono">{whoami.user ?? '(no identity — open mode / embedded)'}</dd>
            <dt>Superuser</dt>
            <dd>{whoami.is_superuser ? 'yes' : 'no'}</dd>
            <dt>Roles</dt>
            <dd>
              {#if whoami.roles?.length}
                <span class="chips">{#each whoami.roles as r}<span class="chip">{r}</span>{/each}</span>
              {:else}
                <span class="muted small">none</span>
              {/if}
            </dd>
            <dt>Table privileges</dt>
            <dd>
              {#if whoami.privileges?.length}
                <ul class="priv-list">
                  {#each whoami.privileges as p}
                    <li><span class="mono">{p.table}</span> — {p.ops?.join(', ')}</li>
                  {/each}
                </ul>
              {:else}
                <span class="muted small">none (or superuser — bypasses grants)</span>
              {/if}
            </dd>
          </dl>
        {/if}
      </section>
    </div>

    <section class="card">
      <h3>User administration</h3>
      <p class="muted small">
        Creating/dropping users, marking superuser, and role membership are already live —
        see the <strong>Roles</strong> tab. Password-based credentials aren't part of that
        surface yet (see below).
      </p>
    </section>

    <section class="card pending-card">
      <h3>Not yet available — Workstream A (engine item 121)</h3>
      <p class="muted small">
        These depend on engine changes that haven't shipped
        (<code>unidb/docs/backlog/121_auth_core.md</code>, status: NOT STARTED). Shown here so
        the panel's shape is ready to wire up the moment they land — nothing below is
        interactive or fabricated.
      </p>
      <ul class="pending-list">
        {#each PENDING as item}
          <li>
            <span class="pending-badge">{item.ref}</span>
            <div>
              <div class="pending-name">{item.name}</div>
              <div class="pending-detail">{item.detail}</div>
            </div>
            <span class="pill muted">not available</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

<style>
  .auth { display: flex; flex-direction: column; gap: 16px; max-width: 900px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }

  .card {
    border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px;
    background: var(--panel);
  }
  .card h3 { margin: 0 0 10px; font-size: 13px; font-weight: 700; color: var(--text); }

  dl { margin: 0; display: flex; flex-direction: column; gap: 8px; }
  dt { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  dd { margin: 2px 0 0; font-size: 13px; }
  .mono { font-family: var(--mono); }

  .pill {
    display: inline-block; font-size: 11px; font-weight: 600; border-radius: 10px;
    padding: 2px 9px;
  }
  .pill.ok   { background: rgba(22,163,74,0.14); color: #15803d; }
  .pill.warn { background: rgba(217,119,6,0.14); color: #b45309; }
  .pill.muted { background: var(--panel-alt); color: var(--muted); }

  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    font-family: var(--mono); font-size: 11px; background: var(--panel-alt);
    border: 1px solid var(--border); border-radius: 10px; padding: 1px 8px;
  }
  .priv-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 12px; }

  .pending-card { background: var(--panel-alt); }
  .pending-list { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .pending-list li {
    display: flex; align-items: center; gap: 10px;
    background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px;
  }
  .pending-badge {
    font-family: var(--mono); font-size: 10px; font-weight: 700; color: var(--muted);
    background: var(--panel-alt); border-radius: 4px; padding: 2px 6px; flex-shrink: 0;
  }
  .pending-name { font-size: 13px; font-weight: 600; }
  .pending-detail { font-size: 11px; color: var(--muted); margin-top: 1px; }
  .pending-list li > div:nth-child(2) { flex: 1; min-width: 0; }

  .muted { color: var(--muted); }
  .small { font-size: 12px; }
  .err { color: var(--err-fg); }
</style>
