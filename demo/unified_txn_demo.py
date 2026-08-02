#!/usr/bin/env python3
"""
demo/unified_txn_demo.py — THE moat scene.

One transaction. Four data models. One commit.

This is the one thing unidb does that a Postgres + vector-store + graph-DB +
Kafka stack structurally cannot: a single ACID transaction that writes a
relational row, a vector embedding, and a graph edge — and emits exactly one
change event — atomically. One `POST /txn/begin`, one `POST /txn/{id}/commit`,
one WAL, one snapshot. If any step fails, ALL of it rolls back — across every
model at once.

Everything here is live and engine-truthful — no mocks. It exercises the real
documented routes:
  * POST /txn/begin, POST /txn/{id}/commit, POST /txn/{id}/rollback   (R1 sessions)
  * POST /sql            with header  X-Txn-Id: <id>   (relational + vector writes)
  * POST /edges          with header  X-Txn-Id: <id>   (graph edge, joins the txn)
  * POST /tables/{t}/events + GET /events/head          (transactional CDC proof)

Usage (server running; run from the unidb-studio root):
    python3 demo/unified_txn_demo.py

Config: reads VITE_UNIDB_TOKEN from .env.local (override with env UNIDB_TOKEN);
base URL from env UNIDB_URL (default http://localhost:8080). Requires `dev` to
be a superuser (see DEMO_GUIDE.md Step 4b).
"""

import json
import os
import socket
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
BASE = os.environ.get("UNIDB_URL", "http://localhost:8080").rstrip("/")


def _token():
    tok = os.environ.get("UNIDB_TOKEN")
    if tok:
        return tok.strip()
    env_path = HERE.parent / ".env.local"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("VITE_UNIDB_TOKEN="):
                return line.split("=", 1)[1].strip()
    sys.exit("No token: set UNIDB_TOKEN or put VITE_UNIDB_TOKEN in .env.local")


TOKEN = _token()


def _req(method, path, body=None, txn_id=None):
    headers = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}
    if txn_id is not None:
        headers["X-Txn-Id"] = str(txn_id)
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(f"{BASE}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return json.loads(raw)
        except Exception:
            return {"error": raw.decode(errors="replace"), "http": e.code}


def sql(query, txn_id=None):
    """Run one SQL statement (optionally inside session `txn_id`). Raises on error."""
    resp = _req("POST", "/sql", {"sql": query}, txn_id=txn_id)
    err = resp.get("error") or (resp.get("results") or [{}])[0].get("error")
    if err:
        raise RuntimeError(f"SQL failed: {err}\n  query: {query[:80]}")
    return resp


def scalar(query):
    """Run a one-shot (auto-commit, fresh snapshot) SELECT returning a single value."""
    rows = (sql(query).get("results") or [{}])[0].get("rows") or [[None]]
    return rows[0][0]


def head_seq():
    """Monotonic seq *allocation* high-water — NOT a committed-event count.
    It advances even for rolled-back writes; use delivered_events() to see what a
    consumer actually receives."""
    return _req("GET", "/events/head").get("seq")


def delivered_events(from_seq, table="moat_order", wait=1.5):
    """Events actually delivered to a consumer strictly after `from_seq`, read off
    the real SSE stream (GET /events/subscribe). Rolled-back writes never appear
    here — this is the truthful "did an event fire" probe."""
    url = f"{BASE}/events/subscribe?table={table}&from_seq={from_seq}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {TOKEN}"})
    out = []
    try:
        with urllib.request.urlopen(req, timeout=wait) as r:
            while True:
                line = r.readline()  # replayed events arrive at once, then this blocks
                if not line:
                    break
                line = line.decode(errors="replace").strip()
                if line.startswith("data:"):
                    try:
                        out.append(json.loads(line[5:].strip()))
                    except ValueError:
                        pass
    except (socket.timeout, TimeoutError, urllib.error.URLError):
        pass  # expected: the stream blocks once the backlog is drained
    return out


