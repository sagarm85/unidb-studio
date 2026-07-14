# unidb Studio — Demo Guide

Full demo running order. Each part is independent; run them in sequence or pick any section.

---

## 0. Clean start

```bash
# Kill any running processes and free ports
pkill -f unidb-server-full; pkill -f vite
lsof -ti:5173 | xargs kill -9 2>/dev/null || true
lsof -ti:8080 | xargs kill -9 2>/dev/null || true

# Wipe engine data (tables, WAL, indexes — everything)
rm -rf /tmp/unidb-demo-data && mkdir -p /tmp/unidb-demo-data

# If using Docker demo (Postgres comparison), wipe volumes too:
cd demo && docker-compose -f docker-compose.demo.yml down -v && cd ..
```

> **"clean" means `/tmp/unidb-demo-data` is wiped.** The binary, JWT, and Studio source are untouched.

---

## 1. Start the stack

### Option A — local binary + MinIO (Storage tab)

```bash
# Step 1 — start MinIO (one-time; the createbucket service makes the `unidb` bucket)
cd /path/to/unidb
docker compose -f docker/docker-compose.minio.yml up -d
# MinIO S3 API: http://localhost:9000
# MinIO console: http://localhost:9001  (minioadmin / minioadmin)

# Step 2 — build engine then start in background (logs → /tmp/unidb.log)
# Release is the default: seed.py / benchmark.py / compare.py are all
# perf-sensitive, and a debug build is ~10-50× slower on the write path
# (index-backed constraint checks are unoptimized without --release) —
# it LOOKS like a regression, it's just the wrong build profile.
cargo build --release -p unidb-server-full        # release (fast runtime — use this)
# cargo build -p unidb-server-full                # debug (fast compile; only for iterating on server source itself)

# UNIDB_BUFFER_POOL_PAGES: raise this for seeds past ~30k rows/table, or the
# default (4096 pages = 32MB) exhausts mid-load and forces a synchronous WAL
# fsync on every write once it's full — throughput collapses to ~1-2k rows/s
# even on a correct, current build. This is NOT a Postgres shared_buffers-style
# RAM budget: unidb is mmap-backed, so page bytes already live in the OS page
# cache "for free" — the pool is just pin/dirty tracking metadata, ~24 bytes
# per frame. 1,000,000 frames (covers the 1M/5M presets with headroom) costs
# ~24MB of bookkeeping, not the ~8GB a naive frames×page_size calc implies.
# Measured: 1.5M-row seed with this setting -> 0 buffer-pool evictions, 250MB
# total process RSS, customers flat at ~23-25k rows/s (vs ~1-2k/s at default).
# Tradeoff: a bigger pool allows more dirty pages to accumulate before a
# checkpoint, so a crash mid-load means a longer ARIES redo replay on next
# open — not a RAM cost, a recovery-time one.
nohup env \
  UNIDB_DATA_DIR=/tmp/unidb-demo-data \
  UNIDB_JWT_SECRET=dev-secret \
  UNIDB_REQUEST_TIMEOUT_SECS=300 \
  UNIDB_BUFFER_POOL_PAGES=1000000 \
  STORAGE_BACKEND=minio \
  STORAGE_S3_ENDPOINT=http://localhost:9000 \
  STORAGE_ACCESS_KEY=minioadmin \
  STORAGE_SECRET_KEY=minioadmin \
  STORAGE_BUCKET=unidb \
  STORAGE_FORCE_PATH_STYLE=true \
  ./target/release/unidb-server-full > /tmp/unidb.log 2>&1 < /dev/null &
  # swap release/ → debug/ only if you built the debug line above
# To tail logs: tail -f /tmp/unidb.log
# To stop:      pkill -f unidb-server-full

# Step 3 — Studio dev server (logs → /tmp/studio.log)
# < /dev/null prevents Vite from suspending on tty input when backgrounded
cd unidb-studio && nohup npm run dev > /tmp/studio.log 2>&1 < /dev/null &
# Open http://localhost:5173
# To tail logs: tail -f /tmp/studio.log
```

