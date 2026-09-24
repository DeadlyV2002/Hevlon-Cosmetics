import { useEffect, useMemo, useRef, useState } from "react";
import { Distributor, Kind, KIND_LABEL, KIND_PLURAL } from "../lib/supabase";

/** Which locations a page looks at: narrowed by type, state, region and super stockist, then optionally hand-picked. */
export interface Scope { kind: Kind | ""; state: string; region: string; ss: string; ids: string[] }
export const emptyScope = (kind: Kind | "" = ""): Scope => ({ kind, state: "", region: "", ss: "", ids: [] });

/** Locations that pass the state / region / super stockist filters. A super stockist filter keeps the SS itself too. */
export function scopePool(list: Distributor[], s: Scope): Distributor[] {
  return list.filter(d => (!s.kind || d.kind === s.kind) && (!s.state || d.state === s.state)
    && (!s.region || d.region === s.region) && (!s.ss || d.parent_id === s.ss || d.id === s.ss));
}
export function applyScope(list: Distributor[], s: Scope): Distributor[] {
  const pool = scopePool(list, s);
  return s.ids.length ? pool.filter(d => s.ids.includes(d.id)) : pool;
}
/** Short name for the current selection, used in headings and file names. */
export function scopeLabel(list: Distributor[], s: Scope): string {
  const picked = applyScope(list, s);
  if (picked.length === 1) return picked[0].name;
  if (s.ids.length) return `${picked.length} selected`;
  const ss = list.find(d => d.id === s.ss);
  const parts = [ss?.name, s.region, s.state].filter(Boolean);
  return parts.length ? parts.join(", ") : s.kind ? `All ${KIND_PLURAL[s.kind].toLowerCase()}` : "All locations";
}

