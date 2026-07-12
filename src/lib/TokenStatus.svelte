<script>
  import { getToken, setToken } from './api.js';

  // The generate flow talks to the dev server's /__token endpoint, which only
  // exists under `npm run dev` — so the button is dev-only.
  const canGenerate = import.meta.env.DEV;

  let token = $state(getToken());
  let now = $state(Math.floor(Date.now() / 1000));
  let minting = $state(false);
  let mintError = $state(null);

  const exp = $derived(decodeExp(token));
  const remaining = $derived(exp === null ? null : exp - now);
  const active = $derived(remaining !== null && remaining > 0);

  // Reads the unverified `exp` claim for display only; the server is the one
  // actually verifying the signature.
  function decodeExp(t) {
    try {
      const b64 = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(b64));
      return typeof payload.exp === 'number' ? payload.exp : null;
    } catch {
      return null;
    }
  }

  $effect(() => {
    const id = setInterval(() => (now = Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  });

  function fmtRemaining(s) {
    if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${s}s`;
  }

  async function generate() {
    minting = true;
    mintError = null;
    try {
      const res = await fetch('/__token');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = await res.json();
      setToken(out.token);
      token = out.token;
    } catch (e) {
      mintError = e?.message ?? String(e);
    } finally {
      minting = false;
    }
  }
</script>

<span class="token-status">
  {#if !token}
    <span class="badge warn">no token</span>
  {:else if active}
    <span class="badge ok">token active</span>
    <span class="remaining" class:low={remaining < 300} title="time until the token expires">
      expires in {fmtRemaining(remaining)}
    </span>
  {:else}
    <span class="badge err">token expired</span>
  {/if}

  {#if canGenerate}
    <button class="gen" class:urgent={token && !active} onclick={generate} disabled={minting}>
      {#if minting}
        Generating…
      {:else if token && !active}
        Regenerate token
      {:else}
        Generate token
      {/if}
    </button>
  {/if}

  {#if mintError}
    <span class="mint-error" role="alert">{mintError}</span>
  {/if}
</span>

<style>
  .token-status {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .badge {
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
  }
  .badge.ok {
    background: rgba(46, 160, 67, 0.15);
    color: var(--accent);
  }
  .badge.warn {
    background: rgba(210, 153, 34, 0.15);
    color: #b8860b;
  }
  .badge.err {
    background: rgba(207, 34, 46, 0.12);
    color: #cf222e;
  }
  .remaining {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
  }
  .remaining.low {
    color: #b8860b;
    font-weight: 600;
  }
  .gen {
    border: 1px solid var(--border);
    background: none;
    border-radius: 6px;
    padding: 3px 10px;
    font-size: 11px;
    font-weight: 600;
    color: var(--accent);
    cursor: pointer;
    white-space: nowrap;
  }
  .gen:hover:not(:disabled) {
    background: rgba(46, 160, 67, 0.08);
  }
  .gen:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .gen.urgent {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .gen.urgent:hover:not(:disabled) {
    opacity: 0.9;
    background: var(--accent);
  }
  .mint-error {
    font-size: 11px;
    color: #cf222e;
  }
</style>