> The Storage tab will now show the `unidb` bucket. To stop MinIO:
> `docker compose -f docker/docker-compose.minio.yml down`
> (add `-v` to wipe stored objects too)

---

## 2. E-commerce schema + seed

```bash
# Create 6 tables with FK constraints
python3 demo/setup_schema.py

# Seed — start at 10k, scale up for bigger demo.
# Measured end-to-end (release build, UNIDB_BUFFER_POOL_PAGES=1000000 per
# Step 2 above, fresh schema each run) — the old estimates here predated the
# release-build default and the buffer-pool fix and were off by ~15-25x.
python3 demo/seed.py --size 10k    # ~15k rows,   ~1s
python3 demo/seed.py --size 50k    # ~75k rows,   ~4s
python3 demo/seed.py --size 200k   # ~300k rows,  ~19s
python3 demo/seed.py --size 1M     # ~1.5M rows,  ~1.5 min
python3 demo/seed.py --size 5M     # ~4M rows,    ~4 min
python3 demo/seed.py --size 10M    # ~8M rows,    ~8.5 min
```

**Studio walkthrough after seeding:**

| Tab | What to show |
|-----|-------------|
| **Schema** | Six tables with FK relationship arrows (customers → orders → order_items, etc.) |
| **Records** | Browse `customers` table — 5k rows, pagination, column filter |
| **SQL** | Run `SELECT p.category, SUM(oi.line_total) FROM order_items oi JOIN products p ON p.id = oi.product_id GROUP BY p.category ORDER BY 2 DESC` |
| **Query Performance** | Engine insert p50/p99 μs (B-tree cost), SELECT latency after the JOIN above |
| **Observability** | Live WAL bytes, commit count, buffer pool hit ratio |

### Complex query — 50 k rows from 5 M (good for 5M+ seeds)

Run this in Studio → **SQL editor** after seeding at `--size 5M` or larger.
It performs a 4-table join with GROUP BY + HAVING + ORDER BY — a realistic
read-heavy analytics workload across millions of rows.

```sql
-- Revenue & invoice analytics per customer — up to 50 k rows from 5 M dataset
-- Expect: multi-second runtime; watch p99 spike in Observability → Query Performance
SELECT
    c.id             AS customer_id,
    c.name           AS customer_name,
    c.city,
    c.country,
    COUNT(o.id)      AS order_count,
    SUM(oi.line_total)   AS order_revenue,
    AVG(oi.unit_price)   AS avg_unit_price,
    COUNT(i.id)      AS invoice_count,
    SUM(i.total_amount)  AS total_invoiced,
    MAX(o.created_at)    AS last_order_at
FROM customers c
JOIN orders      o  ON o.customer_id = c.id
JOIN order_items oi ON oi.order_id   = o.id
JOIN invoices    i  ON i.order_id    = o.id
GROUP BY c.id, c.name, c.city, c.country
HAVING COUNT(o.id) >= 2
ORDER BY order_revenue DESC
LIMIT 50000;
```

**What to show:**

| Observability tab | Expected |
|---|---|
| Query Performance → Statement latency | `select` p99 spikes into 100s ms range |
| Overview → Commits/sec | Flat (read-only query) |
| Overview → Buffer pool hit ratio | Should stay high (>90%) on repeat runs |

---

## 3. Postgres comparison

> Requires Docker (Option B above). Produces `public/benchmark-results.json` for the Studio Compare tab.

```bash
python3 demo/compare.py --size 10k
# Then open Studio → Compare tab
```

The Compare tab shows horizontal bars: unidb (blue-accent) vs Postgres (blue `#336791`) per query. A verdict banner shows total time and speedup/slowdown ratio.

For a more dramatic comparison run `--size 50k` or `--size 200k`.

---

## 4. Events / real-time CDC

### What it demonstrates
Every committed INSERT / UPDATE / DELETE fires an event on the SSE stream in **< 5 ms**. No polling — the Studio Events tab updates the moment the transaction commits.

### Steps

**Terminal / Studio split-screen:**

1. Studio → **Events tab** → select table `orders` → click **Enable** → click **Start**
2. In a new terminal:
   ```bash
   python3 demo/events_demo.py
   ```
