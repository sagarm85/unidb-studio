#!/usr/bin/env python3
"""
demo/seed_auth.py — seed demo users, roles, grants, and an RLS policy so the
Auth / Users / Preview / Switch-user scenes have real, differentiated identities
to show (not just the `dev` superuser).

It creates three roles and three password users, each with a *distinct,
demo-visible* authorization footprint over the seeded e-commerce schema:

  analyst      role `analytics`  — SELECT on every table; sees ALL customers.
                                    (the read-only BI user)
  eu_support   role `support`    — SELECT on customers/orders, but an RLS policy
                                    limits customers to Germany (country='DE')
                                    rows only. (row-level security, visibly biting)
  orders_clerk role `ops`        — SELECT/INSERT/UPDATE on orders + order_items
                                    only; NO access to customers or invoices.
                                    (column/table grant scoping)

`dev` (superuser) bypasses all of it, so every other demo scene is unaffected —
the differences only appear once you switch to / preview one of these users.

Auth DDL is not transactional, so each statement is a one-shot request. Safe to
re-run: it drops the objects first (errors on missing objects are ignored).

Usage (server running, e-commerce schema seeded, `dev` a superuser — see
DEMO_GUIDE.md Step 4b):
    python3 demo/seed_auth.py

Passwords are printed at the end so you can use them in Auth → Sign-in flows.
Config: VITE_UNIDB_TOKEN from .env.local (override with env UNIDB_TOKEN);
base URL from env UNIDB_URL (default http://localhost:8080).
"""

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
BASE = os.environ.get("UNIDB_URL", "http://localhost:8080").rstrip("/")

USERS = [
    ("analyst", "Analyst!2345", "analytics"),
    ("eu_support", "Support!2345", "support"),
    ("orders_clerk", "OpsClerk!2345", "ops"),
]
ROLES = ["analytics", "support", "ops"]
POLICIES = [  # (name, table)
    ("cust_analytics_all", "customers"),
    ("cust_support_de", "customers"),
    ("ord_ops_pending", "orders"),
]


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


def _post(path, body):
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read())
        except Exception:
            return {"error": f"HTTP {e.code}"}


def ddl(stmt, *, tolerate=False):
    """Run one auth-DDL / SQL statement (one-shot). Prints OK / ERR."""
    resp = _post("/sql", {"sql": stmt})
    err = resp.get("error") or (resp.get("results") or [{}])[0].get("error")
    short = stmt if len(stmt) <= 66 else stmt[:63] + "..."
    if err:
        if tolerate:
            print(f"  ~  {short}")  # expected on a clean DB (drop of a missing object)
            return False
        print(f"  ERR {short}\n        {err}", file=sys.stderr)
        return False
    print(f"  ok  {short}")
    return True


def preview(as_role, sql):
    resp = _post("/auth/preview", {"as_role": as_role, "sql": sql})
    err = resp.get("error") or (resp.get("results") or [{}])[0].get("error")
    if err:
        return f"BLOCKED: {err}"
    # /auth/preview returns an unwrapped single result {columns, rows, type},
    # not the /sql {results:[...]} envelope.
    block = resp if "rows" in resp else (resp.get("results") or [{}])[0]
    rows = block.get("rows") or [[None]]
    return rows[0][0] if len(rows) == 1 and len(rows[0]) == 1 else f"{len(rows)} rows"


def rule(title):
    print(f"\n\033[1m── {title} " + "─" * max(0, 60 - len(title)) + "\033[0m")


def main():
    print("\033[1mseeding demo identities: analyst · eu_support · orders_clerk\033[0m")

    rule("Clean slate (ignore 'not found')")
    for name, table in POLICIES:
        ddl(f"DROP POLICY {name} ON {table}", tolerate=True)
    for uname, _, _ in USERS:
        ddl(f"DROP USER {uname}", tolerate=True)
    for role in ROLES:
        ddl(f"DROP ROLE {role}", tolerate=True)

    rule("Roles + table grants")
    ddl("CREATE ROLE analytics")
    ddl("GRANT SELECT ON customers TO analytics")
    ddl("GRANT SELECT ON products TO analytics")
    ddl("GRANT SELECT ON orders TO analytics")
    ddl("GRANT SELECT ON order_items TO analytics")
    ddl("GRANT SELECT ON invoices TO analytics")
    ddl("GRANT SELECT ON invoice_items TO analytics")

    ddl("CREATE ROLE support")
    ddl("GRANT SELECT ON customers TO support")
    ddl("GRANT SELECT ON orders TO support")

    ddl("CREATE ROLE ops")
    ddl("GRANT SELECT ON orders TO ops")
    ddl("GRANT INSERT ON orders TO ops")
    ddl("GRANT UPDATE ON orders TO ops")
    ddl("GRANT SELECT ON order_items TO ops")
    ddl("GRANT INSERT ON order_items TO ops")
    ddl("GRANT UPDATE ON order_items TO ops")

    rule("RLS policy on customers (row-level, per role)")
    # analytics: see everything (explicit allow so RLS doesn't hide rows from them)
    ddl("CREATE POLICY cust_analytics_all ON customers FOR SELECT TO analytics USING (true)")
    # support: Germany only — the policy that visibly bites in Preview / Switch-user.
    # (unidb RLS predicates are a single AND-only comparison; IN/OR aren't
    # supported, so this is one country, not a set.)
    ddl("CREATE POLICY cust_support_de ON customers FOR SELECT TO support "
        "USING (country = 'DE')")
    # ops: write-side RLS — may only UPDATE orders that are still 'pending'
    # (a WITH CHECK-style demo of row-level security on writes, not just reads).
    ddl("CREATE POLICY ord_ops_pending ON orders FOR UPDATE TO ops "
        "USING (status = 'pending')")

    rule("Users (password) + role membership")
    for uname, pw, role in USERS:
        ddl(f"CREATE USER {uname} PASSWORD '{pw}'")
        ddl(f"GRANT {role} TO {uname}")

    rule("Verify with POST /auth/preview (what each user actually sees)")
    total = preview("dev", "SELECT COUNT(*) FROM customers")
    print(f"  dev (superuser)   customers visible = {total}   (bypasses RLS)")
    print(f"  analyst           customers visible = {preview('analyst', 'SELECT COUNT(*) FROM customers')}   (policy: all)")
    print(f"  eu_support        customers visible = {preview('eu_support', 'SELECT COUNT(*) FROM customers')}   (policy: DE only)")
    print(f"  orders_clerk      customers visible = {preview('orders_clerk', 'SELECT COUNT(*) FROM customers')}   (no grant)")
    print(f"  orders_clerk      orders visible    = {preview('orders_clerk', 'SELECT COUNT(*) FROM orders')}   (granted)")

    rule("Demo identities ready")
    for uname, pw, role in USERS:
        print(f"  {uname:<13} / {pw:<14} (role {role})")
    print("\n  Switch to one in the Studio header (Switch user), or drive the real")
    print("  password/MFA/OAuth/magic-link flows in Auth → Sign-in flows.")


if __name__ == "__main__":
    main()
