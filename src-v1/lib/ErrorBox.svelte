<script>
  // Renders a normalized ApiError ({message, code, status}).
  let { error } = $props();
</script>

{#if error}
  <div class="err" role="alert">
    <span class="code">{error.code}{error.status ? ` · ${error.status}` : ''}</span>
    <span class="msg">{error.message}</span>
  </div>
{/if}

<style>
  .err {
    border: 1px solid var(--err-border);
    background: var(--err-bg);
    border-radius: 6px;
    padding: 8px 12px;
    display: flex;
    gap: 10px;
    align-items: baseline;
    font-size: 13px;
  }
  .code {
    font-family: var(--mono);
    font-weight: 600;
    color: var(--err-fg);
    white-space: nowrap;
  }
  .msg {
    color: var(--text);
  }
</style>