def edges_from(node_id):
    resp = _req("GET", f"/edges/from/{node_id}")
    return resp.get("edges", resp if isinstance(resp, list) else [])


def clear_edges_from(node_id):
    """Delete every edge out of `node_id` so re-runs start clean (the built-in
    __edges__ store isn't dropped by CREATE/DROP TABLE)."""
    for e in edges_from(node_id):
        rid = e.get("row_id") or {}
        if "page_id" in rid and "slot" in rid:
            _req("DELETE", f"/edges/{rid['page_id']}/{rid['slot']}", {"from_id": node_id})


def rule(title=""):
    print(f"\n\033[1m── {title} " + "─" * max(0, 62 - len(title)) + "\033[0m")


# ── A tiny, readable, self-contained model (no seed.py needed) ────────────────
VEC = "[0.11, 0.22, 0.33, 0.44, 0.55, 0.66, 0.77, 0.88]"  # 8-dim, human-readable
CUSTOMER_ID = 7
PRODUCT_ID = 42
_seq_after_commit = 0  # replay cursor carried from the commit scene to the rollback scene


def setup():
    rule("Setup — three models in ONE database")
    sql("DROP TABLE IF EXISTS moat_order")
    sql("DROP TABLE IF EXISTS moat_embedding")
    sql("CREATE TABLE moat_order (id INTEGER, customer_id INTEGER, product TEXT, amount FLOAT)")
    sql("CREATE TABLE moat_embedding (order_id INTEGER, embedding VECTOR(8))")
    clear_edges_from(CUSTOMER_ID)  # drop leftover edges from prior runs (idempotent)
    try:
        sql("CREATE INDEX moat_vec_idx ON moat_embedding USING HNSW (embedding)")
    except RuntimeError:
        pass  # index optional — NEAR falls back to brute force
    _req("POST", "/tables/moat_order/events")  # enable CDC (idempotent)
    print("  moat_order       relational table  (CDC enabled)")
    print("  moat_embedding   VECTOR(8) + HNSW index")
    print("  __edges__        graph edge store   (built-in)")


def atomic_write():
    rule("The money move — 4 writes, 3 models, 1 event, 1 commit")

    seq_before = head_seq()  # replay cursor: only see events committed after here

    # 1) BEGIN one transaction
    txn = _req("POST", "/txn/begin", {"isolation": "read_committed"})
    txn_id = txn.get("txn_id") or txn.get("xid")
    print(f"  BEGIN  → txn {txn_id}")

    # 2) relational + 3) vector + 4) graph — all carrying X-Txn-Id: txn_id
    sql(f"INSERT INTO moat_order (id, customer_id, product, amount) "
        f"VALUES (1001, {CUSTOMER_ID}, 'noise-cancelling headphones', 299.00)", txn_id)
    print("    + relational  INSERT moat_order #1001")

    sql(f"INSERT INTO moat_embedding (order_id, embedding) VALUES (1001, {VEC})", txn_id)
    print("    + vector      INSERT moat_embedding (8-dim)")

    _req("POST", "/edges",
         {"from_id": CUSTOMER_ID, "to_id": PRODUCT_ID,
          "edge_type": "PURCHASED", "props": {"order_id": 1001}},
         txn_id=txn_id)
    print(f"    + graph       EDGE ({CUSTOMER_ID})-[:PURCHASED]->({PRODUCT_ID})")

    # ATOMICITY PROOF: a separate one-shot connection sees NONE of it yet.
    unseen = scalar("SELECT COUNT(*) FROM moat_order WHERE id = 1001")
    print(f"  another connection sees the order? count={unseen}  (uncommitted = invisible)")

    # ONE commit makes all three models + the event durable together.
    _req("POST", f"/txn/{txn_id}/commit", None)
    print(f"  COMMIT → txn {txn_id}")

    # After commit: everything is there, across all three models…
    n_rows = scalar("SELECT COUNT(*) FROM moat_order WHERE id = 1001")
    n_vec = scalar("SELECT COUNT(*) FROM moat_embedding WHERE order_id = 1001")
    near = scalar(f"SELECT order_id FROM moat_embedding WHERE NEAR(embedding, {VEC}, 1)")
    n_edges = len(edges_from(CUSTOMER_ID))
    # …and exactly one change event was DELIVERED to consumers (read off the SSE
    # stream, not the seq high-water — that's the honest measure).
    global _seq_after_commit
    _seq_after_commit = head_seq()
    evs = [e for e in delivered_events(seq_before) if e.get("payload", {}).get("id") == 1001]

    print("\n  after COMMIT — all four, atomically:")
    print(f"    relational  moat_order rows      = {n_rows}")
    print(f"    vector      NEAR() top match     = order {near}")
    print(f"    graph       edges from cust {CUSTOMER_ID}   = {n_edges}")
    print(f"    event       delivered to consumer = {len(evs)}  "
          f"(op={evs[0]['op'] if evs else '—'}, fired at commit)")


