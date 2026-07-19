// Schema-graph helpers for the visualizer. Keeps derivation/layout logic out of
// the component and out of api.js (which is strictly the wire contract).
//
// Preferred source is the engine's Milestone-18 system catalog: `getSchema()`
// SELECTs `information_schema.*` / `unidb_catalog.*` and `buildCatalogSchema()`
// (below) assembles REAL primary/foreign keys from it. There is NO `/schema`
// route — the engine ships a queryable catalog, not app-shaped REST.
//
// The heuristics below are the FALLBACK for a pre-M18 server that lacks the
// catalog, synthesizing a usable graph from the plain `/tables` list:
//   - primary keys  <- an explicit `primaryKey` flag if present, else a column
//                       named "id", else the first indexed column.
//   - relationships <- HEURISTIC: a column like `user_id` / `userId` pointing at
//                       a table `user`/`users` is treated as a foreign key to
//                       that table's PK. A guess, flagged `inferred`; real FK
//                       metadata from the catalog replaces it when available.

// Detect the primary-key column name for a table from whatever hints exist.
export function primaryKeyOf(table) {
  const cols = table.columns ?? [];
  if (Array.isArray(table.primaryKey) && table.primaryKey.length) return table.primaryKey[0];
  const explicit = cols.find((c) => c.primaryKey);
  if (explicit) return explicit.name;
  const id = cols.find((c) => c.name.toLowerCase() === 'id');
  if (id) return id.name;
  const indexed = cols.find((c) => c.index);
  return indexed ? indexed.name : null;
}

// Candidate target-table names for a base extracted from a FK-looking column,
// e.g. "user" -> ["user", "users", "useres"] (naive singular/plural).
function targetCandidates(base) {
  const b = base.toLowerCase();
  return [b, `${b}s`, `${b}es`, b.replace(/y$/, 'ies')];
}

// Infer FK relationships across a set of tables by column-name convention.
export function inferRelationships(tables) {
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  const rels = [];

  for (const t of tables) {
    for (const c of t.columns ?? []) {
      const m = c.name.match(/^(.*?)[_]?(id)$/i);
      if (!m || !m[1]) continue; // needs a non-empty base before "id"
      const base = m[1];
      let target = null;
      for (const cand of targetCandidates(base)) {
        if (byName.has(cand) && cand !== t.name.toLowerCase()) {
          target = byName.get(cand);
          break;
        }
      }
      if (!target) continue;
      const targetPk = primaryKeyOf(target);
      if (!targetPk) continue;
      rels.push({
        name: `${t.name}_${c.name}_fkey`,
        fromTable: t.name,
        fromColumns: [c.name],
        toTable: target.name,
        toColumns: [targetPk],
        inferred: true,
      });
    }
  }
  return rels;
}

