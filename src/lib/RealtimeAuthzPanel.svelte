<script>
  import { listChannelPolicies, putChannelPolicy, deleteChannelPolicy, getAuthzSnapshot, RESERVED_ROLES } from './api.js';

  // Realtime channel authorization panel (item 140, PR #243) — an opt-in,
  // RLS-style allow/deny layer in front of the four broadcast/presence
  // routes. Mirrors PoliciesPanel's (G2) shape/conventions: a policy list +
  // upsert form, role-chip picker reusing the same RESERVED_ROLES +
  // getAuthzSnapshot this Studio already uses for RLS policies.
  //
  // `UNIDB_REALTIME_REQUIRE_AUTHZ`'s CURRENT value is not exposed by any
  // route (unlike GET /auth/meta's dev_login_enabled/signup_enabled) — a
  // pure static SPA has no way to read a server env var directly, so the
  // note below documents the two postures and their behavior rather than
  // claiming to show a live-fetched value that doesn't exist as an API.

  let supported = $state(true);
  let loading   = $state(true);
  let loadError = $state(null);
  let policies  = $state([]); // [{topic_pattern, operation, roles}]
  let roles     = $state([]); // custom (non-built-in) roles, for the role picker

  const OPERATIONS = ['publish', 'subscribe', 'presence', 'all'];
  const roleChoices = $derived([...RESERVED_ROLES, ...roles]);

  $effect(() => { load(); });

  async function load() {
    loading = true;
    loadError = null;
    try {
      const [out, snap] = await Promise.all([listChannelPolicies(), getAuthzSnapshot()]);
      supported = out.supported;
      policies = out.policies;
      roles = snap.supported ? snap.roles : [];
    } catch (e) {
      loadError = { code: e.code, message: e.message, status: e.status };
    } finally {
      loading = false;
    }
  }

  // ── new policy modal ──────────────────────────────────────────────────────
  let newOpen    = $state(false);
  let newTopic   = $state('');
  let newOp      = $state('all');
  let newRoles   = $state([]);
  let newBusy    = $state(false);
  let newError   = $state(null);

  function toggleNewRole(role) {
    newRoles = newRoles.includes(role) ? newRoles.filter((r) => r !== role) : [...newRoles, role];
  }

  function openNew() {
    newTopic = '';
    newOp = 'all';
    newRoles = [];
    newError = null;
    newOpen = true;
  }

  async function submitNew() {
    newError = null;
    const topic = newTopic.trim();
    if (!topic) { newError = 'topic_pattern is required (an exact topic, or a *-suffix glob like "room:*").'; return; }
    if (newRoles.length === 0) { newError = 'Select at least one allowed role.'; return; }
    newBusy = true;
    try {
      await putChannelPolicy(topic, newOp, newRoles);
      newOpen = false;
      await load();
    } catch (e) {
      newError = e.message ?? String(e);
    } finally {
      newBusy = false;
    }
  }

  let dropTarget = $state(null); // { topic_pattern, operation } | null
  let dropBusy   = $state(false);
  let dropError  = $state(null);

  async function confirmDrop() {
    dropBusy = true;
    dropError = null;
    try {
      await deleteChannelPolicy(dropTarget.topic_pattern, dropTarget.operation);
      dropTarget = null;
      await load();
    } catch (e) {
      dropError = e.message ?? String(e);
    } finally {
      dropBusy = false;
    }
  }
</script>

