// Schema-graph helpers for the visualizer. Keeps derivation/layout logic out of
// the component and out of api.js (which is strictly the wire contract).
//
// The engine's `/schema` route is not built yet (see api.getSchema). Until it
// is, we synthesize a usable graph from the plain `/tables` catalog:
//   - primary keys  <- an explicit `primaryKey` flag if present, else a column
//                       named "id", else the first indexed column.
//   - relationships <- HEURISTIC: a column like `user_id` / `userId` pointing at
//                       a table `user`/`users` is treated as a foreign key to
//                       that table's PK. This is a guess, flagged `inferred`, and
//                       the real endpoint should replace it with true FK metadata.

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
  ],
  relationships: [
    { name: 'orders_customer_id_fkey', fromTable: 'orders', fromColumns: ['customer_id'], toTable: 'customers', toColumns: ['id'] },
    { name: 'order_items_order_id_fkey', fromTable: 'order_items', fromColumns: ['order_id'], toTable: 'orders', toColumns: ['id'] },
    { name: 'order_items_product_id_fkey', fromTable: 'order_items', fromColumns: ['product_id'], toTable: 'products', toColumns: ['id'] },
  ],
};

// Reconstruct a CREATE TABLE statement from introspected metadata. This is a
// best-effort rebuild (types/nullability/PK/secondary indexes) — NOT the
// engine's stored DDL. When `/schema` starts returning an authoritative `ddl`
// string per table, prefer that; this stays as the fallback.
export function tableDDL(table) {
  const cols = table.columns ?? [];
  const pk = Array.isArray(table.primaryKey) && table.primaryKey.length
    ? table.primaryKey
    : (primaryKeyOf(table) ? [primaryKeyOf(table)] : []);

  const lines = cols.map((c) => {
    let line = `  ${c.name} ${c.type ?? ''}`.trimEnd();
    if (c.nullable === false) line += ' NOT NULL';
    return line;
  });
  if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(', ')})`);

  let ddl = `CREATE TABLE ${table.name} (\n${lines.join(',\n')}\n);`;

  // Secondary indexes: indexed columns that aren't (part of) the primary key.
  for (const c of cols) {
    if (c.index && !pk.includes(c.name)) {
      ddl += `\nCREATE INDEX idx_${table.name}_${c.name} ON ${table.name} (${c.name});`;
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
