import type { CatalogError } from '@/hooks/useCatalog';

// Renders a normalized engine ApiError ({message, code, status}) verbatim —
// per DESIGN_SPEC §4 "Error display": never swallow or rewrite engine errors.
export function ErrorBox({ error }: { error: CatalogError | null | undefined }) {
  if (!error) return null;
  return (
    <div className="flex items-baseline gap-2.5 rounded-md border border-error/35 bg-error-subtle px-3 py-2 text-md" role="alert">
      <span className="font-mono font-semibold whitespace-nowrap text-error">
        {error.code}
        {error.status ? ` · ${error.status}` : ''}
      </span>
      <span className="text-foreground">{error.message}</span>
    </div>
  );
}
