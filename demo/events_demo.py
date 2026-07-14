#!/usr/bin/env python3
"""
demo/events_demo.py — real-time CDC event demo.

Shows that every INSERT / UPDATE / DELETE on an events-enabled table
immediately appears on the  GET /events/subscribe  SSE stream — the same
stream the Studio  Events  tab subscribes to.

Usage (run in a separate terminal while Studio is open on the Events tab):

    python3 demo/events_demo.py

Steps it performs:
  1. Enables CDC on the 'orders' table  (POST /tables/orders/events)
  2. Opens the SSE stream in the background
  3. Inserts 3 new orders, updates their status, then deletes one
  4. Prints each event as it arrives (typically < 5 ms after the write)

Prerequisite: server running and schema seeded
  python3 demo/setup_schema.py
  python3 demo/seed.py --size 10k
"""

import json, sys, time, threading, urllib.request, urllib.error
from datetime import datetime
try:
    import sseclient  # pip install sseclient-py  (optional — graceful fallback)
    HAS_SSE = True
except ImportError:
    HAS_SSE = False

BASE  = "http://localhost:8080"
TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZXYiLCJleHAiOjE4MTU1NDYzMzV9.8I1BTxTJgJLVd-uHt80AiS3ufAEr6MhjeA5POFwWbEI"
HDRS  = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}


def sql(q, label=""):
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
    if err:
        print(f"  SQL ERR {label}: {err}", file=sys.stderr)
    elif label:
        rows = (body.get("results") or [{}])[0].get("rows", [])
        print(f"  SQL OK  {label}" + (f" → {rows[0][0]}" if len(rows)==1 and len(rows[0])==1 else f" ({len(rows)} rows)"))
    return body


def enable_events(table):
    req = urllib.request.Request(
        f"{BASE}/tables/{table}/events",
        data=b"",
        headers={k: v for k, v in HDRS.items() if k != "Content-Type"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10):
            pass
        print(f"  CDC enabled on '{table}'")
    except urllib.error.HTTPError as e:
        body = json.loads(e.read())
        msg  = body.get("error", str(e))
        if "already" in msg.lower():
            print(f"  CDC already enabled on '{table}'")
        else:
            print(f"  ERR enabling events: {msg}", file=sys.stderr)


CONSUMER = "demo-py"

# ── SSE listener (background thread) ─────────────────────────────────────────
events_seen = []
_stop       = threading.Event()
_from_seq   = 0   # set by main() before starting the thread


def _commit_offset(seq):
    """Persist consumer offset to __consumers__ so Studio shows it live."""
    q = (f"INSERT INTO __consumers__ (consumer_name, offset) VALUES ('{CONSUMER}', {seq}) "
         f"ON CONFLICT (consumer_name) DO UPDATE SET offset = {seq}")
    sql(q)


def get_current_seq():
    """Peek at the SSE stream briefly to find the highest committed seq."""
    url = f"{BASE}/events/subscribe?table=orders"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "text/event-stream",
        "Cache-Control": "no-cache",
    })
    last_seq = 0
    try:
        with urllib.request.urlopen(req, timeout=1) as resp:
            buf = []
            for raw in resp:
                line = raw.decode("utf-8", errors="replace").rstrip("\n\r")
                if line.startswith("data:"):
                    buf.append(line[5:].strip())
                elif line == "" and buf:
                    try:
                        evt = json.loads(" ".join(buf))
                        if evt.get("seq"):
                            last_seq = evt["seq"]
                    except json.JSONDecodeError:
                        pass
                    buf = []
    except Exception:
        pass  # timeout is expected
    return last_seq


