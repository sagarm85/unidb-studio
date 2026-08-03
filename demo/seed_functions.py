#!/usr/bin/env python3
"""Register a handful of demo stored functions (engine item 147) so the Studio
Functions panel and the RPC route have something real to show. Superuser-only:
POST /functions upserts by name. Each function is a parameterized list of SQL
statements the engine runs in ONE transaction; the LAST statement's rows are
what POST /rest/v1/rpc/{name} returns.

Run after the e-commerce schema is seeded (setup_schema.py + a seed loader)."""
import json
import sys
import urllib.request
import urllib.error

BASE = "http://localhost:8080"
TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZXYiLCJleHAiOjE4MTU1NDYzMzV9.8I1BTxTJgJLVd-uHt80AiS3ufAEr6MhjeA5POFwWbEI"
HDRS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

# name -> {params, body, run_as?}
FUNCTIONS = [
    {
        "name": "orders_by_status",
        "params": ["status"],
        "body": [
            "SELECT id, customer_id, total_amount, status, created_at "
            "FROM orders WHERE status = $1 ORDER BY created_at DESC LIMIT 20"
        ],
    },
    {
        "name": "revenue_by_status",
        "params": [],
        "body": [
            "SELECT status, COUNT(*) AS orders, SUM(total_amount) AS revenue "
            "FROM orders GROUP BY status ORDER BY revenue DESC"
        ],
    },
    {
        "name": "customer_orders",
        "params": ["customer_id"],
        "body": [
            "SELECT o.id, o.status, o.total_amount, o.created_at "
            "FROM orders o WHERE o.customer_id = $1 ORDER BY o.created_at DESC LIMIT 20"
        ],
    },
    {
        # Multi-statement: mutate then read, atomically in one transaction.
        # The LAST statement's rows are what RPC returns.
        "name": "mark_order_paid",
        "params": ["order_id"],
        "body": [
            "UPDATE orders SET status = 'paid' WHERE id = $1",
            "SELECT id, status, total_amount FROM orders WHERE id = $1",
        ],
    },
]


def upsert(fn):
    req = urllib.request.Request(f"{BASE}/functions", data=json.dumps(fn).encode(),
                                 headers=HDRS, method="POST")
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        print(f"  ! {fn['name']}: HTTP {e.code} {body}", file=sys.stderr)
        return e.code


def main():
    print("── Registering demo stored functions (item 147) ─────────────────────")
    ok = 0
    for fn in FUNCTIONS:
        status = upsert(fn)
        if status in (200, 201, 204):
            ok += 1
            args = ", ".join(fn["params"]) or "no args"
            print(f"  ✓ {fn['name']}({args})  — {len(fn['body'])} stmt(s)")
    print(f"\n✓ {ok}/{len(FUNCTIONS)} functions registered.")
    print("  Call one:  curl -s -X POST "
          f"{BASE}/rest/v1/rpc/revenue_by_status -H 'Authorization: Bearer <jwt>' -d '{{}}'")
    print("  Or open the Studio → API → Functions tab and hit ▶ Call.")


if __name__ == "__main__":
    main()
