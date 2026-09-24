import { useState } from "react";

/** One horizontal bar; segments stack left to right in series order. */
export interface Bar { key: string; label: string; segments: number[]; sub?: string }

interface Props {
  bars: Bar[];
  /** Series names in fixed order. Colour follows the series, so a series keeps its colour when others are filtered out. */
  series: string[];
  format: (n: number) => string;
  /** How many bars to draw; the rest are named in a note (all of them stay in the table). */
  limit?: number;
  onPick?: (key: string) => void;
  title: string;
}

export default function BarChart({ bars, series, format, limit = 15, onPick, title }: Props) {
  const [tip, setTip] = useState<{ bar: Bar; x: number; y: number } | null>(null);
  const total = (b: Bar) => b.segments.reduce((a, v) => a + Math.max(v, 0), 0);
  const sorted = [...bars].sort((a, b) => total(b) - total(a));
  const shown = sorted.slice(0, limit);
  const max = Math.max(1, ...shown.map(total));
  if (!bars.length) return <p className="empty">Nothing to chart for this selection.</p>;

  const show = (bar: Bar, el: HTMLElement, e?: React.PointerEvent) => {
    const box = el.closest(".barchart")!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setTip({ bar, x: (e ? e.clientX : r.left + r.width / 2) - box.left, y: r.top - box.top });
  };

  return <figure className="barchart" aria-label={title}>
    {series.length > 1 && <figcaption className="legend">{series.map((s, i) => <span key={s}><i className={`sw s${i + 1}`} />{s}</span>)}</figcaption>}
    <div className="bars" onPointerLeave={() => setTip(null)}>
      {shown.map(b => {
        const t = total(b);
        return <div key={b.key} className={`barrow${onPick ? " pickable" : ""}`} tabIndex={0} role={onPick ? "button" : undefined}
          aria-label={`${b.label}: ${series.map((s, i) => `${s} ${format(b.segments[i] || 0)}`).join(", ")}`}
          onPointerMove={e => show(b, e.currentTarget, e)} onFocus={e => show(b, e.currentTarget)} onBlur={() => setTip(null)}
          onClick={() => onPick?.(b.key)} onKeyDown={e => { if (onPick && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onPick(b.key); } }}>
          <span className="barlabel" title={b.label}>{b.label}{b.sub && <small>{b.sub}</small>}</span>
          <span className="bartrack">
            <span className="barfill" style={{ width: `${(t / max) * 100}%` }}>
              {b.segments.map((v, i) => v > 0 && <span key={i} className={`part s${i + 1}`} style={{ flexGrow: v }} />)}
            </span>
            <span className="barvalue">{format(t)}</span>
          </span>
        </div>;
      })}
    </div>
    {sorted.length > shown.length && <p className="hint">Top {shown.length} of {sorted.length} shown. The table below has all of them.</p>}
    {tip && <div className="tooltip" style={{ left: tip.x, top: tip.y }} role="status">
      <b>{tip.bar.label}</b>
      {series.length > 1
        ? series.map((s, i) => <div key={s} className="tiprow"><i className={`key s${i + 1}`} /><strong>{format(tip.bar.segments[i] || 0)}</strong><span>{s}</span></div>)
        : <div className="tiprow"><strong>{format(total(tip.bar))}</strong><span>{series[0]}</span></div>}
      {series.length > 1 && <div className="tiprow total"><strong>{format(total(tip.bar))}</strong><span>total</span></div>}
    </div>}
  </figure>;
}
