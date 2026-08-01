<script>
  import { listWebhooks, upsertWebhook, deleteWebhook } from './api.js';

  // Database webhooks panel (item 141, PR #244) — Supabase-parity "Database
  // Webhooks": superuser registers a target_url to receive a POST on every
  // matching row change. Built entirely on the existing durable event queue
  // (a delivery worker owns its own consumer, `__webhooks__`) — no
  // storage-engine change. `GET /webhooks` always redacts the signing
  // secret server-side (`has_signing_secret: bool` only) — this panel never
  // displays one, and the create/edit form's secret field is write-only
  // (cleared on every open, never pre-filled from a fetched webhook).

  let { tables = [] } = $props();

  let loading   = $state(true);
  let error     = $state(null);
  let supported = $state(true);
  let webhooks  = $state([]); // [{id, target_url, table_pattern, events, enabled, has_signing_secret, headers}]

  $effect(() => { load(); });

  async function load() {
    loading = true;
    error = null;
    try {
      const out = await listWebhooks();
      supported = out.supported;
      webhooks = out.webhooks;
    } catch (e) {
      error = { code: e.code, message: e.message, status: e.status };
    } finally {
      loading = false;
    }
  }

  const EVENTS = ['insert', 'update', 'delete'];

  // ── new/edit webhook modal (POST /webhooks upserts by id, so both share one form) ──
  let formOpen   = $state(false);
  let formId     = $state('');
  let formIdLocked = $state(false); // true when editing an existing webhook (id is the upsert key)
  let formUrl    = $state('');
  let formTable  = $state('*');
  let formEvents = $state(['insert', 'update', 'delete']);
  let formSecret = $state(''); // write-only; blank on edit = "leave whatever's configured, if any"
  let formEnabled = $state(true);
  let formHeadersText = $state('{}');
  let formBusy   = $state(false);
  let formError  = $state(null);

  function openNew() {
    formId = '';
    formIdLocked = false;
    formUrl = '';
    formTable = '*';
    formEvents = ['insert', 'update', 'delete'];
    formSecret = '';
    formEnabled = true;
    formHeadersText = '{}';
    formError = null;
    formOpen = true;
  }

  function openEdit(w) {
    formId = w.id;
    formIdLocked = true;
    formUrl = w.target_url;
    formTable = w.table_pattern;
    formEvents = [...w.events];
    formSecret = '';
    formEnabled = w.enabled;
    formHeadersText = JSON.stringify(w.headers ?? {}, null, 2);
    formError = null;
    formOpen = true;
  }

  function toggleEvent(ev) {
    formEvents = formEvents.includes(ev) ? formEvents.filter((e) => e !== ev) : [...formEvents, ev];
  }

  async function submitForm() {
    formError = null;
    const id = formId.trim();
    const url = formUrl.trim();
    const tablePattern = formTable.trim();
    if (!id) { formError = 'id is required.'; return; }
    if (!url) { formError = 'target_url is required.'; return; }
    if (!tablePattern) { formError = 'table_pattern is required (a table name, or * for every table).'; return; }
    if (formEvents.length === 0) { formError = 'Select at least one event.'; return; }
    let headers;
    try {
      headers = formHeadersText.trim() ? JSON.parse(formHeadersText) : {};
      if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) throw new Error('not an object');
    } catch {
      formError = 'headers must be a JSON object, e.g. {} or {"X-Api-Key":"..."}.';
      return;
    }
    formBusy = true;
    try {
      const payload = {
        id,
        target_url: url,
        table_pattern: tablePattern,
        events: formEvents,
        enabled: formEnabled,
        headers,
      };
      if (formSecret) payload.signing_secret = formSecret;
      await upsertWebhook(payload);
      formOpen = false;
      await load();
    } catch (e) {
      formError = e.message ?? String(e);
    } finally {
      formBusy = false;
    }
  }

  async function quickToggleEnabled(w) {
    try {
      await upsertWebhook({
        id: w.id,
        target_url: w.target_url,
        table_pattern: w.table_pattern,
        events: w.events,
        enabled: !w.enabled,
        headers: w.headers ?? {},
      });
      await load();
    } catch (e) {
      error = { code: e.code, message: e.message, status: e.status };
    }
  }

  let deleteTarget = $state(null); // id, or null
  let deleteBusy   = $state(false);
  let deleteError  = $state(null);

  async function confirmDelete() {
    deleteBusy = true;
    deleteError = null;
    try {
      await deleteWebhook(deleteTarget);
      deleteTarget = null;
      await load();
    } catch (e) {
      deleteError = e.message ?? String(e);
    } finally {
      deleteBusy = false;
    }
  }
</script>

