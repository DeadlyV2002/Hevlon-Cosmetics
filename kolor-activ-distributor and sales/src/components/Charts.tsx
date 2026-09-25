import { useLayoutEffect, useRef, useState } from "react";
import { ChartData, SeriesDef, formatValue } from "../lib/insights";

export type ChartSize = "card" | "focus" | "large";

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

interface Tip { x: number; y: number; title: string; rows: { slot?: number; value: string; name: string }[] }
function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return <div className="tooltip" style={{ left: tip.x, top: tip.y }} role="status">
    <b>{tip.title}</b>
    {tip.rows.map((r, i) => <div key={i} className="tiprow">{r.slot && <i className={`key s${r.slot}`} />}<strong>{r.value}</strong><span>{r.name}</span></div>)}
  </div>;
}
function Legend({ series, line }: { series: SeriesDef[]; line?: boolean }) {
  if (series.length < 2) return null;
  return <div className="legend">{series.map(s => <span key={s.key}><i className={line ? `key s${s.slot}` : `sw s${s.slot}`} />{s.name}</span>)}</div>;
}

/** Everything a chart needs: bars, stacked columns or lines, picked by the data's type. */
export function ChartView({ data, size, labels = true }: { data: ChartData; size: ChartSize; labels?: boolean }) {
  if (data.type === "bars") return <Bars data={data} size={size} labels={labels} />;
  return <XChart data={data} size={size} labels={labels} />;
}

// ---------- horizontal bars: one row per thing, value at the tip ----------
function Bars({ data, size, labels }: { data: Extract<ChartData, { type: "bars" }>; size: ChartSize; labels: boolean }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const f = (n: number) => formatValue(data.unit, n);
  const total = (v: number[]) => v.reduce((a, x) => a + Math.max(x, 0), 0);
  const max = Math.max(1, ...data.rows.map(r => total(r.values)));
  const show = (e: React.PointerEvent | React.FocusEvent, r: (typeof data.rows)[number]) => {
    const b = box.current!.getBoundingClientRect(), t = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = "clientX" in e ? e.clientX : t.left + t.width / 2;
    setTip({ x: x - b.left, y: t.top - b.top, title: r.label + (r.sub ? ` · ${r.sub}` : ""),
      rows: data.series.length > 1 ? data.series.map((s, i) => ({ slot: s.slot, value: f(r.values[i] || 0), name: s.name })) : [{ value: f(total(r.values)), name: data.series[0]?.name || "" }] });
  };
  return <div className={`hbars sz-${size}`} ref={box} onPointerLeave={() => setTip(null)}>
    <Legend series={data.series} />
    {data.rows.map(r => <div className="hbar" key={r.key} tabIndex={0} aria-label={`${r.label}: ${f(total(r.values))}`}
      onPointerMove={e => show(e, r)} onFocus={e => show(e, r)} onBlur={() => setTip(null)}>
      <span className="hlabel" title={r.label}>{r.label}{r.sub && <small>{r.sub}</small>}</span>
      <span className="htrack">
        <span className="hfill" style={{ width: `${(total(r.values) / max) * 100}%` }}>
          {r.values.map((v, i) => v > 0 && <span key={i} className={`part s${data.series[i]?.slot || 1}`} style={{ flexGrow: v }} />)}
        </span>
        {labels && <span className="hvalue">{f(total(r.values))}</span>}
      </span>
    </div>)}
    {data.more > 0 && <p className="hint">and {data.more} more</p>}
    <Tooltip tip={tip} />
  </div>;
}

// ---------- weekly charts: stacked columns or lines on one axis ----------
const HEIGHT: Record<ChartSize, number> = { card: 210, focus: 250, large: 0 };
/** Column with a rounded data end (top) and a square base. */
const colPath = (x: number, y: number, w: number, h: number, r: number) => {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
};

