import type { ReactNode } from 'react';

// Honest empty/loading/error copy only — never invented data (DESIGN_SPEC §4).
export function EmptyState({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center text-text-light">
      <svg
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        className="size-5 text-text-muted"
      >
        <circle cx="10" cy="10" r="7.5" />
        <line x1="10" y1="6.5" x2="10" y2="10.5" />
        <circle cx="10" cy="13.3" r="0.4" fill="currentColor" stroke="none" />
      </svg>
      <p className="text-md m-0">{message}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
