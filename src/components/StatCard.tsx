import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// DESIGN_SPEC §4 "Stat card". A missing metric must render as "—" — never a
// made-up number — so callers pass `value={null}` rather than a placeholder.
export function StatCard({
  label,
  value,
  sub,
  icon,
  tone = 'default',
  className,
}: {
  label: string;
  value: string | number | null;
  sub?: string;
  icon?: ReactNode;
  tone?: 'default' | 'ok' | 'warn' | 'error';
  className?: string;
}) {
  const toneClass =
    tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'error' ? 'text-error' : 'text-foreground';

  return (
    <div className={cn('flex flex-col gap-2 rounded-lg border border-border bg-card p-4', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">{label}</span>
        {icon ? (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-text-light">
            {icon}
          </span>
        ) : null}
      </div>
      <span className={cn('text-num font-mono leading-none', toneClass)}>{value ?? '—'}</span>
      {sub ? <span className="text-sm text-text-light">{sub}</span> : null}
    </div>
  );
}
