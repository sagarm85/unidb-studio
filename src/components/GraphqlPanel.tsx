import { useEffect, useMemo, useState } from 'react';
import { Network, Play } from 'lucide-react';
import { getGraphqlSchema, graphqlRequest } from '@/lib/engine/api.js';
import { Badge } from './ui/badge';
import { Textarea } from './ui/textarea';
import { PanelHelp } from './PanelHelp';
import { cn } from '@/lib/utils';

// GraphQL panel (item 130 C4, mutations item 133) — a schema browser over a
// standard introspection query against POST /graphql (schema-derived, read +
// write), starter queries/mutations built from the real schema, and a query
// editor that runs real queries and renders the real {data, errors} envelope.

interface GqlField {
  name: string;
  description: string | null;
  args: { name: string; type: any; defaultValue: string | null }[];
  type: any;
}
interface GqlType {
  kind: string;
  name: string;
  description: string | null;
  fields: GqlField[] | null;
  enumValues: { name: string }[] | null;
}
interface GqlSchema {
  queryType: { name: string } | null;
  mutationType: { name: string } | null;
  types: GqlType[];
}

function unwrap(t: any): { named: any; isList: boolean; nonNull: boolean } {
  let cur = t;
  let isList = false;
  let nonNull = false;
  while (cur) {
    if (cur.kind === 'NON_NULL') {
      nonNull = true;
      cur = cur.ofType;
    } else if (cur.kind === 'LIST') {
      isList = true;
      cur = cur.ofType;
    } else break;
  }
  return { named: cur, isList, nonNull };
}
function typeLabel(t: any): string {
  if (!t) return '';
  if (t.kind === 'NON_NULL') return `${typeLabel(t.ofType)}!`;
  if (t.kind === 'LIST') return `[${typeLabel(t.ofType)}]`;
  return t.name ?? '';
}
function placeholderFor(t: any): string | number | boolean {
  const { named } = unwrap(t);
  if (named?.name === 'Int') return 1;
  if (named?.name === 'Float') return 1.5;
  if (named?.name === 'Boolean') return true;
  return 'value';
}
function isScalarish(t: any): boolean {
  const { named } = unwrap(t);
  return named?.kind === 'SCALAR' || named?.kind === 'ENUM';
}

