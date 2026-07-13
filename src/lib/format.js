// Rendering helpers for cells coming off /sql. Per REST_API.md a JSON column
// arrives as a real nested value (object/array), DECIMAL as a decimal string,
// TIMESTAMP as a UTC string, NULL as JSON null. A VECTOR(n) column arrives as a
// numeric array.

// True for a REST type string like "vector(4)" (see /tables `type` vocabulary).
export function isVectorType(type) {
  return typeof type === 'string' && /^vector\(/i.test(type.trim());
}

// True when a wire value looks like a vector: a non-empty array of numbers.
export function isVectorValue(value) {
  return Array.isArray(value) && value.length > 0 && value.every((n) => typeof n === 'number');
}

// Render one cell for display. VECTOR values (either by declared `type` or by
// value shape when the type is unknown, e.g. the ad-hoc SQL editor) collapse to
// a compact `[0.12, 0.98, …] ·4d` form so a 768-d embedding can't blow out the
// grid. Everything else keeps the prior behavior (JSON stringified, scalars as-is).
export function formatCell(value, type = null) {
  if (value === null || value === undefined) return 'NULL';
  if ((isVectorType(type) || type == null) && isVectorValue(value)) {
    return formatVector(value);
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// Compact vector preview: first `head` dims, an ellipsis if truncated, then the
// dimensionality. Numbers are trimmed to <= 4 significant-ish digits for width.
export function formatVector(value, head = 4) {
  const n = value.length;
  const shown = value.slice(0, head).map(trimNum).join(', ');
  const more = n > head ? ', …' : '';
  return `[${shown}${more}] ·${n}d`;
}

function trimNum(x) {
  if (!Number.isFinite(x)) return String(x);
  if (Number.isInteger(x)) return String(x);
  // Round to 4 decimals, then drop trailing zeros.
  return String(Math.round(x * 1e4) / 1e4);
}

// The full, untruncated text of a cell — used for click-to-copy and tooltips.
export function fullCellText(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function isNull(value) {
  return value === null || value === undefined;
}

// A short "col1 INT, col2 TEXT, …" summary for the sidebar.
export function columnSummary(columns, max = 4) {
  if (!columns?.length) return 'no columns';
  const shown = columns.slice(0, max).map((c) => c.name).join(', ');
  return columns.length > max ? `${shown}, +${columns.length - max} more` : shown;
}

// How to place an edited value into a mutation, by column type. The engine is
// strict about param binding (verified live): it will NOT coerce a string param
// to a numeric column, and a DECIMAL can't be bound as a param at all — it must
// be an inline numeric literal. So this returns either `{ param }` (bind as $n)
// or `{ literal }` (splice into the SQL). Throws on an invalid value so the
// caller can surface a clear message instead of a planner error.
//   - INT/FLOAT/DOUBLE  -> numeric param
//   - BOOL              -> boolean param
//   - VECTOR            -> numeric-array param
//   - JSON              -> parsed nested-value param
//   - DECIMAL/NUMERIC   -> inline numeric literal (param unsupported)
//   - TEXT/UUID/DATE/TIME/TIMESTAMP/BYTEA -> string param (engine coerces)
//   - NULL (isNull)     -> null param
export function bindForColumn(type, raw, isNull = false) {
  if (isNull) return { param: null };
  const t = String(type ?? '').toLowerCase();
  const s = String(raw);

  if (/^(decimal|numeric)/.test(t)) {
    const v = s.trim();
    if (!/^-?\d+(\.\d+)?$/.test(v)) throw new Error(`invalid decimal: "${raw}"`);
    return { literal: v };
  }
  if (/^(int|integer|bigint|smallint)/.test(t)) {
    const n = Number(s);
    if (!Number.isInteger(n)) throw new Error(`invalid integer: "${raw}"`);
    return { param: n };
  }
  if (/^(float|double|real)/.test(t)) {
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error(`invalid number: "${raw}"`);
    return { param: n };
  }
  if (/^bool/.test(t)) {
    const b = s.trim().toLowerCase();
    if (!['true', 'false', 't', 'f', '1', '0'].includes(b)) throw new Error(`invalid bool: "${raw}"`);
    return { param: b === 'true' || b === 't' || b === '1' };
  }
  if (isVectorType(t)) {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr) || !arr.every((x) => typeof x === 'number')) {
      throw new Error('vector must be a JSON array of numbers, e.g. [0.1, 0.2]');
    }
    return { param: arr };
  }
  if (t === 'json') return { param: JSON.parse(s) };

  // text / uuid / date / time / timestamp / bytea — bind as a string param.
  return { param: s };
}

// Interpolate a SQL identifier from introspection into generated queries.
// unidb resolves only BARE identifiers: it keeps the quote characters when
// converting a double-quoted name, so `SELECT * FROM "demo"` looks up a table
// literally named `"demo"` and 404s. Names from introspection are engine-
// created and therefore always plain, so pass those through bare; anything
// unexpected still gets quoted so it can never break out of the query (the
// engine will then reject it honestly rather than us interpolating it raw).
export function quoteIdent(name) {
  const s = String(name);
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}
