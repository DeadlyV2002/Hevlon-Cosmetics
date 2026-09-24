import { localDate, today } from "../lib/parse";

export interface Range { from: string; to: string }

const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return localDate(d); };
const monthStart = (offset = 0) => { const d = new Date(); return localDate(new Date(d.getFullYear(), d.getMonth() + offset, 1)); };
const monthEnd = (offset = 0) => { const d = new Date(); return localDate(new Date(d.getFullYear(), d.getMonth() + offset + 1, 0)); };
/** Indian financial year: 1 April to 31 March. */
const fyStart = () => { const d = new Date(); return localDate(new Date(d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1, 3, 1)); };

export const PRESETS: { id: string; label: string; range: () => Range }[] = [
  { id: "7", label: "Last 7 days", range: () => ({ from: daysAgo(6), to: today() }) },
  { id: "30", label: "Last 30 days", range: () => ({ from: daysAgo(29), to: today() }) },
  { id: "90", label: "Last 90 days", range: () => ({ from: daysAgo(89), to: today() }) },
  { id: "month", label: "This month", range: () => ({ from: monthStart(), to: today() }) },
  { id: "lastmonth", label: "Last month", range: () => ({ from: monthStart(-1), to: monthEnd(-1) }) },
  { id: "fy", label: "This financial year", range: () => ({ from: fyStart(), to: today() }) },
];
export const defaultRange = (id = "30") => PRESETS.find(p => p.id === id)!.range();

export default function DateRange({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const preset = PRESETS.find(p => { const r = p.range(); return r.from === value.from && r.to === value.to; })?.id || "custom";
  return <div className="daterange">
    <select value={preset} aria-label="Date range" onChange={e => { const p = PRESETS.find(x => x.id === e.target.value); if (p) onChange(p.range()); }}>
      {PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
      <option value="custom" disabled>Custom range</option>
    </select>
    <input type="date" aria-label="From" value={value.from} max={value.to} onChange={e => e.target.value && onChange({ ...value, from: e.target.value })} />
    <span>to</span>
    <input type="date" aria-label="To" value={value.to} min={value.from} onChange={e => e.target.value && onChange({ ...value, to: e.target.value })} />
  </div>;
}