const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.map(x => (x || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
interface Saved { name: string; scope: Scope }
function readSaved(key: string): Saved[] {
  try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch { return []; }
}
function writeSaved(key: string, v: Saved[]) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage blocked: saving just doesn't persist */ }
}

interface Props {
  locations: Distributor[];
  value: Scope;
  onChange: (s: Scope) => void;
  /** Types this page can show. More than one adds a type picker. */
  kinds: Kind[];
  /** Stock value per location, for the "top 10" quick pick. */
  rank?: Map<string, number>;
  /** Key for remembering saved selections in this browser. */
  saveKey?: string;
}

export default function FilterBar({ locations, value, onChange, kinds, rank, saveKey }: Props) {
  const inKinds = useMemo(() => locations.filter(d => kinds.includes(d.kind)), [locations, kinds]);
  const byState = inKinds.filter(d => !value.state || d.state === value.state);
  const states = uniq(inKinds.map(d => d.state));
  const regions = uniq(byState.map(d => d.region));
  const supers = locations.filter(d => d.kind === "SUPER_STOCKIST" && (!value.state || d.state === value.state || byState.some(x => x.parent_id === d.id)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const pool = scopePool(inKinds, value);
  const picked = value.ids.length ? pool.filter(d => value.ids.includes(d.id)) : pool;

  /** Changing a filter drops hand-picked locations that no longer match it. */
  function set(patch: Partial<Scope>) {
    const next = { ...value, ...patch };
    if ("state" in patch) {
      next.region = "";
      const ssHere = !next.state || locations.find(l => l.id === next.ss)?.state === next.state || inKinds.some(x => x.parent_id === next.ss && x.state === next.state);
      if (next.ss && !ssHere) next.ss = "";
    }
    const keep = new Set(scopePool(inKinds, next).map(d => d.id));
    next.ids = next.ids.filter(id => keep.has(id));
    onChange(next);
  }
  const changed = value.kind !== (kinds.length === 1 ? kinds[0] : "") || value.state || value.region || value.ss || value.ids.length;

  return <div className="filterbar">
    {kinds.length > 1 && <select value={value.kind} onChange={e => set({ kind: e.target.value as Kind | "" })} aria-label="Type">
      <option value="">All types</option>{kinds.map(k => <option key={k} value={k}>{KIND_PLURAL[k]}</option>)}</select>}
    <select value={value.state} onChange={e => set({ state: e.target.value })} aria-label="State">
      <option value="">All states</option>{states.map(s => <option key={s} value={s}>{s}</option>)}</select>
    <select value={value.region} onChange={e => set({ region: e.target.value })} disabled={!regions.length} aria-label="Region">
      <option value="">All regions</option>{regions.map(s => <option key={s} value={s}>{s}</option>)}</select>
    {supers.length > 0 && kinds.includes("DISTRIBUTOR") && <select value={value.ss} onChange={e => set({ ss: e.target.value })} aria-label="Super stockist">
      <option value="">All super stockists</option>{supers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
    <Picker pool={pool} picked={picked} value={value} onChange={onChange} rank={rank} saveKey={saveKey} locations={locations}
      noun={value.kind ? KIND_PLURAL[value.kind].toLowerCase() : kinds.length === 1 ? KIND_PLURAL[kinds[0]].toLowerCase() : "locations"} />
    {changed ? <button className="link" onClick={() => onChange(emptyScope(kinds.length === 1 ? kinds[0] : ""))}>Reset</button> : null}
  </div>;
}

function Picker({ pool, picked, value, onChange, rank, saveKey, noun, locations }: {
  pool: Distributor[]; picked: Distributor[]; value: Scope; onChange: (s: Scope) => void; rank?: Map<string, number>; saveKey?: string; noun: string; locations: Distributor[];
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [saved, setSaved] = useState<Saved[]>(() => (saveKey ? readSaved(`ka.scopes.${saveKey}`) : []));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  const shown = pool.filter(d => `${d.name} ${d.code} ${d.territory || ""} ${d.company_name || ""}`.toLowerCase().includes(q.toLowerCase()));
  const ids = new Set(value.ids);
  const toggle = (id: string) => onChange({ ...value, ids: ids.has(id) ? value.ids.filter(x => x !== id) : [...value.ids, id] });
  const pick = (list: Distributor[]) => onChange({ ...value, ids: list.map(d => d.id) });
  const top = (n: number) => pick([...pool].sort((a, b) => (rank?.get(b.id) || 0) - (rank?.get(a.id) || 0)).slice(0, n));
  function save() {
    const name = prompt("Name this selection (for example: Rajasthan key distributors)")?.trim();
    if (!name || !saveKey) return;
    const next = [...saved.filter(s => s.name !== name), { name, scope: value }];
    setSaved(next); writeSaved(`ka.scopes.${saveKey}`, next);
  }
  function unsave(name: string) {
    const next = saved.filter(s => s.name !== name);
    setSaved(next); if (saveKey) writeSaved(`ka.scopes.${saveKey}`, next);
  }
  const label = value.ids.length ? `${picked.length} of ${pool.length} ${noun}` : `All ${pool.length} ${noun}`;
  const known = new Set(locations.map(d => d.id));

  return <div className="picker" ref={ref}>
    <button type="button" className="secondary pickbtn" aria-expanded={open} onClick={() => setOpen(o => !o)}>{label} ▾</button>
    {open && <div className="pickpanel" role="dialog" aria-label={`Choose ${noun}`}>
      <input className="search" autoFocus placeholder={`Search ${noun}…`} value={q} onChange={e => setQ(e.target.value)} />
      <div className="quick">
        <button className="secondary small" onClick={() => pick([])}>All</button>
        <button className="secondary small" onClick={() => pick(shown)} disabled={!shown.length}>Only these {shown.length}</button>
        {rank && <button className="secondary small" onClick={() => top(10)}>Top 10 by stock value</button>}
        {rank && <button className="secondary small" onClick={() => pick(pool.filter(d => !(rank.get(d.id) || 0)))}>No stock</button>}
      </div>
      <div className="picklist">
        {shown.map(d => <label key={d.id} className="pickrow">
          <input type="checkbox" checked={ids.has(d.id)} onChange={() => toggle(d.id)} />
          <span>{d.name}</span><small>{d.code}{d.territory ? ` · ${d.territory}` : ""}{pool.some(x => x.kind !== d.kind) ? ` · ${KIND_LABEL[d.kind]}` : ""}</small>
        </label>)}
        {!shown.length && <p className="empty">Nothing matches.</p>}
      </div>
      {saveKey && <div className="saved">
        <div className="rowhead"><small>Saved selections</small><button className="link" onClick={save}>Save this selection</button></div>
        {saved.map(s => <span key={s.name} className="chip">
          <button className="link" onClick={() => { onChange({ ...s.scope, ids: s.scope.ids.filter(id => known.has(id)) }); setOpen(false); }}>{s.name}</button>
          <button className="x" aria-label={`Delete ${s.name}`} onClick={() => unsave(s.name)}>✕</button></span>)}
        {!saved.length && <small className="muted">None yet. Filter or tick locations, then save them here.</small>}
      </div>}
    </div>}
  </div>;
}
