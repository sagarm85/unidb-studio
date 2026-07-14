#!/usr/bin/env python3
"""
demo/vector_demo.py — vector similarity search demo using unidb's NEAR() SQL.

Creates a 'documents' table with a VECTOR(64) column, inserts product
descriptions as 64-dim word-hash embeddings, then demonstrates:

  SELECT id, title, vec_distance
  FROM documents
  WHERE NEAR(embedding, [...], 5)

Engine path: HNSW index → approximate k-nearest neighbours in microseconds.

Usage:
    python3 demo/vector_demo.py

NOTE ON EMBEDDINGS
  This script uses a simple 64-dim word-frequency hash vector so the demo
  runs with zero dependencies.  For production semantic search, replace
  `embed()` with sentence-transformers or an OpenAI embeddings call —
  the SQL surface (VECTOR column + NEAR predicate) is identical.

  Real model:
    from sentence_transformers import SentenceTransformer
    _model = SentenceTransformer('all-MiniLM-L6-v2')   # 384 dims
    def embed(text): return _model.encode(text).tolist()
    # → CREATE TABLE docs (... embedding VECTOR(384))
"""

import hashlib, json, math, sys, time, urllib.request, urllib.error

BASE  = "http://localhost:8080"
TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZXYiLCJleHAiOjE4MTU1NDYzMzV9.8I1BTxTJgJLVd-uHt80AiS3ufAEr6MhjeA5POFwWbEI"
HDRS  = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
BULK  = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/x-ndjson"}

DIM = 64  # vector dimensions (use 384+ with sentence-transformers)


# ── Simple word-hash embedding (no external deps) ────────────────────────────
def embed(text: str) -> list[float]:
    """
    Map text → DIM-dimensional unit vector via word-frequency hashing.

    Each word is hashed to a bucket in [0, DIM); its TF contributes to that
    dimension. The vector is L2-normalised so NEAR() (which uses Euclidean
    distance by default) behaves like cosine distance for unit vectors.

    Two semantically similar documents will share vocabulary and therefore
    land in nearby buckets → small Euclidean distance → NEAR() ranks them
    higher. This is NOT as powerful as a real embedding model but is enough
    to demonstrate the engine's HNSW index and NEAR() predicate.
    """
    words  = text.lower().split()
    counts = [0.0] * DIM
    for w in words:
        h = int(hashlib.md5(w.encode()).hexdigest(), 16) % DIM
        counts[h] += 1.0
    norm = math.sqrt(sum(x * x for x in counts)) or 1.0
    return [x / norm for x in counts]


