#!/usr/bin/env python3
"""
demo/embed_search.py — document upload to MinIO + embedding-based search.

Shows the full pipeline:

  1. Read all .txt files from  demo/documents/
  2. Upload each file to MinIO  PUT /storage/{bucket}/objects/{key}
  3. Generate a vector embedding from the content
  4. Store (title, source_key, snippet, embedding) in unidb `doc_embeddings`
  5. Run  WHERE NEAR(embedding, <query_vec>, k)  to do semantic search
  6. Return results with the MinIO object key so the caller can download originals

Add a new document: just drop a .txt file into demo/documents/ and re-run.

Usage:
    python3 demo/embed_search.py

NOTE ON EMBEDDINGS
  Uses the same pure-Python word-hash embedding as vector_demo.py — zero deps.
  For production quality swap embed() for:

    from sentence_transformers import SentenceTransformer
    _model = SentenceTransformer('all-MiniLM-L6-v2')   # 384-dim
    def embed(text): return _model.encode(text).tolist()
    # CREATE TABLE doc_embeddings (... embedding VECTOR(384))

  or:
    import openai
    def embed(text):
        r = openai.embeddings.create(model='text-embedding-3-small', input=text)
        return r.data[0].embedding   # 1536-dim

  The SQL surface is identical — only DIM changes in CREATE TABLE.
"""

import hashlib, json, math, os, sys, time, urllib.request, urllib.error

BASE    = "http://localhost:8080"
TOKEN   = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZXYiLCJleHAiOjk5OTk5OTk5OTl9.2g_W4FLYYKKISbZ3lzL0LRK4FE6WWS4bp7w0dKGvuqA"
HDRS    = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
BUCKET  = "documents"
DIM     = 64

# Directory containing .txt files to upload — relative to this script
DOCS_DIR = os.path.join(os.path.dirname(__file__), "documents")

SEARCH_QUERIES = [
    ("Database transactions and ACID guarantees",
     "database transactions ACID commit rollback atomicity durability"),
    ("Vector search and embeddings",
     "vector embedding HNSW nearest neighbour semantic search similarity"),
    ("Crash recovery and write-ahead logging",
     "crash recovery WAL write-ahead log durability fsync checkpoint"),
    ("Query optimization and index strategies",
     "query plan index optimization explain analyze B-tree performance"),
]


# ── Document discovery ────────────────────────────────────────────────────────
def load_documents():
    """Read all .txt files from DOCS_DIR. Returns list of (key, title, content)."""
    if not os.path.isdir(DOCS_DIR):
        print(f"  [WARN] {DOCS_DIR} not found — no documents to upload.", file=sys.stderr)
        return []

    docs = []
    for fname in sorted(os.listdir(DOCS_DIR)):
        if not fname.endswith(".txt"):
            continue
        path  = os.path.join(DOCS_DIR, fname)
        title = fname[:-4].replace("-", " ").replace("_", " ").title()
        with open(path, encoding="utf-8") as f:
            content = f.read().strip()
        # First non-empty line is often a better title than the filename
        first_line = next((l.strip() for l in content.splitlines() if l.strip()), title)
        docs.append((fname, first_line, content))
    return docs


# ── Word-hash embedding (pure Python, no deps) ───────────────────────────────
def embed(text: str) -> list[float]:
    words  = text.lower().split()
    counts = [0.0] * DIM
    for w in words:
        h = int(hashlib.md5(w.encode()).hexdigest(), 16) % DIM
        counts[h] += 1.0
    norm = math.sqrt(sum(x*x for x in counts)) or 1.0
    return [x / norm for x in counts]