// Assemble a schema graph from the engine's REAL system catalog
// (Milestone 18). Inputs are the row-objects returned by SELECTing over
//   information_schema.columns              -> colRows
//   unidb_catalog.indexes                   -> idxRows
//   information_schema.{table_constraints,   -> pkRows  (PRIMARY KEY columns)
//                       key_column_usage}
//   the 4-way FK join in the access guide    -> fkRows
// Produces the same { tables, relationships } shape the visualizer consumes,
// but with REAL primary/foreign keys — no name-heuristic guessing. Pure and
// order-independent so it can be unit-tested off fixture rows.
export function buildCatalogSchema(colRows = [], idxRows = [], pkRows = [], fkRows = []) {
  const num = (x) => Number(x ?? 0);

  // (table.column) -> index kind (btree/hnsw/fulltext/csr).
  const indexByCol = new Map();
  for (const r of idxRows) indexByCol.set(`${r.table_name}.${r.column_name}`, r.index_type);

  // table -> ordered primary-key column names.
  const pkByTable = new Map();
  for (const r of pkRows) {
    const arr = pkByTable.get(r.table_name) ?? [];
    arr.push({ col: r.column_name, pos: num(r.ordinal_position) });
    pkByTable.set(r.table_name, arr);
  }
  for (const [k, arr] of pkByTable) {
    pkByTable.set(k, arr.sort((a, b) => a.pos - b.pos).map((x) => x.col));
  }

  // Group columns into tables, ordered by ordinal_position.
  const sorted = [...colRows].sort(
    (a, b) =>
      String(a.table_name).localeCompare(String(b.table_name)) ||
      num(a.ordinal_position) - num(b.ordinal_position),
  );
  const tableMap = new Map();
  for (const r of sorted) {
    let t = tableMap.get(r.table_name);
    if (!t) {
      t = { name: r.table_name, primaryKey: pkByTable.get(r.table_name) ?? [], columns: [] };
      tableMap.set(r.table_name, t);
    }
    t.columns.push({
      name: r.column_name,
      type: r.data_type,
      // is_nullable is 'YES'/'NO'; a PRIMARY KEY column is NOT NULL.
      nullable: r.is_nullable !== 'NO',
      index: indexByCol.get(`${r.table_name}.${r.column_name}`) ?? null,
      primaryKey: t.primaryKey.includes(r.column_name),
      default: r.column_default ?? null,
    });
  }
  const tables = [...tableMap.values()];

  // Group FK rows by constraint into one relationship per key (composite-aware).
  const relMap = new Map();
  for (const r of fkRows) {
    let rel = relMap.get(r.constraint_name);
    if (!rel) {
      rel = { name: r.constraint_name, fromTable: r.from_table, toTable: r.to_table, cols: [] };
      relMap.set(r.constraint_name, rel);
    }
    rel.cols.push({ from: r.from_col, to: r.to_col, pos: num(r.from_pos) });
  }
  const relationships = [...relMap.values()].map((rel) => {
    const cols = rel.cols.sort((a, b) => a.pos - b.pos);
    return {
      name: rel.name,
      fromTable: rel.fromTable,
      fromColumns: cols.map((c) => c.from),
      toTable: rel.toTable,
      toColumns: cols.map((c) => c.to),
      inferred: false,
    };
  });

  return { tables, relationships };
}

// Small illustrative schema shown when the server exposes no tables at all, so
// the visualizer is never blank. Clearly marked demo data in the UI.
export const DEMO_SCHEMA = {
  demo: true,
  tables: [
    {
      name: 'customers',
      primaryKey: ['id'],
      columns: [
        { name: 'id', type: 'INT', nullable: false, index: true, primaryKey: true },
        { name: 'email', type: 'TEXT', nullable: false, index: true },
        { name: 'name', type: 'TEXT', nullable: true },
        { name: 'created_at', type: 'TIMESTAMP', nullable: false },
      ],
    },
    {
      name: 'orders',
      primaryKey: ['id'],
      columns: [
        { name: 'id', type: 'INT', nullable: false, index: true, primaryKey: true },
        { name: 'customer_id', type: 'INT', nullable: false, index: true },
        { name: 'total', type: 'DECIMAL', nullable: false },
        { name: 'status', type: 'TEXT', nullable: false },
        { name: 'created_at', type: 'TIMESTAMP', nullable: false },
      ],
    },
    {
      name: 'order_items',
      primaryKey: ['id'],
      columns: [
        { name: 'id', type: 'INT', nullable: false, index: true, primaryKey: true },
        { name: 'order_id', type: 'INT', nullable: false, index: true },
        { name: 'product_id', type: 'INT', nullable: false, index: true },
        { name: 'quantity', type: 'INT', nullable: false },
      ],
    },
    {
      name: 'products',
      primaryKey: ['id'],
      columns: [
        { name: 'id', type: 'INT', nullable: false, index: true, primaryKey: true },
        { name: 'name', type: 'TEXT', nullable: false },
        { name: 'price', type: 'DECIMAL', nullable: false },
      ],
    },
    {
      name: 'documents',
      primaryKey: ['id'],
      columns: [
        { name: 'id', type: 'INT', nullable: false, index: true, primaryKey: true },
        { name: 'product_id', type: 'INT', nullable: false, index: true },
        { name: 'title', type: 'TEXT', nullable: false },
        // A vector column with the durable ANN (hnsw) index — drives the
        // VEC/ANN badges and the `USING HNSW` DDL in demo mode.
        { name: 'embedding', type: 'vector(4)', nullable: true, index: 'hnsw' },
      ],
    },
  ],
  relationships: [
    { name: 'orders_customer_id_fkey', fromTable: 'orders', fromColumns: ['customer_id'], toTable: 'customers', toColumns: ['id'] },
    { name: 'order_items_order_id_fkey', fromTable: 'order_items', fromColumns: ['order_id'], toTable: 'orders', toColumns: ['id'] },
    { name: 'order_items_product_id_fkey', fromTable: 'order_items', fromColumns: ['product_id'], toTable: 'products', toColumns: ['id'] },
    { name: 'documents_product_id_fkey', fromTable: 'documents', fromColumns: ['product_id'], toTable: 'products', toColumns: ['id'] },
  ],
};

