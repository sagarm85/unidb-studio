<script>
  // A reusable accordion section for the sidebar. Header shows a chevron +
  // title (click to collapse/expand) and an optional right-aligned `action`
  // snippet. Body is the default children. Built so future sidebar sections
  // (Events, Vector search, Permissions, …) drop in the same way:
  //
  //   <CollapsibleSection title="events">…</CollapsibleSection>
  let { title, open = true, action, children } = $props();
  let expanded = $state(open);
</script>

<section class="sb-section">
  <div class="sb-head">
    <button
      class="sb-toggle"
      onclick={() => (expanded = !expanded)}
      aria-expanded={expanded}
      title={expanded ? `Collapse ${title}` : `Expand ${title}`}
    >
      <span class="chev" class:open={expanded} aria-hidden="true">▸</span>
      <span class="sb-title">{title}</span>
    </button>
    {#if action}<span class="sb-action">{@render action()}</span>{/if}
  </div>
  {#if expanded}
    <div class="sb-body">{@render children?.()}</div>
  {/if}
</section>

<style>
  .sb-section {
    border-bottom: 1px solid var(--border);
  }
  .sb-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }
  .sb-toggle {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: none;
    padding: 9px 4px;
    cursor: pointer;
    color: var(--muted);
    font: inherit;
    text-align: left;
  }
  .sb-toggle:hover {
    color: var(--text);
  }
  .chev {
    display: inline-block;
    font-size: 10px;
    transition: transform 0.12s ease;
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .sb-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
  }
  .sb-action {
    display: flex;
    align-items: center;
  }
  .sb-body {
    padding: 4px 0 12px;
  }
</style>
