// Excel-style column filters: each heading opens a list of that column's values to tick, a search
// box and sorting. Filters combine, and each list only offers values left by the other filters.
import { ReactNode, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePlace, useOutside, Select } from "./Select";

export interface Col<T> { key: string; label: string; value: (r: T) => string | number | null | undefined; num?: boolean }
type Filters = Record<string, Set<string> | undefined>;
const BLANK = "(Blanks)";
const text = <T,>(c: Col<T>, r: T) => { const v = c.value(r); return v === null || v === undefined || v === "" ? BLANK : String(v); };

export function useColumnFilters<T>(rows: T[], cols: Col<T>[]) {
  const [filters, setFilters] = useState<Filters>({});
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const pass = (r: T, skip?: string) => cols.every(c => c.key === skip || !filters[c.key] || filters[c.key]!.has(text(c, r)));
  const out = useMemo(() => {
    const list = rows.filter(r => pass(r));
    const c = sort && cols.find(x => x.key === sort.key);
    if (c) list.sort((a, b) => {
      const x = c.value(a), y = c.value(b);
      if (x === null || x === undefined || x === "") return 1;
      if (y === null || y === undefined || y === "") return -1;
      return (c.num || (typeof x === "number" && typeof y === "number") ? Number(x) - Number(y) : String(x).localeCompare(String(y), undefined, { numeric: true })) * sort!.dir;
    });
    return list;
  }, [rows, filters, sort]);
  const active = Object.values(filters).filter(Boolean).length;
  const head = (key: string, extra?: ReactNode) => {
    const c = cols.find(x => x.key === key)!;
    const counts = new Map<string, number>();
    rows.forEach(r => { if (pass(r, key)) { const t = text(c, r); counts.set(t, (counts.get(t) || 0) + 1); } });
    return <ColumnHead key={key} label={c.label} num={c.num} counts={counts} selected={filters[key]} sorted={sort?.key === key ? sort.dir : 0} extra={extra}
      onApply={sel => setFilters(f => ({ ...f, [key]: sel }))} onSort={dir => setSort(dir ? { key, dir } : null)} />;
  };
  /** "Sort by [column] [direction]" for above the table. */
  const sortBar = <div className="sortbar"><span>Sort by</span>
    <Select value={sort?.key || ""} onChange={e => setSort(e.target.value ? { key: e.target.value, dir: sort?.dir || (cols.find(c => c.key === e.target.value)?.num ? -1 : 1) } : null)} aria-label="Sort by">
      <option value="">As listed</option>{cols.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}</Select>
    {sort && <Select value={String(sort.dir)} onChange={e => setSort({ ...sort, dir: Number(e.target.value) as 1 | -1 })} aria-label="Direction">
      <option value="-1">{cols.find(c => c.key === sort.key)?.num ? "Highest first" : "Z to A"}</option><option value="1">{cols.find(c => c.key === sort.key)?.num ? "Lowest first" : "A to Z"}</option></Select>}</div>;
  return { rows: out, head, active, sortBar, clear: () => { setFilters({}); setSort(null); } };
}

function ColumnHead({ label, num, counts, selected, sorted, onApply, onSort, extra }: {
  label: string; num?: boolean; counts: Map<string, number>; selected?: Set<string>; sorted: 0 | 1 | -1;
  onApply: (s: Set<string> | undefined) => void; onSort: (d: 0 | 1 | -1) => void; extra?: ReactNode;
}) {
  const [open, setOpen] = useState(false), [q, setQ] = useState("");
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const btn = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const pos = usePlace(btn, open, 12, 420, 260);
  useOutside(open, [btn, panel], () => setOpen(false));
  const values = [...counts.keys()].sort((a, b) => (a === BLANK ? 1 : b === BLANK ? -1 : num ? Number(a) - Number(b) : a.localeCompare(b, undefined, { numeric: true })));
  const shown = values.filter(v => v.toLowerCase().includes(q.toLowerCase())).slice(0, 400);
  function show() { setDraft(new Set(selected || values)); setQ(""); setOpen(true); }
  function apply() {
    const all = values.every(v => draft.has(v));
    onApply(all ? undefined : new Set(draft)); setOpen(false);
  }
  const allShown = shown.every(v => draft.has(v));
  return <th className={`colhead${selected ? " filtered" : ""}`}>
    <button ref={btn} type="button" className="colbtn" aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? setOpen(false) : show())}>
      {label}<span className="colicon" aria-hidden>{selected ? "⏷" : sorted === 1 ? "↑" : sorted === -1 ? "↓" : "▾"}</span>
    </button>{extra}
    {open && pos.left !== undefined && createPortal(<div className="popup colpanel" ref={panel} style={{ ...pos, maxHeight: undefined }} role="dialog" aria-label={`Filter ${label}`}
      onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
      <div className="colsort">
        <button className={`secondary small${sorted === 1 ? " on" : ""}`} onClick={() => { onSort(sorted === 1 ? 0 : 1); setOpen(false); }}>{num ? "Smallest first" : "A to Z"}</button>
        <button className={`secondary small${sorted === -1 ? " on" : ""}`} onClick={() => { onSort(sorted === -1 ? 0 : -1); setOpen(false); }}>{num ? "Largest first" : "Z to A"}</button>
      </div>
      <input className="search" autoFocus placeholder="Search" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === "Enter") apply(); if (e.key === "Escape") setOpen(false); }} />
      <div className="collist" style={{ maxHeight: Math.max(120, Number(pos.maxHeight || 300) - 150) }}>
        <label className="pickrow"><input type="checkbox" checked={allShown} onChange={() => setDraft(d => { const n = new Set(d); shown.forEach(v => (allShown ? n.delete(v) : n.add(v))); return n; })} /><span>(Select All)</span></label>
        {shown.map(v => <label key={v} className="pickrow"><input type="checkbox" checked={draft.has(v)} onChange={() => setDraft(d => { const n = new Set(d); n.has(v) ? n.delete(v) : n.add(v); return n; })} />
          <span>{v}</span><small>{counts.get(v)}</small></label>)}
        {values.length > shown.length && !q && <small className="muted">Type to find more of the {values.length} values.</small>}
      </div>
      <div className="colactions">
        {selected && <button className="link" onClick={() => { onApply(undefined); setOpen(false); }}>Clear Filter</button>}
        <button className="secondary small" onClick={() => setOpen(false)}>Cancel</button>
        <button className="small" disabled={!draft.size} onClick={apply}>OK</button>
      </div>
    </div>, document.body)}
  </th>;
}