# ── HTTP helpers ──────────────────────────────────────────────────────────────
def sql(q, label="", quiet=False):
    req = urllib.request.Request(
        f"{BASE}/sql",
        data=json.dumps({"sql": q}).encode(),
        headers=HDRS, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = json.loads(e.read())
    err = body.get("error") or (body.get("results") or [{}])[0].get("error")
    if err and not quiet:
        print(f"  ERR {label}: {err}", file=sys.stderr)
    elif label and not quiet:
        rows = (body.get("results") or [{}])[0].get("rows", [])
        val  = rows[0][0] if (len(rows)==1 and len(rows[0])==1) else f"{len(rows)} rows"
        print(f"  {label:40s} → {val}")
    return body


def bulk_insert(table, rows):
    body = "\n".join(json.dumps(r) for r in rows).encode()
    req  = urllib.request.Request(f"{BASE}/tables/{table}/bulk",
           data=body, headers=BULK, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


# ── Document corpus ──────────────────────────────────────────────────────────
DOCUMENTS = [
    ("1",  "Wireless Bluetooth Headphones",
     "Premium over-ear headphones with active noise cancellation. "
     "40-hour battery life, foldable design, Bluetooth 5.2 with multipoint connection."),
    ("2",  "Running Shoes Pro",
     "Lightweight marathon running shoes with carbon fiber plate and foam midsole. "
     "Breathable mesh upper, heel-to-toe drop 6mm, ideal for road running."),
    ("3",  "Smart Coffee Maker",
     "Programmable coffee machine with built-in grinder and milk frother. "
     "12-cup carafe, Wi-Fi connected app control, brew strength customisation."),
    ("4",  "USB-C Laptop Stand",
     "Aluminium ergonomic laptop stand with integrated USB-C hub. "
     "4K HDMI, 100W PD charging, 3x USB-A, adjustable height, foldable."),
    ("5",  "Mechanical Gaming Keyboard",
     "TKL mechanical keyboard with Cherry MX Red switches and per-key RGB. "
     "USB-C detachable cable, aluminium top plate, N-key rollover, anti-ghosting."),
    ("6",  "Yoga Mat Premium",
     "Non-slip natural rubber yoga mat 6mm thick with alignment lines. "
     "Moisture-wicking microfibre surface, carrying strap included."),
    ("7",  "Air Purifier HEPA",
     "True HEPA air purifier covering up to 400 sq ft. "
     "Removes 99.97% of particles, PM2.5 sensor, auto mode, sleep mode, quiet fan."),
    ("8",  "Resistance Band Set",
     "Set of 5 latex resistance bands for strength training and physical therapy. "
     "Pull-up assist, stretching, squats, door anchor and handles included."),
    ("9",  "Noise Cancelling Earbuds",
     "In-ear TWS earbuds with hybrid active noise cancellation and transparency mode. "
     "8-hour playtime plus 24 from case, IPX5 water-resistant, fast charge."),
    ("10", "Standing Desk Converter",
     "Sit-stand desktop converter with gas lift mechanism, 35-inch wide surface. "
     "Ergonomic keyboard tray, memory height settings, supports dual monitors."),
    ("11", "Trail Running Backpack",
     "Lightweight 10L trail running vest with 2L hydration bladder compatibility. "
     "Chest pocket for phone, trekking pole holders, reflective strips."),
    ("12", "Smart Air Quality Monitor",
     "Indoor air quality sensor tracking CO2, VOC, humidity, temperature and PM2.5. "
     "App dashboard with historical trends, alerts, compatible with HomeKit."),
]

QUERIES = [
    ("Find headphones / audio gear",
     "wireless headphones noise cancellation audio earbuds bluetooth"),
    ("Find desk and office accessories",
     "laptop stand desk ergonomic monitor USB hub keyboard"),
    ("Find fitness and running equipment",
     "running shoes trail fitness yoga resistance training"),
    ("Find air quality / home health devices",
     "air purifier quality sensor HEPA home indoor"),
]


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print("\n══ Vector Search Demo ════════════════════════════════════════════════")
    print(f"  DIM={DIM} (word-hash embedding — swap embed() for sentence-transformers")
    print("  or OpenAI to get true semantic similarity)\n")

    # ── Schema ────────────────────────────────────────────────────────────────
    print("── Schema setup ──────────────────────────────────────────────────────")
    sql("DROP TABLE IF EXISTS documents",  "drop documents",  quiet=True)
    sql(f"""CREATE TABLE documents (
              id      TEXT,
              title   TEXT,
              content TEXT,
              embedding VECTOR({DIM})
            )""", "create documents")
    sql(f"CREATE INDEX doc_embed_idx ON documents USING HNSW (embedding)",
        "create HNSW index")

    # ── Insert documents ──────────────────────────────────────────────────────
    print("\n── Inserting documents ──────────────────────────────────────────────")
    rows = []
    t0   = time.perf_counter()
    for doc_id, title, content in DOCUMENTS:
        vec = embed(f"{title} {content}")
        rows.append({"id": doc_id, "title": title, "content": content[:120],
                     "embedding": vec})
    resp = bulk_insert("documents", rows)
    ms   = (time.perf_counter() - t0) * 1000
    print(f"  Inserted {resp.get('inserted')} documents in {ms:.0f} ms")

    # ── NEAR() queries ────────────────────────────────────────────────────────
    print("\n── NEAR() semantic search ───────────────────────────────────────────")
    for q_label, q_text in QUERIES:
        q_vec  = embed(q_text)
        q_lit  = json.dumps(q_vec)
        t0     = time.perf_counter()
        res    = sql(
            f"SELECT id, title, vec_distance FROM documents WHERE NEAR(embedding, {q_lit}, 3)",
            quiet=True,
        )
        ms  = (time.perf_counter() - t0) * 1000
        rows = (res.get("results") or [{}])[0].get("rows", [])
        print(f"\n  Query: \"{q_label}\"  ({ms:.1f} ms round-trip)")
        for r in rows:
            dist = f"  dist={float(r[2]):.3f}" if r[2] is not None else ""
            print(f"    → [{r[0]}] {r[1]}{dist}")

    # ── Engine stats ──────────────────────────────────────────────────────────
    print("\n── Engine select latency (from /stats) ──────────────────────────────")
    req = urllib.request.Request(f"{BASE}/stats",
          headers={k:v for k,v in HDRS.items() if k!="Content-Type"})
    with urllib.request.urlopen(req, timeout=10) as r:
        stats = json.loads(r.read())
    sl = stats.get("statement_latency", {}).get("select", {})
    print(f"  select count={sl.get('count',0)}  "
          f"p50={sl.get('p50_us',0)} μs  p99={sl.get('p99_us',0)} μs")

    print("\n✓ Vector demo done. SQL used: WHERE NEAR(embedding, [...], k)\n")


if __name__ == "__main__":
    main()
