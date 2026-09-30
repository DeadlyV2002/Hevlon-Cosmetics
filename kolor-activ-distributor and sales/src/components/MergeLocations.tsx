import { useMemo, useState } from "react";
import { supabase, Distributor, StockLine, KIND_LABEL, plural, errText } from "../lib/supabase";
import { normName } from "../lib/parse";
import { nameScore, sameState } from "../lib/dsrLink";
import { ask } from "../lib/ask";
import { runTask } from "../lib/tasks";
import { Select } from "./Select";

/** Two entries for the same distributor or super stockist (for example one from the DB List and one made by a billing upload): merge them into one. */
export default function MergeLocations({ locations, stock, onMerged, notify }: { locations: Distributor[]; stock: StockLine[]; onMerged: () => Promise<void>; notify: (m: string) => void }) {
  const [open, setOpen] = useState(false), [keep, setKeep] = useState(""), [drop, setDrop] = useState(""), [busy, setBusy] = useState(false), [hidden, setHidden] = useState<Set<string>>(new Set());
  const held = useMemo(() => { const m = new Map<string, number>(); stock.forEach(s => m.set(s.distributor_id, (m.get(s.distributor_id) || 0) + Math.abs(Number(s.current_stock) || 0))); return m; }, [stock]);
  const kids = useMemo(() => { const m = new Map<string, number>(); locations.forEach(l => { if (l.parent_id) m.set(l.parent_id, (m.get(l.parent_id) || 0) + 1); }); return m; }, [locations]);
  // The entry with more attached to it is kept.
  const weight = (l: Distributor) => (kids.get(l.id) || 0) * 1000 + (held.get(l.id) || 0);
  // Pairs of the same kind, in the same state, whose names are nearly the same.
  const pairs = useMemo(() => {
    const out: [Distributor, Distributor][] = [];
    if (!open) return out;
    for (let i = 0; i < locations.length; i++) for (let j = i + 1; j < locations.length; j++) {
      const a = locations[i], b = locations[j];
      if (a.kind !== b.kind || !sameState(a.state, b.state)) continue;
      if (Math.max(nameScore(a.name, b), nameScore(b.name, a)) < 0.85 && normName(a.name) !== normName(b.name)) continue;
      out.push(weight(a) >= weight(b) ? [a, b] : [b, a]);
    }
    return out;
  }, [locations, held, kids, open]);
  const shown = pairs.filter(([a, b]) => !hidden.has(`${a.id}|${b.id}`));

  async function merge(k: Distributor, d: Distributor) {
    if (!supabase) return;
    if (!await ask(`Merge "${d.name}" (${d.code}) into "${k.name}" (${k.code})?\n\nEverything recorded for ${d.name} (stock, bills, payments, SO reports, retailers and distributors under it) moves to ${k.name}, and "${d.name}" is kept as another name so files match it. This can't be undone.`, { ok: "Merge" })) return;
    setBusy(true);
    try {
      await runTask(`Merging ${d.name} into ${k.name}`, async () => {
        const { error } = await supabase!.rpc("merge_locations", { p_keep: k.id, p_drop: d.id });
        if (error) throw new Error(`${errText(error)}. Run database step 012.`);
      }, 0, () => `${d.name} is now part of ${k.name}.`);
      notify(`Merged ${d.name} into ${k.name}.`);
      setKeep(""); setDrop("");
      await onMerged();
    } catch (e) { notify(`Not merged: ${errText(e)}`); }
    finally { setBusy(false); }
  }
  const byId = (id: string) => locations.find(l => l.id === id);
  const options = (skip: string) => (["SUPER_STOCKIST", "DISTRIBUTOR", "GODOWN"] as const).map(k => <optgroup key={k} label={KIND_LABEL[k]}>
    {locations.filter(l => l.kind === k && l.id !== skip).map(l => <option key={l.id} value={l.id}>{l.name} ({l.code}){l.territory ? ` · ${l.territory}` : ""}{l.state ? ` · ${l.state}` : ""}</option>)}</optgroup>);

  return <section className="card">
    <div className="rowhead"><div><h2>Merge Two Entries{shown.length ? ` (${shown.length} look alike)` : ""}</h2>
      <p className="hint">When the same distributor or super stockist is in the list twice (spelt differently, or added again by an upload), merge them: everything moves to the one you keep.</p></div>
      <button className="secondary" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? "Hide" : "Merge"}</button></div>
    {open && <>
      {shown.length > 0 && <div className="tablewrap scrolltable short"><table className="nice"><thead><tr><th>Keep</th><th>Merge into it</th><th /></tr></thead>
        <tbody>{shown.slice(0, 30).map(([a, b]) => <tr key={a.id + b.id}>
          <td><b>{a.name}</b><small className="muted"> {a.code} · {KIND_LABEL[a.kind]}{a.territory ? ` · ${a.territory}` : ""} · {plural(kids.get(a.id) || 0, "distributor")} under it</small></td>
          <td><b>{b.name}</b><small className="muted"> {b.code}{b.territory ? ` · ${b.territory}` : ""} · {plural(kids.get(b.id) || 0, "distributor")} under it</small></td>
          <td className="actions"><button className="small" disabled={busy} onClick={() => merge(a, b)}>Same: Merge</button>
            <button className="secondary small" onClick={() => setHidden(h => new Set(h).add(`${a.id}|${b.id}`))}>Different</button></td></tr>)}</tbody></table></div>}
      <div className="bulk">
        <label>Keep<Select value={keep} onChange={e => setKeep(e.target.value)}><option value="">Choose…</option>{options(drop)}</Select></label>
        <label>Merge this into it<Select value={drop} onChange={e => setDrop(e.target.value)}><option value="">Choose…</option>{options(keep)}</Select></label>
      </div>
      <div className="actions"><button disabled={busy || !keep || !drop} onClick={() => { const k = byId(keep), d = byId(drop); if (k && d) merge(k, d); }}>Merge</button></div>
    </>}
  </section>;
}
