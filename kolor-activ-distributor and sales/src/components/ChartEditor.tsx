import { Select } from "./Select";
import { ChartConfig, Ctx, KIND_SPECS } from "../lib/insights";
import FilterBar, { emptyScope } from "./FilterBar";

interface Props {
  chart: ChartConfig; ctx: Ctx; first: boolean; last: boolean;
  onChange: (c: ChartConfig) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void;
}

/** The settings panel for one chart. Every change applies straight away and is saved. */
export default function ChartEditor({ chart, ctx, first, last, onChange, onMove, onRemove }: Props) {
  const spec = KIND_SPECS[chart.kind];
  const set = (patch: Partial<ChartConfig>) => onChange({ ...chart, ...patch });
  return <div className="editor">
    <label>Chart name<input value={chart.title ?? ""} placeholder={spec.title} onChange={e => set({ title: e.target.value })} /></label>
    <label className="inline"><input type="checkbox" checked={!!chart.focus} onChange={e => set({ focus: e.target.checked })} /> Show large, at the top</label>
    {spec.options.map((o, i) => {
      if (o.key === "metric") return <div key={i} className="field"><span>Measure</span>
        <div className="seg" role="group" aria-label="Measure">
          <button className={chart.metric !== "units" ? "on" : ""} onClick={() => set({ metric: "value" })}>Value ₹</button>
          <button className={chart.metric === "units" ? "on" : ""} onClick={() => set({ metric: "units" })}>Units</button></div></div>;
      if (o.key === "top") return <label key={i}>Bars to show<Select value={chart.top ?? 10} onChange={e => set({ top: Number(e.target.value) })}>
        {[5, 10, 15, 20, 30].map(n => <option key={n} value={n}>Top {n}</option>)}</Select></label>;
      if (o.key === "labels") return <label key={i} className="inline"><input type="checkbox" checked={chart.labels !== false} onChange={e => set({ labels: e.target.checked })} /> Show values on the chart</label>;
      if (o.key === "scope") return <div key={i} className="field"><span>Which locations</span>
        <FilterBar locations={ctx.locations} value={chart.scope || emptyScope()} onChange={s => set({ scope: s })} kinds={o.kinds} /></div>;
      if (o.key === "groupBy" || o.key === "split") return <label key={i}>{o.label}
        <Select value={(chart[o.key] as string) ?? o.choices[0].id} onChange={e => set({ [o.key]: e.target.value })}>
          {o.choices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</Select></label>;
      if (o.key === "series") {
        const on = chart.series?.length ? chart.series : o.choices.map(c => c.id);
        return <div key={i} className="field"><span>{o.label}</span>{o.choices.map(c => <label key={c.id} className="inline">
          <input type="checkbox" checked={on.includes(c.id)} disabled={on.length === 1 && on.includes(c.id)}
            onChange={e => set({ series: e.target.checked ? [...on, c.id] : on.filter(x => x !== c.id) })} /> {c.label}</label>)}</div>;
      }
      if (o.key !== "days" && o.key !== "weeks" && o.key !== "threshold") return null;
      const value = (chart[o.key] as number | undefined) ?? (spec.defaults[o.key] as number);
      return <label key={i}>{o.label}<span className="numrow">
        <input type="number" min={o.min} max={o.max} value={value}
          onChange={e => { const v = Number(e.target.value); if (v >= o.min && v <= o.max) set({ [o.key]: v }); }} />{o.suffix}</span></label>;
    })}
    <div className="editor-actions">
      <button className="secondary small" disabled={first} onClick={() => onMove(-1)}>Move up</button>
      <button className="secondary small" disabled={last} onClick={() => onMove(1)}>Move down</button>
      <button className="secondary small" onClick={() => onChange({ id: chart.id, kind: chart.kind, ...spec.defaults, focus: chart.focus })}>Reset this chart</button>
      <button className="del small" onClick={onRemove}>Remove from dashboard</button>
    </div>
  </div>;
}