3. Watch events appear in the Studio Events tab in real-time:
   - 3 × `INSERT` events (new pending orders)
   - 3 × `UPDATE` events (`pending → confirmed`)
   - 1 × `DELETE` event

### Manual demo in SQL editor

```sql
-- Enable CDC on orders (one-time)
-- (done by the script, or via Studio Events tab)

-- INSERT → fires event immediately
INSERT INTO orders (id, customer_id, status, total_amount, created_at)
VALUES (99999, 1, 'pending', 149.99, 1700000000);

-- UPDATE → fires UPDATE event with before/after
UPDATE orders SET status = 'shipped' WHERE id = 99999;

-- DELETE → fires DELETE event with old row
DELETE FROM orders WHERE id = 99999;
```

**Studio Events tab columns:** seq, operation (INSERT/UPDATE/DELETE chip), table, txn ID, row data (payload). Click any row to open a detail drawer showing the full JSON payload formatted with indentation.

---

## 5. Vector search (NEAR)

### What it demonstrates
unidb stores `VECTOR(n)` columns and builds an **HNSW** approximate nearest-neighbour index. `WHERE NEAR(col, <vector>, k)` returns the k closest rows in **sub-millisecond** time.

### How vector search actually works

> **Plain-English searches don't go directly into SQL.** Every vector database
> (unidb, pgvector, Pinecone, Qdrant) works the same way:
>
> ```
> Your text: "wireless headphones"
>       ↓  embed() — your Python code, sentence-transformers, OpenAI, etc.
>  [0.12, 0.04, 0.31, ...]   ← numeric vector the engine can compare
>       ↓
>  WHERE NEAR(embedding, [...], 3)
> ```
>
> Text → vector conversion is an **application-layer step**.
> The engine stores and ranks `f32` arrays; it has no built-in language model.
> The demo script (`vector_demo.py`) does this conversion for you — you pass a
> text query string, it embeds it, then queries unidb with the resulting vector.

```bash
python3 demo/vector_demo.py
```

**What the script does:**
1. Creates `documents` table with `VECTOR(64)` column
2. `CREATE INDEX USING HNSW` on the embedding column
3. Inserts 12 product descriptions — each converted to a 64-dim vector by `embed(text)`
4. Runs 4 text searches (converted to vectors automatically):
   - `"wireless headphones noise cancellation audio earbuds bluetooth"` → finds headphone products
   - `"laptop stand desk ergonomic monitor USB hub keyboard"` → finds desk/office items
   - `"running shoes trail fitness yoga resistance training"` → finds fitness gear
   - `"air quality CO2 humidity sensor smart home"` → finds air quality devices
5. Prints top-3 nearest neighbours per query with round-trip time

**Studio SQL editor — try it live:**

```sql
-- See the documents table and their stored titles
SELECT id, title FROM documents;
```

Then open the **SQL editor → Embed** button (toolbar, top-right of the editor).
Type any plain-English query — e.g. `wireless headphones noise cancellation` —
and click **Insert** to drop the pre-computed 64-dim vector straight into your
NEAR() clause at the cursor. No terminal needed.

**Low-level reference — what NEAR looks like at the SQL layer:**

The vector below is what `embed("wireless headphones noise cancellation")` produces.
In real applications this vector comes from your backend, not typed by hand.

```sql
-- Developer reference: raw NEAR syntax (vector pre-computed by application code)
-- embed("wireless headphones noise cancellation") → this 64-dim vector:
SELECT id, title
FROM documents
WHERE NEAR(embedding, [0.0, 0.5, 0.0, 0.0, 0.5, 0.0, 0.0, 0.0,
                        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
                        0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
                        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.5, 0.0,
                        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
                        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
                        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
                        0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], 3);
```

### Upgrade to real semantic embeddings

```python
# Replace embed() in vector_demo.py / embed_search.py with:
from sentence_transformers import SentenceTransformer
_model = SentenceTransformer('all-MiniLM-L6-v2')   # 384-dim, ~80 MB

def embed(text: str) -> list[float]:
    return _model.encode(text).tolist()

# Change DIM = 384, and CREATE TABLE ... embedding VECTOR(384)
# Usage stays identical: embed("wireless headphones") → vector → NEAR()
```