function XChart({ data, size, labels }: { data: Extract<ChartData, { type: "columns" | "lines" }>; size: ChartSize; labels: boolean }) {
  // The plot area is measured on its own; in the enlarged view the svg sits absolutely inside it,
  // so the chart's size can never push its container bigger.
  const [ref, dim] = useSize<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const [hover, setHover] = useState(-1);
  const f = (n: number) => formatValue(data.unit, n);
  const lines = data.type === "lines";
  const W = dim.w, H = size === "large" ? Math.max(240, dim.h) : HEIGHT[size];
  const n = data.x.length;
  const pad = { top: 26, bottom: 26, left: 10, right: lines ? 86 : 10 };
  const iw = Math.max(1, W - pad.left - pad.right), ih = Math.max(1, H - pad.top - pad.bottom);
  const stackTotals = data.x.map((_, i) => data.values.reduce((a, s) => a + Math.max(s[i] || 0, 0), 0));
  const max = Math.max(1, ...(lines ? data.values.flat() : stackTotals)) * 1.08;
  const band = iw / Math.max(n, 1);
  const cx = (i: number) => pad.left + band * i + band / 2;
  const y = (v: number) => pad.top + ih - (Math.max(v, 0) / max) * ih;
  const xEvery = band >= 44 ? 1 : band >= 24 ? 2 : Math.ceil(44 / band);
  const labelEvery = band >= (size === "card" ? 40 : 34) ? 1 : 2;
  const empty = data.values.every(s => s.every(v => !v));

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const b = e.currentTarget.getBoundingClientRect();
    const i = Math.min(n - 1, Math.max(0, Math.floor((e.clientX - b.left - pad.left) / band)));
    setHover(i);
    setTip({ x: cx(i), y: lines ? pad.top : y(stackTotals[i]) - 4, title: data.x[i],
      rows: [...data.series.map((s, k) => ({ slot: s.slot, value: f(data.values[k][i] || 0), name: s.name })).reverse(),
        ...(!lines && data.series.length > 1 ? [{ value: f(stackTotals[i]), name: "in all" }] : [])] });
  }

  // End labels for lines, moved apart when they would overlap (with a thin leader to the line end).
  const ends = lines ? data.series.map((s, k) => ({ s, k, v: data.values[k][n - 1] || 0, y0: y(data.values[k][n - 1] || 0) }))
    .sort((a, b) => a.y0 - b.y0).reduce<{ s: SeriesDef; k: number; v: number; y0: number; y1: number }[]>((acc, e) => {
      const prev = acc[acc.length - 1]; acc.push({ ...e, y1: prev ? Math.max(e.y0, prev.y1 + 15) : e.y0 }); return acc;
    }, []) : [];

  return <div className={`xchart sz-${size}`}>
    <Legend series={data.series} line={lines} />
    <div className="plot" ref={ref} style={size === "large" ? undefined : { height: H }}>
    {W > 0 && <svg width={W} height={H} role="img" aria-label={data.summary} onPointerMove={onMove} onPointerLeave={() => { setTip(null); setHover(-1); }}>
      <line className="baseline" x1={pad.left} x2={pad.left + iw} y1={pad.top + ih} y2={pad.top + ih} />
      {hover >= 0 && <rect className="hoverband" x={pad.left + band * hover} y={pad.top - 6} width={band} height={ih + 6} />}
      {!lines && data.x.map((_, i) => {
        const w = Math.min(24, band * 0.62), x0 = cx(i) - w / 2;
        let acc = 0;
        const visible = data.series.map((_, k) => k).filter(k => (data.values[k][i] || 0) > 0);
        return <g key={i}>{visible.map((k, j) => {
          const v = data.values[k][i], yTop = y(acc + v), yBot = y(acc);
          acc += v;
          const top = j === visible.length - 1, h = Math.max(yBot - yTop - (top ? 0 : 2), 1);
          return top ? <path key={k} className={`f${data.series[k].slot}`} d={colPath(x0, yTop, w, h, 4)} />
            : <rect key={k} className={`f${data.series[k].slot}`} x={x0} y={yTop + 2} width={w} height={h} />;
        })}
          {labels && stackTotals[i] > 0 && i % labelEvery === (n - 1) % labelEvery && <text className="dlabel" x={cx(i)} y={y(stackTotals[i]) - 6} textAnchor="middle">{f(stackTotals[i])}</text>}
        </g>;
      })}
      {lines && data.series.map((s, k) => {
        const pts = data.values[k].map((v, i) => `${cx(i)},${y(v)}`).join(" ");
        return <g key={s.key}>
          <polyline className={`k${s.slot}`} points={pts} fill="none" />
          {data.values[k].map((v, i) => (i === n - 1 || i === hover) && <circle key={i} className={`f${s.slot} ring`} cx={cx(i)} cy={y(v)} r={4} />)}
        </g>;
      })}
      {lines && labels && ends.map(e => <g key={e.s.key}>
        {Math.abs(e.y1 - e.y0) > 2 && <line className="leader" x1={cx(n - 1) + 6} x2={cx(n - 1) + 12} y1={e.y0} y2={e.y1} />}
        <text className="dlabel" x={cx(n - 1) + 14} y={e.y1 + 4}>{f(e.v)}</text>
      </g>)}
      {data.x.map((lab, i) => i % xEvery === (n - 1) % xEvery && <text key={i} className="xlabel" x={cx(i)} y={H - 8} textAnchor="middle">{lab}</text>)}
      {empty && <text className="xlabel" x={pad.left + iw / 2} y={pad.top + ih / 2} textAnchor="middle">Nothing recorded in these weeks</text>}
    </svg>}
    <Tooltip tip={tip} />
    </div>
  </div>;
}
