<script>
  import {
    listBuckets, createBucket, deleteBucket,
    listObjects, uploadObject, deleteObject, getObjectUrl,
  } from './api.js';

  // ── state ────────────────────────────────────────────────────
  let supported     = $state(true);
  let buckets       = $state([]);
  let bucketsLoading = $state(true);
  let bucketsError  = $state(null);

  let selectedBucket = $state(null);
  let prefix         = $state('');       // current folder path
  let objects        = $state([]);       // { key, size, last_modified, content_type }
  let folders        = $state([]);       // common prefixes (virtual folders)
  let objLoading     = $state(false);
  let objError       = $state(null);

  // new-bucket modal
  let newBucketOpen   = $state(false);
  let newBucketName   = $state('');
  let newBucketPublic = $state(false);
  let newBucketBusy   = $state(false);
  let newBucketError  = $state(null);

  // delete-bucket confirm
  let deleteBucketTarget = $state(null);
  let deleteBucketBusy   = $state(false);

  // upload
  let uploading    = $state(false);
  let uploadPct    = $state(0);
  let uploadError  = $state(null);
  let fileInputEl  = $state(null);
  let dragOver     = $state(false);

  // delete-object confirm
  let deleteObjTarget = $state(null);
  let deleteObjBusy   = $state(false);

  // copy URL feedback
  let copiedKey = $state(null);

  // ── lifecycle ────────────────────────────────────────────────
  $effect(() => { loadBuckets(); });

  $effect(() => {
    if (selectedBucket) loadObjects(selectedBucket, prefix);
  });

  async function loadBuckets() {
    bucketsLoading = true;
    bucketsError = null;
    try {
      const out = await listBuckets();
      supported = out.supported;
      buckets = out.buckets;
    } catch (e) {
      bucketsError = e.message;
    } finally {
      bucketsLoading = false;
    }
  }

  async function loadObjects(bucket, pfx) {
    objLoading = true;
    objError = null;
    try {
      const out = await listObjects(bucket, pfx);
      folders = (out.prefixes ?? []).map(p => ({ key: p, name: p.slice(pfx.length).replace(/\/$/, '') }));
      objects = (out.objects ?? []).filter(o => o.key !== pfx); // exclude the "folder" object itself
    } catch (e) {
      objError = e.message;
      folders = [];
      objects = [];
    } finally {
      objLoading = false;
    }
  }

  function selectBucket(b) {
    selectedBucket = b;
    prefix = '';
  }

  function openFolder(folderPrefix) {
    prefix = folderPrefix;
    loadObjects(selectedBucket, prefix);
  }

  function navigateCrumb(idx) {
    const parts = prefix.split('/').filter(Boolean);
    prefix = parts.slice(0, idx + 1).join('/') + (idx >= 0 ? '/' : '');
    loadObjects(selectedBucket, prefix);
  }

  // breadcrumb parts from prefix
  const crumbs = $derived(() => {
    const parts = prefix.split('/').filter(Boolean);
    return parts.map((p, i) => ({ label: p, index: i }));
  });

  // ── bucket CRUD ──────────────────────────────────────────────
  async function submitNewBucket() {
    newBucketError = null;
    const n = newBucketName.trim();
    if (!n) { newBucketError = 'Bucket name is required'; return; }
    newBucketBusy = true;
    try {
      await createBucket(n, { isPublic: newBucketPublic });
      newBucketOpen = false;
      newBucketName = '';
      newBucketPublic = false;
      await loadBuckets();
    } catch (e) {
      newBucketError = e.message;
    } finally {
      newBucketBusy = false;
    }
  }

  async function confirmDeleteBucket() {
    deleteBucketBusy = true;
    try {
      await deleteBucket(deleteBucketTarget);
      if (selectedBucket === deleteBucketTarget) { selectedBucket = null; prefix = ''; }
      deleteBucketTarget = null;
      await loadBuckets();
    } catch (e) {
      bucketsError = e.message;
    } finally {
      deleteBucketBusy = false;
    }
  }

  // ── upload ───────────────────────────────────────────────────
  function pickFiles() { fileInputEl?.click(); }

  async function handleFiles(files) {
    if (!files?.length || !selectedBucket) return;
    uploading = true;
    uploadError = null;
    try {
      for (const file of files) {
        uploadPct = 0;
        const key = prefix + file.name;
        await uploadObject(selectedBucket, key, file, (p) => { uploadPct = p; });
      }
      await loadObjects(selectedBucket, prefix);
    } catch (e) {
      uploadError = e.message;
    } finally {
      uploading = false;
      uploadPct = 0;
    }
  }

  function onFileInput(e) { handleFiles(e.target.files); e.target.value = ''; }

  function onDrop(e) {
    e.preventDefault();
    dragOver = false;
    handleFiles(e.dataTransfer.files);
  }

  // ── delete object ─────────────────────────────────────────────
  async function confirmDeleteObj() {
    deleteObjBusy = true;
    try {
      await deleteObject(selectedBucket, deleteObjTarget);
      deleteObjTarget = null;
      await loadObjects(selectedBucket, prefix);
    } catch (e) {
      objError = e.message;
    } finally {
      deleteObjBusy = false;
    }
  }

  // ── presigned URL ─────────────────────────────────────────────
  async function copyUrl(key) {
    try {
      const url = await getObjectUrl(selectedBucket, key);
      await navigator.clipboard.writeText(url);
      copiedKey = key;
      setTimeout(() => { if (copiedKey === key) copiedKey = null; }, 2000);
    } catch (e) {
      objError = e.message;
    }
  }

  async function downloadObj(key) {
    try {
      const url = await getObjectUrl(selectedBucket, key);
      const a = document.createElement('a');
      a.href = url;
      a.download = key.split('/').pop();
      a.click();
    } catch (e) {
      objError = e.message;
    }
  }

  // ── formatting ────────────────────────────────────────────────
  function fmtSize(bytes) {
    if (bytes == null) return '—';
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
    if (bytes >= 1_048_576)     return `${(bytes / 1_048_576).toFixed(1)} MB`;
    if (bytes >= 1_024)         return `${(bytes / 1_024).toFixed(1)} KB`;
    return `${bytes} B`;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60_000)        return 'just now';
    if (diff < 3_600_000)     return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000)    return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
    return d.toLocaleDateString();
  }

  function fileIcon(key, contentType) {
    const ext = key.split('.').pop()?.toLowerCase();
    if (['jpg','jpeg','png','gif','webp','svg','avif'].includes(ext)) return '🖼';
    if (['mp4','mov','avi','mkv','webm'].includes(ext)) return '🎬';
    if (['mp3','wav','ogg','flac'].includes(ext)) return '🎵';
    if (['pdf'].includes(ext)) return '📄';
    if (['zip','tar','gz','bz2','7z'].includes(ext)) return '🗜';
    if (['json','yaml','yml','toml','xml'].includes(ext)) return '📋';
    if (['js','ts','py','rs','go','java','cpp','c','sql'].includes(ext)) return '📝';
    return '📄';
  }