def atomic_rollback():
    rule("The proof it's ONE unit — rollback undoes all models together")

    seq_before = _seq_after_commit  # cursor = right after the committed #1001 event
    txn = _req("POST", "/txn/begin", {"isolation": "read_committed"})
    txn_id = txn.get("txn_id") or txn.get("xid")
    print(f"  BEGIN  → txn {txn_id}")

    sql("INSERT INTO moat_order (id, customer_id, product, amount) "
        "VALUES (1002, 7, 'this should never persist', 999.00)", txn_id)
    sql(f"INSERT INTO moat_embedding (order_id, embedding) VALUES (1002, {VEC})", txn_id)
    _req("POST", "/edges",
         {"from_id": 7, "to_id": 999, "edge_type": "PURCHASED", "props": {"order_id": 1002}},
         txn_id=txn_id)
    print("    wrote relational + vector + graph …")

    _req("POST", f"/txn/{txn_id}/rollback", None)
    print(f"  ROLLBACK → txn {txn_id}")

    n_rows = scalar("SELECT COUNT(*) FROM moat_order WHERE id = 1002")
    n_vec = scalar("SELECT COUNT(*) FROM moat_embedding WHERE order_id = 1002")
    n_edges = len([e for e in edges_from(7) if str(e.get("to_id")) == "999"])
    # No committed event is delivered for the rolled-back write — even though the
    # internal seq high-water advanced when the seq was *allocated*.
    delivered = [e for e in delivered_events(seq_before) if e.get("payload", {}).get("id") == 1002]
    hw = head_seq()

    print("\n  after ROLLBACK — nothing persisted, in ANY model:")
    print(f"    relational  rows for #1002        = {n_rows}")
    print(f"    vector      rows for #1002        = {n_vec}")
    print(f"    graph       edges to node 999     = {n_edges}")
    print(f"    event       delivered to consumer = {len(delivered)}  "
          f"(seq high-water moved to {hw} on allocation, but no committed event exists)")


def main():
    print("\033[1munidb — one transaction, four data models, one commit\033[0m")
    print(f"target: {BASE}")
    try:
        who = _req("GET", "/auth/whoami")
        if who.get("is_superuser") is False:
            print("\n  WARNING: `dev` is not a superuser — /edges and CDC enable may 403.")
            print("  Fix: DEMO_GUIDE.md Step 4b / Troubleshooting.\n")
        setup()
        atomic_write()
        atomic_rollback()
    except (RuntimeError, urllib.error.URLError) as e:
        sys.exit(f"\nFAILED: {e}\n(Is the server up? Is `dev` a superuser? See DEMO_GUIDE.md.)")

    rule("Why this is the moat")
    print("  Postgres + Pinecone + Neo4j + Kafka cannot share a transaction.")
    print("  That same write is 4 network round-trips to 4 systems with NO common")
    print("  commit and NO common rollback — a crash between them leaves the row,")
    print("  the embedding, the edge, and the event permanently out of sync.")
    print("  unidb: one node, one WAL, one commit. All of it, or none of it.\n")


if __name__ == "__main__":
    main()
