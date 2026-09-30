import { useMemo, useState } from "react";
import { supabase, Product, errText } from "../lib/supabase";
import { sameProductName } from "../lib/fuzzy";
import { ask } from "../lib/ask";
import { runTask } from "../lib/tasks";
import { Select } from "./Select";

const HIDE_KEY = "merge-products-different";
const readHidden = (): string[] => { try { return JSON.parse(localStorage.getItem(HIDE_KEY) || "[]"); } catch { return []; } };

/** One SKU entered under two names (a stock file's spelling and the price list's): merge them into one. */
export default function MergeProducts({ products, canManage, onMerged, notify }: { products: Product[]; canManage: boolean; onMerged: () => Promise<void>; notify: (m: string) => void }) {
  const [open, setOpen] = useState(false), [keep, setKeep] = useState(""), [drop, setDrop] = useState(""), [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(readHidden()));
  // The entry with a price on it is kept.
  const weight = (p: Product) => (p.ss_rate ? 4 : 0) + (p.mrp ? 2 : 0) + (p.category ? 1 : 0);
  const pairs = useMemo(() => {
    const out: [Product, Product][] = [];
    for (let i = 0; i < products.length; i++) for (let j = i + 1; j < products.length; j++) {
      const a = products[i], b = products[j];
      if ((a.category || "") !== (b.category || "") || !sameProductName(a.item_name, b.item_name)) continue;
      out.push(weight(a) > weight(b) || (weight(a) === weight(b) && a.item_name.length <= b.item_name.length) ? [a, b] : [b, a]);
    }
    return out;
  }, [products]);
  const shown = pairs.filter(([a, b]) => !hidden.has(`${a.id}|${b.id}`) && !hidden.has(`${b.id}|${a.id}`));
  const different = (a: Product, b: Product) => setHidden(h => {
    const n = new Set(h).add(`${a.id}|${b.id}`);
    try { localStorage.setItem(HIDE_KEY, JSON.stringify([...n])); } catch { /* not remembered next time */ }
    return n;
  });

  async function merge(k: Product, d: Product) {
    if (!supabase) return;
    if (!await ask(`Merge "${d.item_name}" into "${k.item_name}"?\n\nThey become one SKU: stock, billing, stock counts and SO reports for "${d.item_name}" move to "${k.item_name}", and "${d.item_name}" is kept as another name so files match it. Where a distributor counted the SKU under both names, each count is taken as a count of the one SKU, so stock isn't added up twice. This can't be undone.`, { ok: "Merge" })) return;
    setBusy(true);
    try {
      await runTask(`Merging ${d.item_name} into ${k.item_name}`, async () => {
        const { error } = await supabase!.rpc("merge_products", { p_keep: k.id, p_drop: d.id });
        if (error) throw new Error(`${errText(error)}. Run database step 012.`);
      }, 0, () => `${d.item_name} is now part of ${k.item_name}.`);
      notify(`Merged ${d.item_name} into ${k.item_name}.`);
      setKeep(""); setDrop("");
      await onMerged();
    } catch (e) { notify(`Not merged: ${errText(e)}`); }
    finally { setBusy(false); }
  }
  const byId = (id: string) => products.find(p => p.id === id);
  const sorted = useMemo(() => [...products].sort((a, b) => a.item_name.localeCompare(b.item_name)), [products]);
  const options = (skip: string) => sorted.filter(p => p.id !== skip).map(p => <option key={p.id} value={p.id}>{p.item_name}{p.category ? ` · ${p.category}` : ""}</option>);
  const rate = (p: Product) => (p.ss_rate ? ` · SS ₹${p.ss_rate}/dz` : "");

  if (!canManage) return null;
  return <section className="card">
    <div className="rowhead"><div><h2>Merge Two SKUs{shown.length ? <em className="tag warn"> {shown.length} look alike</em> : null}</h2>
      <p className="hint">When one SKU is in the list twice (a stock file spelt it differently, say "Strawberry Blast Tube" and "Strawberry Blast Tube 10 Gm"), merge them so its stock is added up in one place. Different sizes are never suggested.</p></div>
      <button className="secondary" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? "Hide" : "Merge"}</button></div>
    {open && <>
      {shown.length > 0 && <div className="tablewrap scrolltable short"><table className="nice"><thead><tr><th>Keep</th><th>Merge into it</th><th /></tr></thead>
        <tbody>{shown.slice(0, 40).map(([a, b]) => <tr key={a.id + b.id}>
          <td><b>{a.item_name}</b><small className="muted"> {a.category || "No category"}{rate(a)}</small></td>
          <td><b>{b.item_name}</b><small className="muted">{rate(b)}</small></td>
          <td className="actions"><button className="small" disabled={busy} onClick={() => merge(a, b)}>Same: Merge</button>
            <button className="secondary small" disabled={busy} onClick={() => merge(b, a)} title="Keep the right-hand name instead">Keep This Name</button>
            <button className="secondary small" onClick={() => different(a, b)}>Different</button></td></tr>)}</tbody></table></div>}
      <div className="bulk">
        <label>Keep<Select value={keep} onChange={e => setKeep(e.target.value)}><option value="">Choose…</option>{options(drop)}</Select></label>
        <label>Merge this into it<Select value={drop} onChange={e => setDrop(e.target.value)}><option value="">Choose…</option>{options(keep)}</Select></label>
      </div>
      <div className="actions"><button disabled={busy || !keep || !drop} onClick={() => { const k = byId(keep), d = byId(drop); if (k && d) merge(k, d); }}>Merge</button></div>
    </>}
  </section>;
}