# ── HTTP helpers ──────────────────────────────────────────────────────────────
def sql(q, label="", quiet=False):
    req = urllib.request.Request(
        f"{BASE}/sql",
        data=json.dumps({"sql": q}).encode(),
        headers=HDRS, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = json.loads(e.read())
    err = body.get("error") or (body.get("results") or [{}])[0].get("error")
    if err and not quiet:
        print(f"  ERR {label}: {err}", file=sys.stderr)
    elif label and not quiet:
        rows = (body.get("results") or [{}])[0].get("rows", [])
        val  = rows[0][0] if (len(rows)==1 and len(rows[0])==1) else f"{len(rows)} rows"
        print(f"  SQL {label:35s} → {val}")
    return body


_storage_ok = None


def _check_storage():
    global _storage_ok
    if _storage_ok is not None:
        return _storage_ok
    req = urllib.request.Request(
        f"{BASE}/storage/buckets",
        headers={k: v for k, v in HDRS.items() if k != "Content-Type"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5):
            _storage_ok = True
    except urllib.error.HTTPError as e:
        _storage_ok = (e.code != 503)
    except Exception:
        _storage_ok = False
    return _storage_ok


def create_bucket(name):
    if not _check_storage():
        print(f"  [SKIP] Bucket '{name}' — MinIO not configured (start with docker-compose)")
        return
    req = urllib.request.Request(
        f"{BASE}/storage/buckets",
        data=json.dumps({"name": name}).encode(),
        headers=HDRS, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            json.loads(r.read())
            print(f"  Bucket '{name}' created")
    except urllib.error.HTTPError as e:
        body = json.loads(e.read())
        if "already" in body.get("error", "").lower() or e.code == 409:
            print(f"  Bucket '{name}' already exists")
        else:
            print(f"  ERR creating bucket: {body.get('error')}", file=sys.stderr)


def storage_put(bucket, key, content: str) -> bool:
    if not _check_storage():
        return False
    body = content.encode()
    req  = urllib.request.Request(
        f"{BASE}/storage/{bucket}/objects/{key}",
        data=body,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "text/plain",
            "Content-Length": str(len(body)),
        },
        method="PUT",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            json.loads(r.read())
            return True
    except urllib.error.HTTPError:
        return False


def storage_get(bucket, key) -> str | None:
    """Download object via presigned URL (C7 → MinIO direct fetch)."""
    if not _check_storage():
        return None
    # Step 1: get presigned GET URL from engine
    req = urllib.request.Request(
        f"{BASE}/storage/{bucket}/presign/{key}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            url = json.loads(r.read()).get("presigned_get_url")
    except (urllib.error.HTTPError, urllib.error.URLError):
        return None
    if not url:
        return None
    # Step 2: fetch directly from MinIO using the presigned URL (no auth header)
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return r.read().decode()
    except Exception:
        return None


def bulk_insert(table, rows):
    body = "\n".join(json.dumps(r) for r in rows).encode()
    req  = urllib.request.Request(f"{BASE}/tables/{table}/bulk",
           data=body,
           headers={"Authorization": f"Bearer {TOKEN}",
                    "Content-Type": "application/x-ndjson"},
           method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print("\n══ Document Upload + Embedding Search ═══════════════════════════════")
    print("  MinIO = blob store  │  unidb = vector index + metadata\n")

    # ── Discover documents ────────────────────────────────────────────────────
    docs = load_documents()
    if not docs:
        print("  No .txt files found in demo/documents/ — nothing to do.")
        return
    print(f"  Found {len(docs)} document(s) in {DOCS_DIR}:")
    for key, title, content in docs:
        print(f"    {key}  ({len(content)} chars)")

    # ── 1. Create MinIO bucket ────────────────────────────────────────────────
    print("\n── Step 1: Create storage bucket ────────────────────────────────────")
    create_bucket(BUCKET)
    storage_live = _check_storage()

    # ── 2. Upload all documents to MinIO ─────────────────────────────────────
    print("\n── Step 2: Upload documents to MinIO ────────────────────────────────")
    if not storage_live:
        print("  [INFO] MinIO not running — skipping upload, embedding inline content.")
        print("         Start with:  cd demo && docker-compose -f docker-compose.demo.yml up -d")
    else:
        for key, title, content in docs:
            ok = storage_put(BUCKET, key, content)
            print(f"  PUT  {BUCKET}/{key}  ({len(content)} chars)  → {'ok' if ok else 'FAIL'}")

    # ── 3. Create unidb vector table ─────────────────────────────────────────
    print("\n── Step 3: Create embedding table in unidb ──────────────────────────")
    sql("DROP TABLE IF EXISTS doc_embeddings", quiet=True)
    sql(f"""CREATE TABLE doc_embeddings (
              id         INT,
              title      TEXT,
              source_key TEXT,
              snippet    TEXT,
              embedding  VECTOR({DIM})
            )""", "create doc_embeddings")
    sql("CREATE INDEX doc_emb_hnsw ON doc_embeddings USING HNSW (embedding)",
        "create HNSW index")

    # ── 4. Embed and insert all documents ────────────────────────────────────
    print("\n── Step 4: Embed documents and store in unidb ───────────────────────")
    rows = []
    t0   = time.perf_counter()
    for i, (key, title, content) in enumerate(docs):
        fetched = storage_get(BUCKET, key) if storage_live else None
        text    = fetched if fetched else content
        vec     = embed(f"{title} {text}")
        snippet = text[:200].replace("\n", " ").strip()
        source  = f"{BUCKET}/{key}" if storage_live else f"inline/{key}"
        rows.append({"id": i+1, "title": title, "source_key": source,
                     "snippet": snippet, "embedding": vec})
        print(f"  Embedded [{i+1}/{len(docs)}] {title}")
    resp = bulk_insert("doc_embeddings", rows)
    ms   = (time.perf_counter() - t0) * 1000
    print(f"  Stored {resp.get('inserted')} embeddings in {ms:.0f} ms")

    # ── 5. Semantic search using NEAR() ───────────────────────────────────────
    print("\n── Step 5: Semantic search with NEAR() ──────────────────────────────")
    for q_label, q_text in SEARCH_QUERIES:
        q_vec = embed(q_text)
        q_lit = json.dumps(q_vec)
        t0    = time.perf_counter()
        res   = sql(
            f"SELECT id, title, source_key, vec_distance FROM doc_embeddings"
            f" WHERE NEAR(embedding, {q_lit}, {len(docs)}) AND vec_distance < 1.3",
            quiet=True,
        )
        ms   = (time.perf_counter() - t0) * 1000
        rows = (res.get("results") or [{}])[0].get("rows", [])
        print(f"\n  Query: \"{q_label}\"  ({ms:.1f} ms)")
        if rows:
            for r in rows:
                print(f"    → [{r[0]}] {r[1]:<50s}  dist={float(r[3]):.4f}")
                print(f"       source: {r[2]}")
        else:
            print("    (no matches within distance 1.3)")

    # ── 6. Retrieve a document from MinIO ─────────────────────────────────────
    print("\n── Step 6: Retrieve original document from MinIO ────────────────────")
    first_key = docs[0][0]
    content   = storage_get(BUCKET, first_key) if storage_live else None
    if content:
        print(f"  Retrieved  {BUCKET}/{first_key}  ({len(content)} chars)")
        print(f"  Preview: {content[:120].strip()}…")
    else:
        print("  [SKIP] MinIO not running — open Studio → Storage tab after docker-compose")

    print("\n✓ Pipeline complete.")
    print(f"  {len(docs)} document(s) uploaded to MinIO bucket '{BUCKET}'.")
    print("  unidb stores embeddings + metadata. NEAR() finds closest in μs via HNSW.\n")
    print("  Open Studio → Storage tab to browse uploaded files.")
    print("  Open Studio → SQL editor → Embed button to run your own searches:\n")
    print("    SELECT id, title, source_key, vec_distance")
    print("    FROM doc_embeddings")
    print(f"    WHERE NEAR(embedding, [...], {len(docs)})")
    print("      AND vec_distance < 1.3;\n")


if __name__ == "__main__":
    main()
