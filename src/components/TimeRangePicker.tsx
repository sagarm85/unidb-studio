import { useEffect, useRef, useState } from 'react';
import { Clock, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Preset {
  label: string;
  ms?: number;
  calendar?: 'today' | 'yesterday';
}

const PRESETS: Preset[] = [
  { label: 'Last 10 minutes', ms: 10 * 60 * 1000 },
  { label: 'Last 30 minutes', ms: 30 * 60 * 1000 },
  { label: 'Last 1 hour', ms: 60 * 60 * 1000 },
  { label: 'Last 3 hours', ms: 3 * 60 * 60 * 1000 },
  { label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { label: 'Today', calendar: 'today' },
  { label: 'Yesterday', calendar: 'yesterday' },
  { label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: 'Last 14 days', ms: 14 * 24 * 60 * 60 * 1000 },
  { label: 'Last 28 days', ms: 28 * 24 * 60 * 60 * 1000 },
];

const MO = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DH = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function p2(n: string | number) {
  return String(Math.max(0, Math.min(99, Number(n) || 0))).padStart(2, '0');
}
function dayOnly(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

interface Cell {
  day: number;
  date: Date;
  cur: boolean;
}

function buildCal(yr: number, mo: number): Cell[] {
  const firstWd = new Date(yr, mo, 1).getDay();
  const daysInMo = new Date(yr, mo + 1, 0).getDate();
  const daysInPrev = new Date(yr, mo, 0).getDate();
  const out: Cell[] = [];
  const prevMoVal = mo === 0 ? 11 : mo - 1;
  const prevYr = mo === 0 ? yr - 1 : yr;
  for (let i = firstWd - 1; i >= 0; i--) out.push({ day: daysInPrev - i, date: new Date(prevYr, prevMoVal, daysInPrev - i), cur: false });
  for (let d = 1; d <= daysInMo; d++) out.push({ day: d, date: new Date(yr, mo, d), cur: true });
  const nextMoVal = mo === 11 ? 0 : mo + 1;
  const nextYr = mo === 11 ? yr + 1 : yr;
  let nx = 1;
  while (out.length < 42) out.push({ day: nx, date: new Date(nextYr, nextMoVal, nx++), cur: false });
  return out;
}

function rangeFromPreset(p: Preset) {
  const now = new Date();
  if (p.calendar === 'today') {
    return {
      from: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0),
      to: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59),
    };
  }
  if (p.calendar === 'yesterday') {
    const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    return { from: new Date(y.getFullYear(), y.getMonth(), y.getDate(), 0, 0, 0), to: new Date(y.getFullYear(), y.getMonth(), y.getDate(), 23, 59, 59) };
  }
  return { from: new Date(now.getTime() - (p.ms ?? 0)), to: now };
}

export function TimeRangePicker({
  onApply,
  defaultPreset = 'Last 24 hours',
}: {
  onApply: (range: { since: string; until: string }) => void;
  defaultPreset?: string;
}) {
  const initial = useRef((() => {
    const pr = PRESETS.find((p) => p.label === defaultPreset) ?? PRESETS[4];
    const { from, to } = rangeFromPreset(pr);
    return { pr, from, to };
  })()).current;

  const [open, setOpen] = useState(false);
  const [triggerLabel, setTriggerLabel] = useState(initial.pr.label);
  const [activePreset, setActivePreset] = useState(initial.pr.label);

  const [viewYear, setViewYear] = useState(initial.from.getFullYear());
  const [viewMonth, setViewMonth] = useState(initial.from.getMonth());

  const [selStart, setSelStart] = useState<Date | null>(dayOnly(initial.from));
  const [selEnd, setSelEnd] = useState<Date | null>(dayOnly(initial.to));
  const [startHH, setStartHH] = useState(p2(initial.from.getHours()));
  const [startMM, setStartMM] = useState(p2(initial.from.getMinutes()));
  const [startSS, setStartSS] = useState(p2(initial.from.getSeconds()));
  const [endHH, setEndHH] = useState(p2(initial.to.getHours()));
  const [endMM, setEndMM] = useState(p2(initial.to.getMinutes()));
  const [endSS, setEndSS] = useState(p2(initial.to.getSeconds()));

  const [phase, setPhase] = useState(0); // 0 = awaiting start click, 1 = awaiting end click
  const [hoverDay, setHoverDay] = useState<Date | null>(null);
  const [copied, setCopied] = useState(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const [dropStyle, setDropStyle] = useState<{ top: number; left: number } | null>(null);

  function setPreset(p: Preset) {
    setActivePreset(p.label);
    const { from, to } = rangeFromPreset(p);
    setSelStart(dayOnly(from));
    setSelEnd(dayOnly(to));
    setStartHH(p2(from.getHours()));
    setStartMM(p2(from.getMinutes()));
    setStartSS(p2(from.getSeconds()));
    setEndHH(p2(to.getHours()));
    setEndMM(p2(to.getMinutes()));
    setEndSS(p2(to.getSeconds()));
    setViewYear(from.getFullYear());
    setViewMonth(from.getMonth());
    setPhase(0);
  }

  function goToday() {
    const now = new Date();
    setSelStart(dayOnly(now));
    setSelEnd(dayOnly(now));
    setStartHH('00');
    setStartMM('00');
    setStartSS('00');
    setEndHH(p2(now.getHours()));
    setEndMM(p2(now.getMinutes()));
    setEndSS(p2(now.getSeconds()));
    setViewYear(now.getFullYear());
    setViewMonth(now.getMonth());
    setActivePreset('');
    setPhase(0);
  }

  function prevMo() {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear((y) => y - 1);
    } else setViewMonth((m) => m - 1);
  }
  function nextMo() {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear((y) => y + 1);
    } else setViewMonth((m) => m + 1);
  }

  const cells = buildCal(viewYear, viewMonth);

  function clickDay(cell: Cell) {
    if (!cell.cur) return;
    if (phase === 0) {
      setSelStart(cell.date);
      setSelEnd(null);
      setStartHH('00');
      setStartMM('00');
      setStartSS('00');
      setPhase(1);
      setActivePreset('');
    } else {
      let s = selStart!;
      let e = cell.date;
      if (e < s) [s, e] = [e, s];
      setSelStart(s);
      setSelEnd(e);
      setEndHH('23');
      setEndMM('59');
      setEndSS('59');
      setPhase(0);
    }
  }

  function cellCls(cell: Cell) {
    if (!cell.cur) return 'other';
    const t = cell.date.getTime();
    const tod = dayOnly(new Date()).getTime();
    const s = selStart ? selStart.getTime() : null;
    const rawE = selEnd ?? (phase === 1 && hoverDay ? hoverDay : null);
    const e = rawE ? rawE.getTime() : null;
    const lo = s !== null && e !== null ? Math.min(s, e) : null;
    const hi = s !== null && e !== null ? Math.max(s, e) : null;
    let cls = '';
    if (t === tod) cls += ' today';
    if (s !== null && t === s) cls += ' sel-s';
    if (e !== null && t === e) cls += ' sel-e';
    if (lo !== null && hi !== null && t > lo && t < hi) cls += ' in-rng';
    return cls.trim();
  }

  function buildIso(d: Date, hh: string, mm: string, ss: string) {
    const r = new Date(d);
    r.setHours(Number(hh) || 0, Number(mm) || 0, Number(ss) || 0, 0);
    return r.toISOString();
  }

  function fmtLabel(s: string, u: string) {
    const fmt = (d: string) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `${fmt(s)} – ${fmt(u)}`;
  }

  function doApply() {
    if (!selStart) return;
    const end = selEnd ?? selStart;
    const since = buildIso(selStart, startHH, startMM, startSS);
    const until = buildIso(end, endHH, endMM, endSS);
    setTriggerLabel(activePreset || fmtLabel(since, until));
    onApply({ since, until });
    setOpen(false);
  }

  async function copyRange() {
    if (!selStart) return;
    const end = selEnd ?? selStart;
    const since = buildIso(selStart, startHH, startMM, startSS);
    const until = buildIso(end, endHH, endMM, endSS);
    try {
      await navigator.clipboard.writeText(`${since} / ${until}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  }

  function openToggle() {
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      const left = Math.min(r.left, window.innerWidth - 544);
      setDropStyle({ top: r.bottom + 6, left });
    }
    setOpen((o) => !o);
  }

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!open) return;
      const target = e.target as Node;
      if (triggerRef.current && !triggerRef.current.contains(target) && dropRef.current && !dropRef.current.contains(target)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (open && e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative inline-block">
      <button
        ref={triggerRef}
        className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-md whitespace-nowrap hover:border-border-strong"
        onClick={openToggle}
      >
        <Clock className="size-3.5 opacity-45" />
        {triggerLabel}
        <ChevronDown className="size-2.5 opacity-45" />
      </button>

      {open && (
        <div
          ref={dropRef}
          role="dialog"
          aria-label="Time range picker"
          className="fixed z-50 flex overflow-hidden rounded-lg border border-border bg-card shadow-[var(--shadow-overlay)]"
          style={dropStyle ? { top: dropStyle.top, left: dropStyle.left } : undefined}
        >
          <div className="flex min-w-[158px] flex-col border-r border-border py-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                className={cn(
                  'px-4 py-1.5 text-left text-md whitespace-nowrap hover:bg-accent',
                  activePreset === p.label && 'bg-accent font-semibold text-brand',
                )}
                onClick={() => setPreset(p)}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="flex min-w-[260px] flex-col gap-2.5 p-3.5">
            <div className="flex gap-2">
              {[
                { hh: startHH, mm: startMM, ss: startSS, setHH: setStartHH, setMM: setStartMM, setSS: setStartSS },
                { hh: endHH, mm: endMM, ss: endSS, setHH: setEndHH, setMM: setEndMM, setSS: setEndSS },
              ].map((t, i) => (
                <div key={i} className="flex flex-1 items-center gap-0.5 rounded-md border border-border bg-secondary px-2 py-1 font-mono text-md">
                  <Clock className="size-3 shrink-0 opacity-45" />
                  <input
                    className="w-6 border-none bg-transparent text-center outline-none"
                    type="number"
                    min={0}
                    max={23}
                    value={t.hh}
                    onChange={(e) => t.setHH(e.target.value)}
                  />
                  <span className="opacity-35 select-none">:</span>
                  <input
                    className="w-6 border-none bg-transparent text-center outline-none"
                    type="number"
                    min={0}
                    max={59}
                    value={t.mm}
                    onChange={(e) => t.setMM(e.target.value)}
                  />
                  <span className="opacity-35 select-none">:</span>
                  <input
                    className="w-6 border-none bg-transparent text-center outline-none"
                    type="number"
                    min={0}
                    max={59}
                    value={t.ss}
                    onChange={(e) => t.setSS(e.target.value)}
                  />
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between">
              <button className="rounded-sm border border-border px-1.5 text-lg leading-[1.4] hover:bg-accent" onClick={prevMo} aria-label="Previous month">
                ‹
              </button>
              <span className="text-md font-semibold">
                {MO[viewMonth]} {viewYear}
              </span>
              <button className="rounded-sm border border-border px-1.5 text-lg leading-[1.4] hover:bg-accent" onClick={nextMo} aria-label="Next month">
                ›
              </button>
            </div>

            <div className="grid grid-cols-7 gap-px" role="grid" aria-label="Calendar">
              {DH.map((d) => (
                <div key={d} className="pt-0.5 pb-1.5 text-center text-xs font-semibold text-text-muted" role="columnheader">
                  {d}
                </div>
              ))}
              {cells.map((cell, i) => (
                <button
                  key={i}
                  className={cn(
                    'rounded-sm py-1.5 text-center text-sm leading-none text-foreground transition-colors',
                    cellCls(cell).includes('other') && 'pointer-events-none text-text-muted opacity-35',
                    cellCls(cell).includes('today') && 'font-bold text-brand',
                    !cellCls(cell).includes('other') && 'hover:bg-accent',
                    (cellCls(cell).includes('sel-s') || cellCls(cell).includes('sel-e')) && 'bg-brand text-brand-text-on hover:bg-brand',
                    cellCls(cell).includes('in-rng') && 'rounded-none bg-brand-subtle',
                  )}
                  onClick={() => clickDay(cell)}
                  onMouseEnter={() => cell.cur && setHoverDay(cell.date)}
                  onMouseLeave={() => setHoverDay(null)}
                  tabIndex={cell.cur ? 0 : -1}
                  aria-label={`${MO[cell.date.getMonth()]} ${cell.day}, ${cell.date.getFullYear()}`}
                >
                  {cell.day}
                </button>
              ))}
            </div>

            <div className="mt-0.5 flex justify-end gap-1.5 border-t border-border pt-2.5">
              <button className="rounded-md border border-border bg-card px-3 py-1 text-sm hover:bg-accent" onClick={copyRange}>
                {copied ? 'Copied ✓' : 'Copy range'}
              </button>
              <button className="rounded-md border border-border bg-card px-3 py-1 text-sm hover:bg-accent" onClick={goToday}>
                Today
              </button>
              <button
                className="rounded-md bg-brand px-3 py-1 text-sm font-semibold text-brand-text-on hover:bg-brand-hover disabled:opacity-45"
                onClick={doApply}
                disabled={!selStart}
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