</script>

<div class="storage">
  {#if !supported}
    <div class="unsupported">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v5c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/>
        <path d="M3 10v5c0 1.66 4.03 3 9 3s9-1.34 9-3v-5"/>
      </svg>
      <h3>Storage not available</h3>
      <p>The unidb engine doesn't expose <code>GET /storage/buckets</code> yet.<br/>
         Wire up the MinIO proxy in the engine to enable object storage.</p>
    </div>
  {:else}
    <div class="layout">
      <!-- ── Bucket sidebar ── -->
      <aside class="bucket-sidebar">
        <div class="sidebar-head">
          <span class="sidebar-title">Buckets</span>
          <button class="icon-btn" title="New bucket" onclick={() => (newBucketOpen = true)}>+</button>
          <button class="icon-btn" title="Refresh" onclick={loadBuckets}>↻</button>
        </div>

        {#if bucketsError}
          <p class="err small">{bucketsError}</p>
        {:else if bucketsLoading}
          <p class="muted small">Loading…</p>
        {:else if buckets.length === 0}
          <p class="muted small">No buckets yet.</p>
        {:else}
          <ul class="bucket-list">
            {#each buckets as b}
              {@const name = b.name ?? b}
              <li class:active={selectedBucket === name}>
                <button class="bucket-btn" onclick={() => selectBucket(name)}>
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="flex-shrink:0">
                    <ellipse cx="8" cy="4" rx="6" ry="2"/><path d="M2 4v5c0 1.1 2.69 2 6 2s6-.9 6-2V4"/>
                    <path d="M2 9v3c0 1.1 2.69 2 6 2s6-.9 6-2V9"/>
                  </svg>
                  <span class="bucket-name">{name}</span>
                  {#if b.public}<span class="pub-badge">public</span>{/if}
                </button>
                <button class="del-bucket-btn" title="Delete bucket" onclick={(e) => { e.stopPropagation(); deleteBucketTarget = name; }}>✕</button>
              </li>
            {/each}
          </ul>
        {/if}
      </aside>

      <!-- ── Object browser ── -->
      <div class="browser">
        {#if !selectedBucket}
          <div class="empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
              <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v5c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/>
              <path d="M3 10v5c0 1.66 4.03 3 9 3s9-1.34 9-3v-5"/>
            </svg>
            <p>Select a bucket to browse objects</p>
          </div>
        {:else}
          <!-- toolbar -->
          <div class="browser-toolbar">
            <!-- breadcrumb -->
            <nav class="crumb">
              <button class="crumb-item" onclick={() => { prefix = ''; loadObjects(selectedBucket, ''); }}>
                {selectedBucket}
              </button>
              {#each crumbs() as c}
                <span class="crumb-sep">/</span>
                <button class="crumb-item" onclick={() => navigateCrumb(c.index)}>{c.label}</button>
              {/each}
            </nav>
            <span class="grow"></span>
            <!-- upload -->
            <input bind:this={fileInputEl} type="file" multiple style="display:none" onchange={onFileInput} />
            <button class="upload-btn" onclick={pickFiles} disabled={uploading}>
              {#if uploading}
                <span class="spinner"></span> {Math.round(uploadPct * 100)}%
              {:else}
                ↑ Upload
              {/if}
            </button>
            <button class="refresh-btn" onclick={() => loadObjects(selectedBucket, prefix)} disabled={objLoading}>↻</button>
          </div>

          {#if uploadError}<p class="err small">{uploadError}</p>{/if}
          {#if objError}<p class="err small">{objError}</p>{/if}

          <!-- drop zone + table -->
          <div
            class="drop-zone"
            class:drag-over={dragOver}
            ondragover={(e) => { e.preventDefault(); dragOver = true; }}
            ondragleave={() => (dragOver = false)}
            ondrop={onDrop}
            role="region"
            aria-label="Drop files to upload"
          >
            {#if objLoading}
              <p class="muted center">Loading…</p>
            {:else if folders.length === 0 && objects.length === 0}
              <div class="empty-state small">
                <p>This {prefix ? 'folder' : 'bucket'} is empty.<br/>
                   <span class="muted">Drag files here or click Upload.</span></p>
              </div>
            {:else}
              <table class="obj-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th class="num">Size</th>
                    <th>Modified</th>
                    <th>Type</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <!-- folders first -->
                  {#each folders as f}
                    <tr class="folder-row" ondblclick={() => openFolder(f.key)}>
                      <td class="name-cell">
                        <button class="folder-btn" onclick={() => openFolder(f.key)}>
                          <span class="file-icon">📁</span>
                          {f.name}/
                        </button>
                      </td>
                      <td class="num muted">—</td>
                      <td class="muted">—</td>
                      <td class="muted">folder</td>
                      <td></td>
                    </tr>
                  {/each}
                  <!-- objects -->
                  {#each objects as o}
                    {@const shortName = o.key.slice(prefix.length)}
                    <tr>
                      <td class="name-cell">
                        <span class="file-icon">{fileIcon(o.key, o.content_type)}</span>
                        <span class="file-name" title={o.key}>{shortName}</span>
                      </td>
                      <td class="num mono">{fmtSize(o.size)}</td>
                      <td class="muted">{fmtDate(o.last_modified)}</td>
                      <td class="muted type-cell" title={o.content_type}>{o.content_type?.split('/')[1] ?? '—'}</td>
                      <td class="actions-cell">
                        <button class="action-btn" title="Download" onclick={() => downloadObj(o.key)}>↓</button>
                        <button
                          class="action-btn"
                          title={copiedKey === o.key ? 'Copied!' : 'Copy URL'}
                          onclick={() => copyUrl(o.key)}
                        >{copiedKey === o.key ? '✓' : '🔗'}</button>
                        <button class="action-btn danger" title="Delete" onclick={() => (deleteObjTarget = o.key)}>✕</button>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {/if}

            {#if dragOver}
              <div class="drop-overlay">Drop to upload</div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<!-- ── New bucket modal ── -->
{#if newBucketOpen}
  <div class="modal-backdrop" role="presentation" onpointerdown={() => (newBucketOpen = false)}>
    <div class="modal" role="dialog" aria-label="New bucket" onpointerdown={(e) => e.stopPropagation()}>
      <div class="modal-head">
        <strong>New bucket</strong>
        <button class="x" onclick={() => (newBucketOpen = false)}>✕</button>
      </div>
      <div class="modal-body">
        <label class="field">
          <span class="flabel">Bucket name</span>
          <input bind:value={newBucketName} placeholder="e.g. my-assets" spellcheck="false"
                 onkeydown={(e) => e.key === 'Enter' && submitNewBucket()} />
        </label>
        <label class="check-field">
          <input type="checkbox" bind:checked={newBucketPublic} />
          Public bucket (objects accessible without auth)
        </label>
        {#if newBucketError}<p class="err">{newBucketError}</p>{/if}
      </div>
      <div class="modal-foot">
        <span class="grow"></span>
        <button class="ghost" onclick={() => (newBucketOpen = false)}>Cancel</button>
        <button onclick={submitNewBucket} disabled={newBucketBusy}>
          {newBucketBusy ? 'Creating…' : 'Create bucket'}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Delete bucket confirm ── -->
{#if deleteBucketTarget}
  <div class="modal-backdrop" role="presentation" onpointerdown={() => (deleteBucketTarget = null)}>
    <div class="modal del-modal" role="dialog" onpointerdown={(e) => e.stopPropagation()}>
      <div class="modal-head">
        <strong>Delete bucket</strong>
        <button class="x" onclick={() => (deleteBucketTarget = null)}>✕</button>
      </div>
      <div class="modal-body">
        <p class="del-msg">
          Permanently delete bucket <code>{deleteBucketTarget}</code> and <strong>all its objects</strong>?
          This cannot be undone.
        </p>
      </div>
      <div class="modal-foot">
        <span class="grow"></span>
        <button class="ghost" onclick={() => (deleteBucketTarget = null)}>Cancel</button>
        <button class="del-btn" onclick={confirmDeleteBucket} disabled={deleteBucketBusy}>
          {deleteBucketBusy ? 'Deleting…' : 'Delete bucket'}
        </button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Delete object confirm ── -->
{#if deleteObjTarget}
  <div class="modal-backdrop" role="presentation" onpointerdown={() => (deleteObjTarget = null)}>
    <div class="modal del-modal" role="dialog" onpointerdown={(e) => e.stopPropagation()}>
      <div class="modal-head">
        <strong>Delete object</strong>
        <button class="x" onclick={() => (deleteObjTarget = null)}>✕</button>
      </div>
      <div class="modal-body">
        <p class="del-msg">Permanently delete <code>{deleteObjTarget.split('/').pop()}</code>?</p>
      </div>
      <div class="modal-foot">
        <span class="grow"></span>
        <button class="ghost" onclick={() => (deleteObjTarget = null)}>Cancel</button>
        <button class="del-btn" onclick={confirmDeleteObj} disabled={deleteObjBusy}>
          {deleteObjBusy ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .storage { display: flex; flex-direction: column; height: 100%; }

  /* ── unsupported ── */
  .unsupported {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    height: 100%;
    color: var(--muted);
    text-align: center;
  }
  .unsupported h3 { margin: 0; font-size: 16px; color: var(--text); }
  .unsupported p  { margin: 0; font-size: 13px; line-height: 1.6; }

  /* ── layout ── */
  .layout {
    display: flex;
    height: 100%;
    min-height: 0;
    gap: 0;
  }

  /* ── bucket sidebar ── */
  .bucket-sidebar {
    width: 220px;
    flex-shrink: 0;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    background: var(--panel-alt);
    overflow: hidden;
  }
  .sidebar-head {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 10px 12px 8px;
    border-bottom: 1px solid var(--border);
  }
  .sidebar-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--muted);
    flex: 1;
  }
  .icon-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--muted);
    font-size: 14px;
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
  }
  .icon-btn:hover { color: var(--text); border-color: var(--accent); }

  .bucket-list {
    list-style: none;
    margin: 0;
    padding: 6px 0;
    overflow-y: auto;
    flex: 1;
  }
  .bucket-list li {
    display: flex;
    align-items: center;
    padding: 0 6px;
    border-radius: 6px;
    margin: 1px 4px;
  }
  .bucket-list li.active { background: var(--accent); }
  .bucket-list li.active .bucket-btn { color: #fff; }
  .bucket-list li.active .del-bucket-btn { color: rgba(255,255,255,0.6); }
  .bucket-btn {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: none;
    padding: 7px 4px;
    cursor: pointer;
    color: var(--text);
    font-size: 13px;
    text-align: left;
    min-width: 0;
  }
  .bucket-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pub-badge {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    background: rgba(37,99,235,0.15);
    color: var(--accent);
    border-radius: 3px;
    padding: 1px 4px;
    flex-shrink: 0;
  }
  .del-bucket-btn {
    background: none;
    border: none;
    color: var(--muted);
    cursor: pointer;
    font-size: 12px;
    padding: 2px 4px;
    opacity: 0;
    flex-shrink: 0;
  }
  .bucket-list li:hover .del-bucket-btn,
  .bucket-list li.active .del-bucket-btn { opacity: 1; }
  .del-bucket-btn:hover { color: var(--err-fg); }

  /* ── browser ── */
  .browser {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }
  .browser-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .crumb {
    display: flex;
    align-items: center;
    gap: 2px;
    font-size: 13px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
  }
  .crumb-item {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    padding: 2px 4px;
    border-radius: 4px;
    white-space: nowrap;
  }
  .crumb-item:hover { background: var(--panel-alt); }
  .crumb-sep { color: var(--muted); padding: 0 2px; }
  .grow { flex: 1; }
  .upload-btn {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
  .upload-btn:disabled { opacity: 0.6; cursor: default; }
  .refresh-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--muted);
    font-size: 14px;
    padding: 5px 9px;
    cursor: pointer;
  }
  .refresh-btn:hover { color: var(--text); border-color: var(--accent); }

  /* ── drop zone ── */
  .drop-zone {
    flex: 1;
    overflow: auto;
    position: relative;
  }
  .drop-zone.drag-over::after {
    content: '';
    position: absolute;
    inset: 0;
    background: rgba(37,99,235,0.06);
    border: 2px dashed var(--accent);
    border-radius: 8px;
    pointer-events: none;
  }
  .drop-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    font-weight: 600;
    color: var(--accent);
    pointer-events: none;
  }

  /* ── object table ── */
  .obj-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .obj-table th {
    position: sticky;
    top: 0;
    background: var(--panel);
    text-align: left;
    padding: 8px 12px;
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--border);
    z-index: 1;
  }
  .obj-table th.num, .obj-table td.num { text-align: right; }
  .obj-table td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  .obj-table tr:hover td { background: var(--panel-alt); }
  .obj-table tr:last-child td { border-bottom: none; }

  .name-cell { display: flex; align-items: center; gap: 8px; max-width: 400px; }
  .file-icon { font-size: 14px; flex-shrink: 0; }
  .file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .folder-btn {
    background: none; border: none; cursor: pointer; color: var(--accent);
    font-size: 13px; font-weight: 500; display: flex; align-items: center; gap: 8px; padding: 0;
  }
  .folder-btn:hover { text-decoration: underline; }
  .type-cell { font-size: 11px; max-width: 100px; overflow: hidden; text-overflow: ellipsis; }

  .actions-cell {
    display: flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }
  .action-btn {
    background: none;
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 3px 7px;
    font-size: 12px;
    color: var(--muted);
    cursor: pointer;
  }
  .action-btn:hover { color: var(--text); border-color: var(--accent); }
  .action-btn.danger:hover { color: var(--err-fg); border-color: var(--err-border); }

  /* ── empty / loading ── */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    height: 100%;
    color: var(--muted);
    text-align: center;
    padding: 40px;
  }
  .empty-state.small { height: 200px; }
  .empty-state p { margin: 0; font-size: 13px; line-height: 1.6; }
  .center { text-align: center; padding: 40px; }

  /* ── spinner ── */
  .spinner {
    width: 12px; height: 12px;
    border: 2px solid rgba(255,255,255,0.4);
    border-top-color: #fff;
    border-radius: 50%;
    display: inline-block;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── utils ── */
  .muted { color: var(--muted); }
  .mono  { font-family: var(--mono); }
  .small { font-size: 12px; margin: 6px 12px; }
  .err   { color: var(--err-fg); }

  /* ── modals ── */
  .modal-backdrop {
    position: fixed; inset: 0; z-index: 30;
    background: rgba(0,0,0,0.4);
    display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  .modal {
    width: min(460px, 100%);
    display: flex; flex-direction: column;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.3);
    overflow: hidden;
  }
  .del-modal { width: min(400px, 100%); }
  .modal-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 14px; border-bottom: 1px solid var(--border);
  }
  .modal-body { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
  .modal-foot {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 14px; border-top: 1px solid var(--border);
  }
  .grow { flex: 1; }
  .field { display: flex; flex-direction: column; gap: 4px; }
  .flabel { font-size: 12px; font-weight: 600; }
  .field input[type=text], .field input:not([type]) {
    padding: 7px 10px; font-size: 13px; font-family: var(--mono);
    color: var(--text); background: var(--panel);
    border: 1px solid var(--border); border-radius: 6px;
  }
  .field input:focus { outline: none; border-color: var(--accent); }
  .check-field {
    display: flex; align-items: center; gap: 8px;
    font-size: 13px; color: var(--text); cursor: pointer;
  }
  .del-msg { margin: 0; font-size: 13px; line-height: 1.6; color: var(--text); }
  .del-msg code {
    font-family: var(--mono); font-size: 12px;
    background: var(--panel-alt); padding: 1px 5px; border-radius: 4px;
  }
  .x {
    background: none; border: none; color: var(--muted);
    cursor: pointer; font-size: 13px;
  }
  .x:hover { color: var(--err-fg); }
  .ghost {
    background: none; border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); padding: 6px 12px; font-size: 13px; cursor: pointer;
  }
  .modal-foot button:not(.ghost):not(.del-btn) {
    background: var(--accent); color: #fff; border: none;
    border-radius: 6px; padding: 7px 14px; font-size: 13px; cursor: pointer;
  }
  .del-btn {
    background: var(--err-fg, #ef4444); color: #fff; border: none;
    border-radius: 6px; padding: 7px 14px; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .del-btn:hover { opacity: 0.88; }
  .del-btn:disabled, .modal-foot button:disabled { opacity: 0.5; cursor: default; }
</style>