<div class="webhooks">
  {#if error}
    <div class="unsupported">
      <h3>Couldn't load webhooks</h3>
      <p class="err">{error.code}: {error.message}</p>
    </div>
  {:else if !loading && !supported}
    <div class="unsupported">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="7" cy="7" r="3"/><circle cx="17" cy="17" r="3"/><path d="M9.5 8.5l5 7"/>
      </svg>
      <h3>Webhooks not available</h3>
      <p>This server doesn't expose <code>GET /webhooks</code> yet (needs item-141 support).</p>
    </div>
  {:else}
    <div class="toolbar">
      <strong class="toolbar-title">Database webhooks</strong>
      <span class="grow"></span>
      <button onclick={openNew}>+ New webhook</button>
    </div>

    <p class="hint">
      Registers an HTTP endpoint to receive a POST on every matching row change — the CDC
      envelope (<code>{'{seq, xid, table_name, op, payload, before, after, ts_ms}'}</code>, same
      shape <code>GET /events/subscribe?format=native</code> emits), signed when a secret is
      configured:
    </p>
    <pre class="sig-example">X-Unidb-Signature: sha256=&lt;hex HMAC-SHA256(secret, raw request body)&gt;</pre>
    <p class="hint">
      Delivery is at-least-once with bounded retry (≤5 attempts); a dead endpoint can't wedge the
      stream or block another webhook. A new registration starts from the beginning of retained
      history, not "now" — see <code>docs/REST_API.md</code>'s "Database webhooks" section for the
      full caveat.
    </p>

    {#if loading}
      <p class="muted">Loading…</p>
    {:else if webhooks.length === 0}
      <p class="muted">No webhooks registered yet.</p>
    {:else}
      <ul class="webhook-list">
        {#each webhooks as w}
          <li class="webhook-card" class:disabled-card={!w.enabled}>
            <div class="wc-head">
              <span class="wc-id mono">{w.id}</span>
              {#if w.enabled}<span class="pill ok">enabled</span>{:else}<span class="pill muted">disabled</span>{/if}
              {#if w.has_signing_secret}<span class="pill signed" title="A signing secret is configured — X-Unidb-Signature is sent">signed</span>{/if}
              <span class="grow"></span>
              <button class="link-btn" onclick={() => quickToggleEnabled(w)}>{w.enabled ? 'Disable' : 'Enable'}</button>
              <button class="link-btn" onclick={() => openEdit(w)}>Edit</button>
              <button class="del-btn" title="Delete webhook" onclick={() => (deleteTarget = w.id)}>✕</button>
            </div>
            <div class="wc-row"><span class="wc-label">URL</span><code class="wc-url">{w.target_url}</code></div>
            <div class="wc-row">
              <span class="wc-label">Table</span><code>{w.table_pattern}</code>
              <span class="wc-label">Events</span>
              <span class="chips">{#each w.events as ev}<span class="chip">{ev}</span>{/each}</span>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<!-- ── New/edit webhook modal ── -->
{#if formOpen}
  <div class="modal-backdrop" role="presentation" onpointerdown={() => (formOpen = false)}>
    <div class="modal" role="dialog" aria-label="Webhook" onpointerdown={(e) => e.stopPropagation()}>
      <div class="modal-head">
        <strong>{formIdLocked ? `Edit · ${formId}` : 'New webhook'}</strong>
        <button class="x" onclick={() => (formOpen = false)}>✕</button>
      </div>
      <div class="modal-body">
        <label class="field">
          <span class="flabel">id (upsert key)</span>
          <input bind:value={formId} placeholder="e.g. orders-hook" spellcheck="false" disabled={formIdLocked} class="mono-input" />
        </label>
        <label class="field">
          <span class="flabel">target_url</span>
          <input bind:value={formUrl} placeholder="https://example.com/hooks/orders" spellcheck="false" class="mono-input" />
        </label>
        <label class="field">
          <span class="flabel">table_pattern</span>
          <input bind:value={formTable} placeholder="orders, or * for every table" spellcheck="false" class="mono-input" list="webhook-tables" />
          <datalist id="webhook-tables">
            <option value="*"></option>
            {#each tables as t}<option value={t.name}></option>{/each}
          </datalist>
        </label>
        <div class="field">
          <span class="flabel">Events</span>
          <div class="check-row">
            {#each EVENTS as ev}
              <label class="check-field">
                <input type="checkbox" checked={formEvents.includes(ev)} onchange={() => toggleEvent(ev)} />
                {ev}
              </label>
            {/each}
          </div>
        </div>
        <label class="field">
          <span class="flabel">signing_secret (optional{formIdLocked ? ' — blank leaves it unchanged' : ''})</span>
          <input type="password" bind:value={formSecret} placeholder={formIdLocked ? '••••••• (unchanged)' : ''} />
        </label>
        <label class="field">
          <span class="flabel">headers (JSON, optional static headers)</span>
          <textarea bind:value={formHeadersText} rows="2" class="mono-input" spellcheck="false"></textarea>
        </label>
        <label class="check-field">
          <input type="checkbox" bind:checked={formEnabled} />
          Enabled
        </label>
        {#if formError}<p class="err">{formError}</p>{/if}
      </div>
      <div class="modal-foot">
        <span class="grow"></span>
        <button class="ghost" onclick={() => (formOpen = false)}>Cancel</button>
        <button onclick={submitForm} disabled={formBusy}>{formBusy ? 'Saving…' : formIdLocked ? 'Save changes' : 'Create webhook'}</button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Delete confirm ── -->
{#if deleteTarget}
  <div class="modal-backdrop" role="presentation" onpointerdown={() => (deleteTarget = null)}>
    <div class="modal del-modal" role="dialog" onpointerdown={(e) => e.stopPropagation()}>
      <div class="modal-head">
        <strong>Delete webhook</strong>
        <button class="x" onclick={() => (deleteTarget = null)}>✕</button>
      </div>
      <div class="modal-body">
        <p class="del-msg">Delete webhook <code>{deleteTarget}</code>?</p>
        {#if deleteError}<p class="err">{deleteError}</p>{/if}
      </div>
      <div class="modal-foot">
        <span class="grow"></span>
        <button class="ghost" onclick={() => (deleteTarget = null)}>Cancel</button>
        <button class="del-btn" onclick={confirmDelete} disabled={deleteBusy}>{deleteBusy ? 'Deleting…' : 'Delete'}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .webhooks { display: flex; flex-direction: column; gap: 12px; height: 100%; overflow-y: auto; padding: 16px 20px; }

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

  .hint { font-size: 12px; color: var(--muted); line-height: 1.6; margin: 0; }
  .hint code { font-family: var(--mono); background: var(--panel-alt); border-radius: 4px; padding: 1px 4px; }
  .sig-example {
    margin: 0; padding: 8px 10px; font-family: var(--mono); font-size: 11px;
    background: var(--panel-alt); border: 1px solid var(--border); border-radius: 6px;
  }

  .webhook-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .webhook-card {
    border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px;
    display: flex; flex-direction: column; gap: 6px; background: var(--panel);
  }
  .webhook-card.disabled-card { opacity: 0.6; }
  .wc-head { display: flex; align-items: center; gap: 8px; }
  .wc-id { font-weight: 600; font-size: 13px; }
  .wc-row { display: flex; align-items: center; gap: 8px; font-size: 12px; flex-wrap: wrap; }
  .wc-label { color: var(--muted); font-weight: 600; }
  .wc-url { word-break: break-all; }
  .mono { font-family: var(--mono); }

  .pill {
    font-size: 10px; font-weight: 600; border-radius: 10px; padding: 1px 8px;
  }
  .pill.ok    { background: rgba(22,163,74,0.14); color: #15803d; }
  .pill.muted { background: var(--panel-alt); color: var(--muted); }
  .pill.signed { background: rgba(8,145,178,0.14); color: #0891b2; }

  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip {
    font-family: var(--mono); font-size: 10px; background: var(--panel-alt);
    border: 1px solid var(--border); border-radius: 10px; padding: 1px 7px;
  }
  .wc-row code {
    font-family: var(--mono); background: var(--panel-alt); border-radius: 4px; padding: 1px 5px;
  }

  .link-btn { background: none; border: none; color: var(--accent); cursor: pointer; font-size: 11px; padding: 0; }
  .link-btn:hover { text-decoration: underline; }
  .del-btn { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 12px; }
  .del-btn:hover { color: var(--err-fg); }

  .muted { color: var(--muted); }
  .err { color: var(--err-fg); }

  /* ── modal (shared pattern) ── */
  .modal-backdrop {
    position: fixed; inset: 0; z-index: 30;
    background: rgba(0,0,0,0.4);
    display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  .modal {
    width: min(460px, 100%); display: flex; flex-direction: column;
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
  .field input, .field textarea {
    padding: 7px 10px; font-size: 13px; color: var(--text); background: var(--panel);
    border: 1px solid var(--border); border-radius: 6px;
  }
  .field input:disabled { opacity: 0.6; }
  .field textarea { resize: vertical; }
  .mono-input { font-family: var(--mono); }
  .field input:focus, .field textarea:focus { outline: none; border-color: var(--accent); }
  .check-row { display: flex; gap: 14px; }
  .check-field { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text); cursor: pointer; }
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