// TODO(engine-item-tbd): replace this reconstruction with a query for object_ddl once
//   the engine stores original CREATE TABLE text in information_schema.tables or
//   unidb_catalog.ddl. The reconstructed DDL below is lossy (original constraint
//   names and CHECK expressions are not preserved).
// Reconstruct a CREATE TABLE statement from introspected metadata
// (types/nullability/PK/secondary indexes). The engine retains no original
// CREATE text and exposes no object_ddl, so this client-side rebuild is the
// only source of DDL — canonical, not byte-identical.
export function tableDDL(table) {
  const cols = table.columns ?? [];
  const pk = Array.isArray(table.primaryKey) && table.primaryKey.length
    ? table.primaryKey
    : (primaryKeyOf(table) ? [primaryKeyOf(table)] : []);

  const lines = cols.map((c) => {
    // Uppercase the type token for DDL convention: vector(4) -> VECTOR(4).
    let line = `  ${c.name} ${(c.type ?? '').toUpperCase()}`.trimEnd();
    if (c.nullable === false) line += ' NOT NULL';
    return line;
  });
  if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(', ')})`);

  let ddl = `CREATE TABLE ${table.name} (\n${lines.join(',\n')}\n);`;

  // Secondary indexes: indexed columns that aren't (part of) the primary key.
  // A vector column's ANN index needs the `USING HNSW` access-method clause.
  for (const c of cols) {
    if (c.index && !pk.includes(c.name)) {
      const using = c.index === 'hnsw' ? ' USING HNSW' : '';
      ddl += `\nCREATE INDEX idx_${table.name}_${c.name} ON ${table.name}${using} (${c.name});`;
    }
  }
  return ddl;
}

// Node geometry — must match SchemaVisualizer.svelte's CSS so column-level edge
// anchors line up with the rendered rows.
export const NODE_WIDTH = 220;
export const HEADER_HEIGHT = 34;
export const ROW_HEIGHT = 26;

export function nodeHeight(table) {
  return HEADER_HEIGHT + (table.columns?.length ?? 0) * ROW_HEIGHT;
}

// Initial grid layout. Columns wrap after `perRow`, spacing leaves room for the
// tallest node in each row. Positions are the caller's to mutate on drag.
export function gridLayout(tables, perRow = 3, gapX = 80, gapY = 60) {
  const pos = {};
  let x = 40;
  let y = 40;
  let rowMaxH = 0;
  tables.forEach((t, i) => {
    if (i > 0 && i % perRow === 0) {
      x = 40;
      y += rowMaxH + gapY;
      rowMaxH = 0;
    }
    pos[t.name] = { x, y };
    x += NODE_WIDTH + gapX;
    rowMaxH = Math.max(rowMaxH, nodeHeight(t));
  });
  return pos;
}

// The vertical center of a given column's row within a node (local coords).
export function columnAnchorY(table, colName) {
  const idx = (table.columns ?? []).findIndex((c) => c.name === colName);
  if (idx < 0) return HEADER_HEIGHT / 2; // fall back to the header
  return HEADER_HEIGHT + idx * ROW_HEIGHT + ROW_HEIGHT / 2;
}
