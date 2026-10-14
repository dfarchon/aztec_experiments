import { useEffect, useId, useRef, useState } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';

// Small by default; keyboard and touch users can also open the explanation.
export function Hint({ label, children, symbol = 'ⓘ', tone = '', ...props }: HTMLAttributes<HTMLSpanElement> & { label: string; children: ReactNode; symbol?: string; tone?: string }) {
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <span ref={root} className={`hint ${tone}`} {...props}
    onPointerEnter={event => { if (event.pointerType === 'mouse') setHovered(true); }} onPointerLeave={() => setHovered(false)} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={event => { if (event.key === 'Escape') { setOpen(false); setHovered(false); } }}>
    <button type="button" className="hint-trigger" aria-label={label} aria-expanded={open || hovered}
      aria-describedby={id} onClick={() => setOpen(value => !value)}>{symbol}</button>
    <span id={id} role="tooltip" className={`hint-content${open || hovered ? ' is-open' : ''}`}>{children}</span>
  </span>;
}