def _sse_listener():
    """Reads only events after _from_seq and updates __consumers__ live."""
    url = f"{BASE}/events/subscribe?table=orders&from_seq={_from_seq}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "text/event-stream",
        "Cache-Control": "no-cache",
    })
    try:
        with urllib.request.urlopen(req, timeout=None) as resp:
            data_buf = []
            for raw in resp:
                if _stop.is_set():
                    break
                line = raw.decode("utf-8", errors="replace").rstrip("\n\r")
                if line.startswith("data:"):
                    data_buf.append(line[5:].strip())
                elif line == "" and data_buf:
                    payload = " ".join(data_buf)
                    data_buf = []
                    try:
                        evt = json.loads(payload)
                        events_seen.append(evt)
                        op  = evt.get("operation", "?").upper()
                        seq = evt.get("seq", "?")
                        tbl = evt.get("table", "?")
                        new = evt.get("new") or {}
                        old = evt.get("old") or {}
                        if op == "INSERT":
                            print(f"\n  ► EVENT [{seq}] INSERT on {tbl}  id={new.get('id')}  status={new.get('status')}")
                        elif op == "UPDATE":
                            print(f"\n  ► EVENT [{seq}] UPDATE on {tbl}  id={new.get('id')}  "
                                  f"{old.get('status')} → {new.get('status')}")
                        elif op == "DELETE":
                            print(f"\n  ► EVENT [{seq}] DELETE on {tbl}  id={old.get('id')}")
                        # Update committed offset after every event
                        if isinstance(seq, int):
                            _commit_offset(seq)
                    except json.JSONDecodeError:
                        pass
    except Exception as e:
        if not _stop.is_set():
            print(f"\n  SSE stream error: {e}", file=sys.stderr)


# ── Main demo flow ─────────────────────────────────────────────────────────────
def main():
    print("\n══ Events Demo ═══════════════════════════════════════════════════════")
    print("  Demonstrates real-time CDC: Studio Events tab updates the moment")
    print("  a transaction commits.\n")

    # Step 1: enable CDC
    enable_events("orders")

    # Step 2: snapshot current seq so we only see new events (no replay)
    print("\n  Snapshotting current event position…")
    global _from_seq
    _from_seq = get_current_seq()
    print(f"  Starting from seq {_from_seq}")
    _commit_offset(_from_seq)   # register consumer in __consumers__ now

    # Step 3: start SSE listener in background
    print("  Starting SSE stream (listening for orders events)…")
    t = threading.Thread(target=_sse_listener, daemon=True)
    t.start()
    time.sleep(0.5)   # let the connection establish

    # Step 4: find the highest existing order id
    res  = sql("SELECT MAX(id) FROM orders", "max order id")
    rows = (res.get("results") or [{}])[0].get("rows", [[0]])
    base_id = (rows[0][0] or 0) + 1

    print(f"\n  Will INSERT orders {base_id}, {base_id+1}, {base_id+2}  — watch Events tab!\n")
    time.sleep(0.3)

    # Step 5: INSERT 3 orders — each fires an event
    now_ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    for i in range(3):
        oid = base_id + i
        sql(f"""INSERT INTO orders (id, customer_id, status, total_amount, created_at)
                VALUES ({oid}, 1, 'pending', {(i+1)*49.99:.2f}, '{now_ts}')""",
            f"INSERT order {oid}")
        time.sleep(0.4)

    # Step 6: UPDATE status — fires UPDATE events
    print()
    for i in range(3):
        oid = base_id + i
        sql(f"UPDATE orders SET status = 'confirmed' WHERE id = {oid}",
            f"UPDATE order {oid} → confirmed")
        time.sleep(0.4)

    # Step 7: DELETE one
    print()
    sql(f"DELETE FROM orders WHERE id = {base_id+2}", f"DELETE order {base_id+2}")
    time.sleep(0.5)

    _stop.set()

    print(f"\n  ✓  {len(events_seen)} events received on the SSE stream.")

    # Show committed consumer offset (same value Studio displays)
    res  = sql(f"SELECT offset FROM __consumers__ WHERE consumer_name = '{CONSUMER}'")
    rows = (res.get("results") or [{}])[0].get("rows", [])
    if rows:
        print(f"  Consumer '{CONSUMER}' committed offset: seq {rows[0][0]}")

    print("  Open Studio → Events tab — the consumer offset bar updates live.\n")


if __name__ == "__main__":
    main()
