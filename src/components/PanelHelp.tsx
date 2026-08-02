import { useState, type ReactNode } from 'react';
import { Info, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface PanelHelpProps {
  /** One-line plain-language summary — always visible, so every tab says what it is. */
  summary: string;
  /** Richer explanation shown when expanded. */
  what?: ReactNode;
  /** Concrete things to try in this panel. */
  actions?: ReactNode[];
  /** Engine routes / SQL this panel drives, shown as code chips. */
  routes?: string[];
  /** Start expanded (rare — most panels default collapsed to stay uncluttered). */
  defaultOpen?: boolean;
}

/**
 * A consistent, self-contained "what does this tab do?" helper. Drop it in
 * right under a panel's header. The summary line is always visible (so the tab
 * is never a mystery); the details expand on click (so power users aren't
 * nagged). Content is plain, engine-truthful copy — no fabricated behavior.
 */
export function PanelHelp({ summary, what, actions, routes, defaultOpen = false }: PanelHelpProps) {
  const [open, setOpen] = useState(defaultOpen);
  const expandable = Boolean(what || actions?.length || routes?.length);
  return (
    <div className="rounded-md border border-border bg-secondary/40 text-xs">
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-1.5 px-3 py-2 text-left',
          expandable && 'hover:bg-accent/40',
          !expandable && 'cursor-default',
        )}
      >
        <Info className="size-3.5 shrink-0 text-brand" />
        <span className="text-text-light">{summary}</span>
        {expandable && (
          <ChevronDown className={cn('ml-auto size-3.5 shrink-0 text-text-muted transition-transform', open && 'rotate-180')} />
        )}
      </button>
      {open && expandable && (
        <div className="space-y-2 border-t border-border px-3 py-2.5 leading-relaxed text-text-light">
          {what && <div>{what}</div>}
          {actions && actions.length > 0 && (
            <div>
              <span className="font-semibold text-text-muted">Try:</span>
              <ul className="mt-1 ml-4 list-disc space-y-0.5">
                {actions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>
          )}
          {routes && routes.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-semibold text-text-muted">Engine:</span>
              {routes.map((r) => (
                <code key={r} className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px]">
                  {r}
                </code>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