<div class="realtime-authz">
  {#if loadError}
    <div class="unsupported">
      <h3>Couldn't load channel policies</h3>
      <p class="err">{loadError.code}: {loadError.message}</p>
    </div>
  {:else if !loading && !supported}
    <div class="unsupported">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M12 3v6M12 15v6M4.2 7.5l5.2 3M14.6 13.5l5.2 3M19.8 7.5l-5.2 3M9.4 13.5l-5.2 3"/>
      </svg>
      <h3>Channel authorization not available</h3>
      <p>This server doesn't expose <code>GET /realtime/policies</code> yet (needs item-140 support).</p>
    </div>
  {:else}
    <div class="toolbar">
      <strong class="toolbar-title">Realtime channel policies</strong>
      <span class="grow"></span>
      <button onclick={openNew} disabled={roleChoices.length === 0}>+ New policy</button>
    </div>

    <p class="hint">
      An allow/deny layer in front of broadcast publish/subscribe and presence. Most-specific
      topic match wins (an exact topic beats a <code>*</code> glob); a caller must hold one of a
      matching policy's roles, <code>403</code> otherwise. <code>service_role</code> and
      superuser tokens bypass every policy (audited, same as every other RLS bypass).
    </p>
    <p class="posture-note">
      <strong>Default posture — <code>UNIDB_REALTIME_REQUIRE_AUTHZ</code></strong> (server env var;
      not readable from this static SPA, so shown here as documentation, not a live value):
      <strong>off</strong> (default) — a topic with no matching policy stays open to any
      authenticated caller. <strong>on</strong> — a topic with no matching policy is denied,
      fail-closed. Either way, a topic that <em>does</em> match a policy below is always enforced.
    </p>

    {#if loading}
      <p class="muted">Loading…</p>
    {:else if policies.length === 0}
      <p class="muted">No channel policies yet — every topic currently follows the default posture above.</p>
    {:else}
      <ul class="policy-list">
        {#each policies as p}
          <li class="policy-card">
            <div class="pc-head">
              <span class="pc-topic mono">{p.topic_pattern}</span>
              <span class="pc-op">{p.operation}</span>
              <span class="grow"></span>
              <button class="del-btn" title="Remove policy" onclick={() => (dropTarget = { topic_pattern: p.topic_pattern, operation: p.operation })}>✕</button>
            </div>
            <div class="pc-roles">
              {#each p.roles as r}<span class="role-badge">{r}</span>{/each}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<!-- ── New policy modal ── -->
{#if newOpen}
  <div class="modal-backdrop" role="presentation" onpointerdown={() => (newOpen = false)}>
    <div class="modal" role="dialog" aria-label="New channel policy" onpointerdown={(e) => e.stopPropagation()}>
      <div class="modal-head">
        <strong>New channel policy</strong>
        <button class="x" onclick={() => (newOpen = false)}>✕</button>
      </div>
      <div class="modal-body">
        <label class="field">
          <span class="flabel">topic_pattern</span>
          <input bind:value={newTopic} placeholder={'e.g. room:* or room:42'} spellcheck="false" class="mono-input" />
        </label>
        <label class="field">
          <span class="flabel">operation</span>
          <select bind:value={newOp}>
            {#each OPERATIONS as op}<option value={op}>{op}</option>{/each}
          </select>
        </label>
        <div class="field">
          <span class="flabel">Allowed roles</span>
          {#if roleChoices.length === 0}
            <p class="muted small">No roles yet — create one in the Roles tab first.</p>
          {:else}
            <div class="role-chips">
              {#each roleChoices as r}
                <button
                  type="button"
                  class="role-chip"
                  class:selected={newRoles.includes(r)}
                  onclick={() => toggleNewRole(r)}
                >{r}</button>
              {/each}
            </div>
          {/if}
        </div>
        {#if newError}<p class="err">{newError}</p>{/if}
      </div>
      <div class="modal-foot">
        <span class="grow"></span>
        <button class="ghost" onclick={() => (newOpen = false)}>Cancel</button>
        <button onclick={submitNew} disabled={newBusy}>{newBusy ? 'Saving…' : 'Save policy'}</button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Drop confirm ── -->
{#if dropTarget}
  <div class="modal-backdrop" role="presentation" onpointerdown={() => (dropTarget = null)}>
    <div class="modal del-modal" role="dialog" onpointerdown={(e) => e.stopPropagation()}>
      <div class="modal-head">
        <strong>Remove policy</strong>
        <button class="x" onclick={() => (dropTarget = null)}>✕</button>
      </div>
      <div class="modal-body">
        <p class="del-msg">Remove the policy on <code>{dropTarget.topic_pattern}</code> ({dropTarget.operation})?</p>
        {#if dropError}<p class="err">{dropError}</p>{/if}
      </div>
      <div class="modal-foot">
        <span class="grow"></span>
        <button class="ghost" onclick={() => (dropTarget = null)}>Cancel</button>
        <button class="del-btn" onclick={confirmDrop} disabled={dropBusy}>{dropBusy ? 'Removing…' : 'Remove'}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .realtime-authz { display: flex; flex-direction: column; gap: 12px; height: 100%; overflow-y: auto; padding: 16px 20px; }

  .unsupported {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 12px; height: 100%; color: var(--muted); text-align: center; padding: 40px;
  }
  .unsupported h3 { margin: 0; font-size: 16px; color: var(--text); }
  .unsupported p  { margin: 0; font-size: 13px; line-height: 1.6; }

  .toolbar { display: flex; align-items: center; gap: 10px; }
  .toolbar-title { font-size: 15px; }
  .grow { flex: 1; }
  .toolbar button:not(.ghost) {
    background: var(--accent); color: #fff; border: none;
    border-radius: 6px; padding: 6px 14px; font-size: 13px; cursor: pointer;
  }
  .toolbar button:disabled { opacity: 0.5; cursor: default; }

  .hint { font-size: 12px; color: var(--muted); line-height: 1.6; margin: 0; }
  .hint code { font-family: var(--mono); background: var(--panel-alt); border-radius: 4px; padding: 1px 4px; }
  .posture-note {
    margin: 0; font-size: 11px; color: var(--muted); line-height: 1.6;
    background: var(--panel-alt); border: 1px solid var(--border); border-radius: 6px;
    padding: 8px 10px;
  }
  .posture-note code { font-family: var(--mono); background: var(--panel); border-radius: 3px; padding: 0 3px; }

  .policy-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .policy-card {
    border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px;
    display: flex; flex-direction: column; gap: 6px; background: var(--panel);
  }
  .pc-head { display: flex; align-items: center; gap: 8px; }
  .pc-topic { font-weight: 600; font-size: 13px; }
  .pc-op {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent);
    border-radius: 4px; padding: 1px 6px;
  }
  .del-btn { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 12px; }
  .del-btn:hover { color: var(--err-fg); }
  .pc-roles { display: flex; flex-wrap: wrap; gap: 4px; }
  .role-badge {
    font-family: var(--mono); font-size: 11px; background: var(--panel-alt);
    border: 1px solid var(--border); border-radius: 10px; padding: 1px 8px;
  }
  .mono { font-family: var(--mono); }

  .muted { color: var(--muted); }
  .small { font-size: 12px; }
  .err { color: var(--err-fg); }

  /* ── modal (shared pattern) ── */
  .modal-backdrop {
    position: fixed; inset: 0; z-index: 30;
    background: rgba(0,0,0,0.4);
    display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  .modal {
    width: min(440px, 100%); display: flex; flex-direction: column;
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.3); overflow: hidden; max-height: 90vh;
  }
  .del-modal { width: min(420px, 100%); }
  .modal-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 14px; border-bottom: 1px solid var(--border); flex-shrink: 0;
  }
  .modal-body { padding: 14px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
  .modal-foot { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--border); flex-shrink: 0; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .flabel { font-size: 12px; font-weight: 600; }
  .field input, .field select {
    padding: 7px 10px; font-size: 13px; color: var(--text); background: var(--panel);
    border: 1px solid var(--border); border-radius: 6px;
  }
  .mono-input { font-family: var(--mono); }
  .field input:focus, .field select:focus { outline: none; border-color: var(--accent); }

  .role-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .role-chip {
    font-family: var(--mono); font-size: 11px; padding: 3px 9px; border-radius: 12px;
    border: 1px solid var(--border); background: var(--panel); color: var(--text); cursor: pointer;
  }
  .role-chip:hover { border-color: var(--accent); }
  .role-chip.selected { background: var(--accent); color: #fff; border-color: var(--accent); }

  .x { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 13px; }
  .x:hover { color: var(--err-fg); }
  .del-msg { margin: 0; font-size: 13px; line-height: 1.6; }
  .del-msg code { font-family: var(--mono); background: var(--panel-alt); padding: 1px 5px; border-radius: 4px; }
  .modal-foot button:not(.ghost):not(.del-btn) {
    background: var(--accent); color: #fff; border: none;
    border-radius: 6px; padding: 7px 14px; font-size: 13px; cursor: pointer;
  }
  .modal-foot .del-btn {
    background: var(--err-fg, #ef4444); color: #fff; border: none;
    border-radius: 6px; padding: 7px 14px; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .modal-foot button:disabled { opacity: 0.5; cursor: default; }
</style>
