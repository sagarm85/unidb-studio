"""
demo/pg.py — Postgres helper for the unidb comparison demo.

Provides a thin connection + query layer that works with either psycopg2 or
psycopg (v3) if installed. Import from other demo scripts.
"""

import json, time, sys

# ── Driver detection ─────────────────────────────────────────────────────────
_pg = None

def _load_driver():
    global _pg
    for name in ("psycopg2", "psycopg"):
        try:
            _pg = __import__(name)
            return True
        except ImportError:
            continue
    return False

_load_driver()


def available():
    return _pg is not None


def require():
    if not available():
        print(
            "\n  psycopg2 (or psycopg) is required for Postgres comparison.\n"
            "  Install with:  pip3 install psycopg2-binary\n",
            file=sys.stderr,
        )
        sys.exit(1)


def connect(dsn):
    """Return a live Postgres connection. Caller must close it."""
    return _pg.connect(dsn)


def run(conn, sql, commit=False):
    """Execute SQL, optionally commit, return (elapsed_ms, rows)."""
    cur = conn.cursor()
    t0  = time.perf_counter()
    cur.execute(sql)
    if commit:
        conn.commit()
    ms = (time.perf_counter() - t0) * 1000
    try:
        rows = cur.fetchall()
    except Exception:
        rows = []
    cur.close()
    return round(ms, 2), rows


def run_ddl(conn, label, sql):
    conn.autocommit = True
    cur = conn.cursor()
    try:
        cur.execute(sql)
        print(f"  OK   {label}")
    except Exception as e:
        print(f"  ERR  {label}: {e}")
    finally:
        cur.close()
    conn.autocommit = False


def escape(v):
    if v is None:                   return "NULL"
    if isinstance(v, bool):         return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)): return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def bulk_insert(conn, table, cols, rows, batch=200):
    col_clause = ",".join(cols)
    errs = 0
    cur  = conn.cursor()
    for i in range(0, len(rows), batch):
        chunk = rows[i:i+batch]
        vals  = ",".join(
            "(" + ",".join(escape(v) for v in row) + ")" for row in chunk
        )
        try:
            cur.execute(f"INSERT INTO {table} ({col_clause}) VALUES {vals}")
        except Exception as e:
            errs += 1
            if errs <= 3:
                print(f"    ! pg insert error {table}: {e}", file=sys.stderr)
    conn.commit()
    cur.close()
    return errs