export function GraphqlPanel() {
  const [supported, setSupported] = useState(true);
  const [schema, setSchema] = useState<GqlSchema | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedField, setSelectedField] = useState<GqlField | null>(null);
  const [query, setQuery] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ data: any; errors: any } | null>(null);

  useEffect(() => {
    getGraphqlSchema()
      .then((out) => {
        setSupported(out.supported);
        setSchema(out.schema as GqlSchema);
      })
      .catch((e: any) => setLoadError(e?.message ?? String(e)))
      .finally(() => setLoading(false));
  }, []);

  const queryType = useMemo(() => schema?.types.find((t) => t.name === schema.queryType?.name) ?? null, [schema]);
  const mutationType = useMemo(() => (schema?.mutationType ? schema.types.find((t) => t.name === schema.mutationType!.name) ?? null : null), [schema]);
  const objectTypes = useMemo(() => (schema ? schema.types.filter((t) => t.kind === 'OBJECT' && !t.name.startsWith('__')) : []), [schema]);

  const insertFields = mutationType?.fields?.filter((f) => f.name.startsWith('insert_')) ?? [];
  const updateFields = mutationType?.fields?.filter((f) => f.name.startsWith('update_')) ?? [];
  const deleteFields = mutationType?.fields?.filter((f) => f.name.startsWith('delete_')) ?? [];

  function tableTypeForField(f: GqlField): GqlType | null {
    const { named } = unwrap(f.type);
    return objectTypes.find((t) => t.name === named?.name) ?? null;
  }
  function tableTypeForMutation(fieldName: string, prefix: string): GqlType | null {
    const table = fieldName.slice(prefix.length);
    return objectTypes.find((t) => t.name.toLowerCase() === table.toLowerCase() || t.name.toLowerCase() === `${table.toLowerCase()}s`) ?? null;
  }

  function starterForQueryField(f: GqlField) {
    const t = tableTypeForField(f);
    const scalarFields = (t?.fields ?? []).filter((ff) => isScalarish(ff.type)).slice(0, 5);
    const cols = scalarFields.length ? scalarFields.map((ff) => `    ${ff.name}`).join('\n') : '    __typename';
    // Scaffold an example filter/order/limit clause, but only from args the
    // field actually exposes (engine-truthful — never invent an argument).
    const argNames = new Set(f.args.map((a) => a.name));
    const parts: string[] = [];
    // Bare column name = equality (the /rest/v1-parity filter matrix). Use the
    // first scalar column that's also a filter arg, with a placeholder value.
    const eqCol = scalarFields.find((ff) => argNames.has(ff.name));
    if (eqCol) {
      const v = placeholderFor(eqCol.type);
      parts.push(`${eqCol.name}: ${typeof v === 'string' ? `"${v}"` : v}`);
    }
    if (argNames.has('orderBy') && scalarFields[0]) parts.push(`orderBy: "${scalarFields[0].name}"`);
    if (argNames.has('limit')) parts.push('limit: 5');
    const argClause = parts.length ? `(${parts.join(', ')})` : '';
    setQuery(`query {\n  ${f.name}${argClause} {\n${cols}\n  }\n}`);
  }
  function starterForInsert(f: GqlField) {
    const t = tableTypeForMutation(f.name, 'insert_');
    const scalarFields = (t?.fields ?? []).filter((ff) => isScalarish(ff.type)).slice(0, 5);
    const values = scalarFields
      .map((ff) => {
        const v = placeholderFor(ff.type);
        return `${ff.name}: ${typeof v === 'string' ? `"${v}"` : v}`;
      })
      .join(', ');
    const returnCols = scalarFields.map((ff) => `    ${ff.name}`).join('\n') || '    __typename';
    setQuery(`mutation {\n  ${f.name}(values: { ${values} }) {\n${returnCols}\n  }\n}`);
  }
  function starterForUpdateOrDelete(f: GqlField, prefix: 'update_' | 'delete_') {
    const t = tableTypeForMutation(f.name, prefix);
    const scalarFields = (t?.fields ?? []).filter((ff) => isScalarish(ff.type)).slice(0, 5);
    const filterArg = f.args.find((a) => a.name !== 'set');
    const filterClause = filterArg ? `${filterArg.name}: ${typeof placeholderFor(filterArg.type) === 'string' ? '"value"' : placeholderFor(filterArg.type)}` : '';
    const setClause = prefix === 'update_' ? `, set: { ${scalarFields.map((ff) => `${ff.name}: ${typeof placeholderFor(ff.type) === 'string' ? `"${placeholderFor(ff.type)}"` : placeholderFor(ff.type)}`).join(', ')} }` : '';
    const returnCols = scalarFields.map((ff) => `    ${ff.name}`).join('\n') || '    __typename';
    setQuery(`mutation {\n  ${f.name}(${filterClause}${setClause}) {\n${returnCols}\n  }\n}`);
  }

  function selectField(f: GqlField, kind: 'query' | 'insert' | 'update' | 'delete') {
    setSelectedField(f);
    if (kind === 'query') starterForQueryField(f);
    else if (kind === 'insert') starterForInsert(f);
    else starterForUpdateOrDelete(f, kind === 'update' ? 'update_' : 'delete_');
  }

  async function run() {
    if (!query.trim()) return;
    setRunning(true);
    setResult(null);
    try {
      const out = await graphqlRequest(query);
      setResult({ data: out.data, errors: out.errors });
    } catch (e: any) {
      setResult({ data: null, errors: [{ message: e?.message ?? String(e) }] });
    } finally {
      setRunning(false);
    }
  }

  const btnCls = 'h-8 rounded-md bg-brand px-3 text-md font-semibold text-brand-text-on hover:bg-brand-hover disabled:opacity-45';

  if (loading) return <p className="p-4 text-sm text-text-light">Loading…</p>;
  if (loadError) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <h3 className="m-0 text-md font-semibold">Could not load the GraphQL schema</h3>
        <p className="m-0 text-sm text-error">{loadError}</p>
      </div>
    );
  }
  if (!supported) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <h3 className="m-0 text-md font-semibold">GraphQL not available</h3>
        <p className="m-0 text-sm text-text-light">
          This server predates item 130 (<code>POST /graphql</code>).
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full gap-4 p-4">
      <div className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-r border-border pr-3">
        <div>
          <span className="mb-1 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-text-muted uppercase">
            <Network className="size-3.5" /> Query
          </span>
          <div className="flex flex-col gap-0.5">
            {(queryType?.fields ?? []).map((f) => (
              <button
                key={f.name}
                onClick={() => selectField(f, 'query')}
                className={cn(
                  'flex items-center justify-between rounded-md px-2 py-1 text-left font-mono text-sm hover:bg-accent',
                  selectedField?.name === f.name && 'bg-selected text-brand',
                )}
              >
                {f.name}
              </button>
            ))}
          </div>
        </div>

        {(insertFields.length > 0 || updateFields.length > 0 || deleteFields.length > 0) && (
          <div>
            <span className="mb-1 text-xs font-semibold tracking-wide text-text-muted uppercase">Mutations</span>
            <div className="flex flex-col gap-0.5">
              {insertFields.map((f) => (
                <button key={f.name} onClick={() => selectField(f, 'insert')} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-left font-mono text-sm hover:bg-accent">
                  <Badge variant="ok" className="shrink-0">
                    write
                  </Badge>
                  {f.name}
                </button>
              ))}
              {updateFields.map((f) => (
                <button key={f.name} onClick={() => selectField(f, 'update')} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-left font-mono text-sm hover:bg-accent">
                  <Badge variant="warn" className="shrink-0">
                    write
                  </Badge>
                  {f.name}
                </button>
              ))}
              {deleteFields.map((f) => (
                <button key={f.name} onClick={() => selectField(f, 'delete')} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-left font-mono text-sm hover:bg-accent">
                  <Badge variant="error" className="shrink-0">
                    write
                  </Badge>
                  {f.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-md border border-border bg-secondary/40 p-2 text-xs leading-relaxed text-text-light">
          Differentiators over a relational-only stack: <code>edges(type, direction)</code> graph traversal and root{' '}
          <code>near_&lt;table&gt;(vector, k)</code> vector similarity — check the field list above for tables that qualify on this schema.
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-3">
        <PanelHelp
          summary="A GraphQL API auto-generated from your schema — plus graph traversal and vector search a relational-only GraphQL can't do."
          what={
            <>
              The schema on the left is a live introspection of <code>POST /graphql</code>: a <code>Query</code> root plus{' '}
              <code>insert_/update_/delete_&lt;table&gt;</code> mutation roots. Every resolver runs the <strong>same enforced SQL path</strong> as{' '}
              <code>/rest/v1</code> and <code>/sql</code>, so RLS / <code>WITH CHECK</code> / column grants apply identically. Root fields take
              the same <strong>filter matrix</strong> as <code>/rest/v1</code>: equality is the bare column
              (<code>country: "DE"</code>), plus <code>_neq/_gt/_gte/_lt/_lte/_like/_ilike/_in/_is_null</code> suffixes, and{' '}
              <code>orderBy</code>/<code>limit</code>/<code>offset</code> (nested relations too). Two things a pg_graphql-style stack can't do:{' '}
              <code>edges(type, direction)</code> graph traversal and root <code>near_&lt;table&gt;(vector, k)</code> vector similarity.
            </>
          }
          actions={[
            'Click a field on the left to scaffold a query, then Run it',
            'Filter it: { customers(country: "DE", orderBy: "id", limit: 3) { id city } }',
            'Try an insert_/update_/delete_ mutation and read the real {data, errors} envelope',
          ]}
          routes={['POST /graphql']}
        />
        {selectedField && (
          <div className="rounded-md border border-border bg-secondary/40 p-2 font-mono text-sm">
            <span className="font-semibold">{selectedField.name}</span>
            {selectedField.args.length > 0 && (
              <span className="text-text-light">
                (
                {selectedField.args.map((a, i) => (
                  <span key={a.name}>
                    {i > 0 && ', '}
                    {a.name}: {typeLabel(a.type)}
                  </span>
                ))}
                )
              </span>
            )}
            : {typeLabel(selectedField.type)}
          </div>
        )}
        <Textarea value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} className="min-h-40 flex-1 font-mono text-sm" />
        <div>
          <button className={cn(btnCls, 'flex items-center gap-1.5')} onClick={run} disabled={running || !query.trim()}>
            <Play className="size-3.5" /> {running ? 'Running…' : 'Run'}
          </button>
        </div>
        {result && (
          <pre className="m-0 flex-1 overflow-auto rounded-md border border-border bg-secondary px-3 py-2 font-mono text-sm">
            {JSON.stringify(result, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}
