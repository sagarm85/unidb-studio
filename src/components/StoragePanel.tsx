import { useEffect, useRef, useState } from 'react';
import { Database, Plus, RefreshCw, Upload, Download, Link as LinkIcon, X } from 'lucide-react';
import { listBuckets, createBucket, deleteBucket, listObjects, uploadObject, deleteObject, getObjectUrl } from '@/lib/engine/api.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from './ui/dialog';
import { cn } from '@/lib/utils';

interface Bucket {
  name: string;
  public?: boolean;
}
interface StorageObject {
  key: string;
  size?: number;
  last_modified?: string | null;
  content_type?: string;
}
interface Folder {
  key: string;
  name: string;
}

function fmtSize(bytes: number | undefined) {
  if (bytes == null) return '—';
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${bytes} B`;
}
function fmtDate(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return d.toLocaleDateString();
}
function fileIcon(key: string) {
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif'].includes(ext)) return '🖼';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) return '🎬';
  if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) return '🎵';
  if (ext === 'pdf') return '📄';
  if (['zip', 'tar', 'gz', 'bz2', '7z'].includes(ext)) return '🗜';
  if (['json', 'yaml', 'yml', 'toml', 'xml'].includes(ext)) return '📋';
  if (['js', 'ts', 'py', 'rs', 'go', 'java', 'cpp', 'c', 'sql'].includes(ext)) return '📝';
  return '📄';
}

export function StoragePanel() {
  const [supported, setSupported] = useState(true);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [bucketsLoading, setBucketsLoading] = useState(true);
  const [bucketsError, setBucketsError] = useState<string | null>(null);

  const [selectedBucket, setSelectedBucket] = useState<string | null>(null);
  const [prefix, setPrefix] = useState('');
  const [objects, setObjects] = useState<StorageObject[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [objLoading, setObjLoading] = useState(false);
  const [objError, setObjError] = useState<string | null>(null);

  const [newBucketOpen, setNewBucketOpen] = useState(false);
  const [newBucketName, setNewBucketName] = useState('');
  const [newBucketPublic, setNewBucketPublic] = useState(false);
  const [newBucketBusy, setNewBucketBusy] = useState(false);
  const [newBucketError, setNewBucketError] = useState<string | null>(null);

  const [deleteBucketTarget, setDeleteBucketTarget] = useState<string | null>(null);
  const [deleteBucketBusy, setDeleteBucketBusy] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const [deleteObjTarget, setDeleteObjTarget] = useState<string | null>(null);
  const [deleteObjBusy, setDeleteObjBusy] = useState(false);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  async function loadBuckets() {
    setBucketsLoading(true);
    setBucketsError(null);
    try {
      const out = await listBuckets();
      setSupported(out.supported);
      setBuckets(out.buckets);
    } catch (e: any) {
      setBucketsError(e?.message ?? String(e));
    } finally {
      setBucketsLoading(false);
    }
  }

  async function loadObjects(bucket: string, pfx: string) {
    setObjLoading(true);
    setObjError(null);
    try {
      const out = await listObjects(bucket, pfx);
      setFolders((out.prefixes ?? []).map((p: string) => ({ key: p, name: p.slice(pfx.length).replace(/\/$/, '') })));
      setObjects((out.objects ?? []).filter((o: StorageObject) => o.key !== pfx));
    } catch (e: any) {
      setObjError(e?.message ?? String(e));
      setFolders([]);
      setObjects([]);
    } finally {
      setObjLoading(false);
    }
  }

  useEffect(() => {
    loadBuckets();
  }, []);

  useEffect(() => {
    if (selectedBucket) loadObjects(selectedBucket, prefix);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBucket, prefix]);

  function selectBucket(b: string) {
    setSelectedBucket(b);
    setPrefix('');
  }
  function openFolder(folderPrefix: string) {
    setPrefix(folderPrefix);
  }
  function navigateCrumb(idx: number) {
    const parts = prefix.split('/').filter(Boolean);
    setPrefix(parts.slice(0, idx + 1).join('/') + (idx >= 0 ? '/' : ''));
  }
  const crumbs = prefix
    .split('/')
    .filter(Boolean)
    .map((label, index) => ({ label, index }));

  async function submitNewBucket() {
    setNewBucketError(null);
    const n = newBucketName.trim();
    if (!n) {
      setNewBucketError('Bucket name is required');
      return;
    }
    setNewBucketBusy(true);
    try {
      await createBucket(n, { isPublic: newBucketPublic });
      setNewBucketOpen(false);
      setNewBucketName('');
      setNewBucketPublic(false);
      await loadBuckets();
    } catch (e: any) {
      setNewBucketError(e?.message ?? String(e));
    } finally {
      setNewBucketBusy(false);
    }
  }

  async function confirmDeleteBucket() {
    if (!deleteBucketTarget) return;
    setDeleteBucketBusy(true);
    try {
      await deleteBucket(deleteBucketTarget);
      if (selectedBucket === deleteBucketTarget) {
        setSelectedBucket(null);
        setPrefix('');
      }
      setDeleteBucketTarget(null);
      await loadBuckets();
    } catch (e: any) {
      setBucketsError(e?.message ?? String(e));
    } finally {
      setDeleteBucketBusy(false);
    }
  }

  function pickFiles() {
    fileInputRef.current?.click();
  }

  async function handleFiles(files: FileList | File[] | null | undefined) {
    if (!files || !('length' in files ? files.length : true) || !selectedBucket) return;
    const list = Array.from(files);
    if (!list.length) return;
    setUploading(true);
    setUploadError(null);
    try {
      for (const file of list) {
        setUploadPct(0);
        const key = prefix + file.name;
        await uploadObject(selectedBucket, key, file, (p: number) => setUploadPct(p));
      }
      await loadObjects(selectedBucket, prefix);
    } catch (e: any) {
      setUploadError(e?.message ?? String(e));
    } finally {
      setUploading(false);
      setUploadPct(0);
    }
  }

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    handleFiles(e.target.files);
    e.target.value = '';
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  }

  async function confirmDeleteObj() {
    if (!deleteObjTarget || !selectedBucket) return;
    setDeleteObjBusy(true);
    try {
      await deleteObject(selectedBucket, deleteObjTarget);
      setDeleteObjTarget(null);
      await loadObjects(selectedBucket, prefix);
    } catch (e: any) {
      setObjError(e?.message ?? String(e));
    } finally {
      setDeleteObjBusy(false);
    }
  }

  async function copyUrl(key: string) {
    if (!selectedBucket) return;
    try {
      const url = await getObjectUrl(selectedBucket, key);
      await navigator.clipboard.writeText(url);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 2000);
    } catch (e: any) {
      setObjError(e?.message ?? String(e));
    }
  }
  async function downloadObj(key: string) {
    if (!selectedBucket) return;
    try {
      const url = await getObjectUrl(selectedBucket, key);
      const a = document.createElement('a');
      a.href = url;
      a.download = key.split('/').pop() ?? key;
      a.click();
    } catch (e: any) {
      setObjError(e?.message ?? String(e));
    }
  }

  if (!supported) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-text-light">
        <Database className="size-10 opacity-60" />
        <h3 className="m-0 text-lg font-medium text-foreground">Storage not available</h3>
        <p className="m-0 text-md leading-relaxed">
          The unidb engine doesn't expose <code>GET /storage/buckets</code> yet.
          <br />
          Wire up the MinIO proxy in the engine to enable object storage.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-56 shrink-0 flex-col overflow-hidden border-r border-border bg-surface">
        <div className="flex items-center gap-1 border-b border-border px-3 py-2.5">
          <span className="flex-1 text-xs font-bold tracking-wide text-text-muted uppercase">Buckets</span>
          <button
            className="flex size-[22px] items-center justify-center rounded-sm border border-border text-text-light hover:border-border-strong hover:text-foreground"
            title="New bucket"
            onClick={() => setNewBucketOpen(true)}
          >
            <Plus className="size-3.5" />
          </button>
          <button
            className="flex size-[22px] items-center justify-center rounded-sm border border-border text-text-light hover:border-border-strong hover:text-foreground"
            title="Refresh"
            onClick={loadBuckets}
          >
            <RefreshCw className="size-3.5" />
          </button>
        </div>

        {bucketsError ? (
          <p className="m-1.5 text-sm text-error">{bucketsError}</p>
        ) : bucketsLoading ? (
          <p className="m-1.5 text-sm text-text-light">Loading…</p>
        ) : buckets.length === 0 ? (
          <p className="m-1.5 text-sm text-text-light">No buckets yet.</p>
        ) : (
          <ul className="flex-1 list-none overflow-y-auto py-1.5">
            {buckets.map((b) => {
              const name = b.name ?? (b as any);
              const isActive = selectedBucket === name;
              return (
                <li key={name} className={cn('group mx-1 my-px flex items-center rounded-md px-1.5', isActive && 'bg-brand')}>
                  <button
                    className={cn('flex flex-1 items-center gap-1.5 py-1.5 text-left text-md', isActive ? 'text-brand-text-on' : 'text-foreground')}
                    onClick={() => selectBucket(name)}
                  >
                    <Database className="size-3.5 shrink-0" />
                    <span className="truncate">{name}</span>
                    {b.public && <span className="shrink-0 rounded-sm bg-info/15 px-1 text-[9px] font-bold text-info uppercase">public</span>}
                  </button>
                  <button
                    className={cn('shrink-0 px-1 text-sm opacity-0 group-hover:opacity-100', isActive ? 'text-brand-text-on/70' : 'text-text-muted hover:text-error')}
                    title="Delete bucket"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteBucketTarget(name);
                    }}
                  >
                    <X className="size-3" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {!selectedBucket ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center text-text-light">
            <Database className="size-12 opacity-50" />
            <p className="m-0 text-md">Select a bucket to browse objects</p>
          </div>
        ) : (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
              <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-md">
                <button
                  className="rounded-sm px-1 py-0.5 font-semibold whitespace-nowrap text-brand hover:bg-accent"
                  onClick={() => setPrefix('')}
                >
                  {selectedBucket}
                </button>
                {crumbs.map((c) => (
                  <span key={c.index} className="flex items-center gap-0.5">
                    <span className="px-0.5 text-text-muted">/</span>
                    <button className="rounded-sm px-1 py-0.5 font-semibold hover:bg-accent" onClick={() => navigateCrumb(c.index)}>
                      {c.label}
                    </button>
                  </span>
                ))}
              </nav>
              <span className="flex-1" />
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onFileInput} />
              <button
                className="flex h-8 items-center gap-1.5 rounded-md bg-brand px-3.5 text-md font-medium whitespace-nowrap text-brand-text-on hover:bg-brand-hover disabled:opacity-60"
                onClick={pickFiles}
                disabled={uploading}
              >
                {uploading ? (
                  <>
                    <span className="size-3 animate-spin rounded-full border-2 border-brand-text-on/40 border-t-brand-text-on" />
                    {Math.round(uploadPct * 100)}%
                  </>
                ) : (
                  <>
                    <Upload className="size-3.5" /> Upload
                  </>
                )}
              </button>
              <button
                className="flex h-8 items-center justify-center rounded-md border border-border bg-secondary px-2 text-text-light hover:border-border-strong disabled:opacity-60"
                onClick={() => loadObjects(selectedBucket, prefix)}
                disabled={objLoading}
              >
                <RefreshCw className="size-3.5" />
              </button>
            </div>

            {uploadError && <p className="mx-4 mt-2 text-sm text-error">{uploadError}</p>}
            {objError && <p className="mx-4 mt-2 text-sm text-error">{objError}</p>}

            <div
              className="relative flex-1 overflow-auto"
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              role="region"
              aria-label="Drop files to upload"
            >
              {dragOver && (
                <div className="pointer-events-none absolute inset-1 rounded-lg border-2 border-dashed border-brand bg-brand-subtle" />
              )}
              {objLoading ? (
                <p className="p-10 text-center text-md text-text-light">Loading…</p>
              ) : folders.length === 0 && objects.length === 0 ? (
                <div className="flex h-52 flex-col items-center justify-center p-10 text-center">
                  <p className="m-0 text-md text-text-light">
                    This {prefix ? 'folder' : 'bucket'} is empty.
                    <br />
                    <span className="text-text-muted">Drag files here or click Upload.</span>
                  </p>
                </div>
              ) : (
                <table className="w-full border-collapse text-md">
                  <thead>
                    <tr>
                      <th className="sticky top-0 z-1 bg-card px-3 py-2 text-left text-xs font-semibold tracking-wide text-text-muted uppercase">Name</th>
                      <th className="sticky top-0 z-1 bg-card px-3 py-2 text-right text-xs font-semibold tracking-wide text-text-muted uppercase">Size</th>
                      <th className="sticky top-0 z-1 bg-card px-3 py-2 text-left text-xs font-semibold tracking-wide text-text-muted uppercase">Modified</th>
                      <th className="sticky top-0 z-1 bg-card px-3 py-2 text-left text-xs font-semibold tracking-wide text-text-muted uppercase">Type</th>
                      <th className="sticky top-0 z-1 bg-card px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {folders.map((f) => (
                      <tr key={f.key} className="border-b border-border-muted hover:bg-secondary" onDoubleClick={() => openFolder(f.key)}>
                        <td className="px-3 py-2">
                          <button className="flex items-center gap-2 font-medium text-brand hover:underline" onClick={() => openFolder(f.key)}>
                            <span>📁</span>
                            {f.name}/
                          </button>
                        </td>
                        <td className="px-3 py-2 text-right text-text-muted">—</td>
                        <td className="px-3 py-2 text-text-muted">—</td>
                        <td className="px-3 py-2 text-text-muted">folder</td>
                        <td />
                      </tr>
                    ))}
                    {objects.map((o) => {
                      const shortName = o.key.slice(prefix.length);
                      return (
                        <tr key={o.key} className="border-b border-border-muted hover:bg-secondary">
                          <td className="max-w-[400px] px-3 py-2">
                            <div className="flex items-center gap-2">
                              <span className="shrink-0">{fileIcon(o.key)}</span>
                              <span className="truncate" title={o.key}>
                                {shortName}
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right font-mono">{fmtSize(o.size)}</td>
                          <td className="px-3 py-2 text-text-muted">{fmtDate(o.last_modified)}</td>
                          <td className="max-w-[100px] truncate px-3 py-2 text-xs text-text-muted" title={o.content_type}>
                            {o.content_type?.split('/')[1] ?? '—'}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1 whitespace-nowrap">
                              <button className="rounded-md border border-border p-1 text-text-muted hover:border-border-strong hover:text-foreground" title="Download" onClick={() => downloadObj(o.key)}>
                                <Download className="size-3" />
                              </button>
                              <button
                                className="rounded-md border border-border p-1 text-text-muted hover:border-border-strong hover:text-foreground"
                                title={copiedKey === o.key ? 'Copied!' : 'Copy URL'}
                                onClick={() => copyUrl(o.key)}
                              >
                                {copiedKey === o.key ? '✓' : <LinkIcon className="size-3" />}
                              </button>
                              <button
                                className="rounded-md border border-border p-1 text-text-muted hover:border-error hover:text-error"
                                title="Delete"
                                onClick={() => setDeleteObjTarget(o.key)}
                              >
                                <X className="size-3" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>

      <Dialog open={newBucketOpen} onOpenChange={setNewBucketOpen}>
        <DialogContent className="max-w-[460px] p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>New bucket</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 p-4">
            <label className="flex flex-col gap-1">
              <span className="text-sm font-semibold">Bucket name</span>
              <input
                value={newBucketName}
                onChange={(e) => setNewBucketName(e.target.value)}
                placeholder="e.g. my-assets"
                spellCheck={false}
                onKeyDown={(e) => e.key === 'Enter' && submitNewBucket()}
                className="h-8 rounded-md border border-border bg-secondary px-2 font-mono text-md outline-none focus-visible:border-border-strong focus-visible:ring-[2px] focus-visible:ring-ring/40"
              />
            </label>
            <label className="flex items-center gap-2 text-md">
              <input type="checkbox" checked={newBucketPublic} onChange={(e) => setNewBucketPublic(e.target.checked)} />
              Public bucket (objects accessible without auth)
            </label>
            {newBucketError && <p className="m-0 text-sm text-error">{newBucketError}</p>}
          </div>
          <DialogFooter className="border-t border-border px-4 py-3">
            <button className="h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong" onClick={() => setNewBucketOpen(false)}>
              Cancel
            </button>
            <button
              className="h-8 rounded-md bg-brand px-3 text-md text-brand-text-on hover:bg-brand-hover disabled:opacity-45"
              onClick={submitNewBucket}
              disabled={newBucketBusy}
            >
              {newBucketBusy ? 'Creating…' : 'Create bucket'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteBucketTarget} onOpenChange={(open) => !open && setDeleteBucketTarget(null)}>
        <DialogContent className="max-w-[400px] p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>Delete bucket</DialogTitle>
          </DialogHeader>
          <div className="p-4">
            <p className="m-0 text-md leading-relaxed">
              Permanently delete bucket <code className="rounded-sm border border-border bg-secondary px-1 font-mono text-sm">{deleteBucketTarget}</code> and{' '}
              <strong>all its objects</strong>? This cannot be undone.
            </p>
          </div>
          <DialogFooter className="border-t border-border px-4 py-3">
            <button className="h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong" onClick={() => setDeleteBucketTarget(null)}>
              Cancel
            </button>
            <button
              className="h-8 rounded-md bg-error px-3 text-md font-semibold text-background hover:brightness-110 disabled:opacity-45"
              onClick={confirmDeleteBucket}
              disabled={deleteBucketBusy}
            >
              {deleteBucketBusy ? 'Deleting…' : 'Delete bucket'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteObjTarget} onOpenChange={(open) => !open && setDeleteObjTarget(null)}>
        <DialogContent className="max-w-[400px] p-0">
          <DialogHeader className="border-b border-border px-4 py-3">
            <DialogTitle>Delete object</DialogTitle>
          </DialogHeader>
          <div className="p-4">
            <p className="m-0 text-md leading-relaxed">
              Permanently delete <code className="rounded-sm border border-border bg-secondary px-1 font-mono text-sm">{deleteObjTarget?.split('/').pop()}</code>?
            </p>
          </div>
          <DialogFooter className="border-t border-border px-4 py-3">
            <button className="h-8 rounded-md border border-border bg-secondary px-3 text-md hover:border-border-strong" onClick={() => setDeleteObjTarget(null)}>
              Cancel
            </button>
            <button
              className="h-8 rounded-md bg-error px-3 text-md font-semibold text-background hover:brightness-110 disabled:opacity-45"
              onClick={confirmDeleteObj}
              disabled={deleteObjBusy}
            >
              {deleteObjBusy ? 'Deleting…' : 'Delete'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