---

## 6. Document upload + embedding search

### What it demonstrates
Full pipeline: **MinIO stores raw files** → **unidb stores vectors + metadata** → `NEAR()` finds semantically similar documents → results include the MinIO object key for direct download.

```bash
# Start MinIO (either Docker compose, or local minio server)
python3 demo/embed_search.py
```

**Pipeline steps:**
1. Creates bucket `documents` in MinIO
2. Uploads 6 text documents via `PUT /storage/documents/objects/{key}`
3. Reads each document back from MinIO
4. Generates word-hash embedding (swap for sentence-transformers in production)
5. Stores `(id, title, source_key, snippet, embedding VECTOR(64))` in unidb
6. Runs 4 semantic searches via `WHERE NEAR(embedding, [...], 3)`
7. Returns results with the MinIO `source_key` so you can download originals

**Studio walkthrough after the script:**

| Tab | What to show |
|-----|-------------|
| **Storage** | `documents/` bucket → 6 text files uploaded, downloadable |
| **Records** | `doc_embeddings` table — snippet, source_key, VECTOR values |
| **SQL** | Run NEAR query live: `SELECT title, source_key FROM doc_embeddings WHERE NEAR(embedding, [...], 3)` |

### Architecture diagram

```
User uploads PDF/TXT
        │
        ▼
PUT /storage/documents/objects/key   ← MinIO stores raw bytes
        │
        ▼ (script or background worker reads it)
embed(content) → [f32; 384]
        │
        ▼
INSERT INTO doc_embeddings (title, source_key, embedding)
        │
        ▼
WHERE NEAR(embedding, query_vec, k)  ← HNSW index answers in μs
        │
        ▼
result rows contain source_key → GET /storage/documents/objects/key
```

---

## 7. Benchmark queries (after seeding)

```bash
python3 demo/benchmark.py
```

Watch the **Observability tab** during the bulk UPDATE — the `update` latency gauge spikes then recovers.

Sample output at 50k size:
```
── Benchmark queries ─────────────────────────────────────────────────────
     12.4 ms  COUNT customers             →  5000
      8.1 ms  COUNT orders                →  10000
     18.6 ms  COUNT order_items           →  30000
      7.3 ms  Orders by status (delivered) → 2018
    142.3 ms  Top 10 customers by revenue →  10 rows
     89.5 ms  Revenue by product category →  10 rows
     11.2 ms  Unpaid invoices total        →  3521849.47
      6.8 ms  Average order value          →  249.33

── Bulk UPDATE ───────────────────────────────────────────────────────────
    198.4 ms  Update 'pending' → 'confirmed'

── Engine latency (μs) ───────────────────────────────────────────────────
  insert     count=75,000  p50=4,096μ  p99=32,768μ
  select     count=8       p50=128μ    p99=2,048μ
  update     count=1       p50=32,768μ p99=32,768μ
```

---

## Quick reference

| Script | Purpose |
|--------|---------|
| `setup_schema.py` | Drop + recreate 6 tables with FK constraints |
| `seed.py --size N` | Bulk seed (10k / 50k / 200k / 1M) |
| `benchmark.py` | Run 8 representative queries + print engine stats |
| `compare.py --size N` | Seed + benchmark unidb AND Postgres; write `public/benchmark-results.json` |
| `events_demo.py` | Enable CDC, insert/update/delete, stream events to terminal |
| `vector_demo.py` | Create VECTOR table, HNSW index, run NEAR() queries |
| `embed_search.py` | Upload docs to MinIO, embed, NEAR() search + presigned download |

| Studio tab | Primary use |
|------------|-------------|
| SQL editor | Live queries, DDL, bulk UPDATE |
| Records | Browse table rows with pagination |
| Schema | FK relationship graph |
| Events | Real-time CDC event stream |
| Observability | Engine metrics (WAL, commits, buffer pool) |
| Logs | Structured request logs with correlation IDs |
| Query Performance | Per-kind engine latency + browser query history |
| Compare | unidb vs Postgres bar charts |
| Storage | MinIO bucket/object browser + upload |
