import { Select } from "./Select";
import { useEffect, useRef, useState } from "react";
import { supabase, Distributor, StockLine, KINDS, KIND_LABEL, KIND_PLURAL, money, plural, errText } from "../lib/supabase";

interface Props {
  location: Distributor; locations: Distributor[]; stock: StockLine[]; retailers: number; comments: number; testingMode: boolean;
  onClose: () => void; onDeleted: (message: string) => Promise<void>;
}

/** Deleting a location: move its stock (and its distributors, for a super stockist) first, or let them go with it. */
export default function DeleteLocation({ location: d, locations, stock, retailers, comments, testingMode, onClose, onDeleted }: Props) {
  const lines = stock.filter(s => s.distributor_id === d.id && Number(s.current_stock) > 0);
  const units = lines.reduce((a, s) => a + Number(s.current_stock), 0), value = lines.reduce((a, s) => a + Number(s.stock_value), 0);
  const kids = locations.filter(l => l.parent_id === d.id);
  const [stockTo, setStockTo] = useState(""), [discard, setDiscard] = useState(false);
  const [kidsTo, setKidsTo] = useState("");
  const [dropProducts, setDropProducts] = useState(testingMode);
  const [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    (first.current as HTMLElement | null)?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, []);
  const needsChoice = units > 0 && !discard && !stockTo;
  const others = (kinds: typeof KINDS) => kinds.map(k => <optgroup key={k} label={KIND_PLURAL[k]}>
    {locations.filter(l => l.kind === k && l.id !== d.id).map(l => <option key={l.id} value={l.id}>{l.name} ({l.code})</option>)}</optgroup>);

  async function remove() {
    if (!supabase || needsChoice) return;
    setBusy(true); setErr("");
    const { data, error } = await supabase.rpc("delete_location", { p_location: d.id, p_move_to: units > 0 && !discard ? stockTo : null,
      p_children_to: kidsTo || null, p_drop_unused_products: dropProducts });
    setBusy(false);
    if (error) return setErr(errText(error));
    const dest = locations.find(l => l.id === stockTo);
    const r = data as { moved_units: number; moved_distributors: number; deleted_products: number };
    await onDeleted(`Deleted ${d.name}.${Number(r.moved_units) ? ` ${plural(Number(r.moved_units), "unit")} of stock moved to ${dest?.name}.` : ""}${r.moved_distributors ? ` ${plural(r.moved_distributors, "distributor")} moved to ${locations.find(l => l.id === kidsTo)?.name}.` : ""}${r.deleted_products ? ` ${plural(r.deleted_products, "unused product")} deleted.` : ""}`);
  }

  return <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="overlaypanel confirm" role="dialog" aria-modal="true" aria-labelledby="del-title">
      <header><div><h2 id="del-title">Delete {d.name} ({d.code})?</h2>
        <p className="subtitle">{KIND_LABEL[d.kind]}{d.territory ? ` in ${d.territory}` : ""}. Its stock lines, SO report lines, {plural(retailers, "retailer")} and {plural(comments, "comment")} are deleted with it. This can't be undone.</p></div></header>
      <div className="confirmbody">
        {units > 0 && <fieldset>
          <legend>It holds {plural(units, "unit")} of {plural(lines.length, "product")} ({money(value)}). What happens to that stock?</legend>
          <label className="inline"><input type="radio" name="stock" checked={!discard} onChange={() => setDiscard(false)} /> Move it to</label>
          <Select ref={first} value={stockTo} disabled={discard} onChange={e => setStockTo(e.target.value)}>
            <option value="">choose where…</option>{others(KINDS)}</Select>
          <label className="inline"><input type="radio" name="stock" checked={discard} onChange={() => setDiscard(true)} /> Delete it along with {d.name}{testingMode ? " (test data)" : ""}</label>
        </fieldset>}
        {kids.length > 0 && <fieldset>
          <legend>{plural(kids.length, "distributor")} work{kids.length === 1 ? "s" : ""} under this super stockist.</legend>
          <Select value={kidsTo} onChange={e => setKidsTo(e.target.value)}>
            <option value="">Leave them without a super stockist for now</option>
            {locations.filter(l => l.kind === "SUPER_STOCKIST" && l.id !== d.id).map(l => <option key={l.id} value={l.id}>Move them to {l.name}</option>)}</Select>
        </fieldset>}
        <label className="inline"><input type="checkbox" checked={dropProducts} onChange={e => setDropProducts(e.target.checked)} /> Also delete products that nothing else uses afterwards</label>
        {err && <div className="status err">{err}</div>}
      </div>
      <div className="actions end">
        <button className="secondary" ref={units > 0 ? undefined : (first as React.RefObject<HTMLButtonElement>)} onClick={onClose}>Cancel</button>
        <button className="danger" disabled={busy || needsChoice} onClick={remove}>{busy ? "Deleting…" : `Delete ${d.name}`}</button>
      </div>
      {needsChoice && <p className="hint end">Choose where its stock goes, or to delete it.</p>}
    </div>
  </div>;
}

