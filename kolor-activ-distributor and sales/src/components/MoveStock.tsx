import { Select } from "./Select";
import { ask } from "../lib/ask";
import { useMemo, useState } from "react";
import { supabase, Distributor, Product, StockLine, KINDS, KIND_PLURAL, fmt, plural, errText } from "../lib/supabase";
import { today } from "../lib/parse";

interface Line { productId: string; qty: string }
interface Props { locations: Distributor[]; products: Product[]; stock: StockLine[]; onMoved: () => Promise<void>; notify: (m: string) => void }

/** Moves stock from one location to another: it goes down at one and up at the other, as a transfer. */
export default function MoveStock({ locations, products, stock, onMoved, notify }: Props) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(""), [to, setTo] = useState("");
  const [date, setDate] = useState(today()), [note, setNote] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const held = useMemo(() => new Map(stock.filter(s => s.distributor_id === from && Number(s.current_stock) > 0).map(s => [s.product_id, Number(s.current_stock)])), [stock, from]);
  const heldProducts = products.filter(p => held.has(p.id)).sort((a, b) => a.item_name.localeCompare(b.item_name));
  const fromLoc = locations.find(l => l.id === from), toLoc = locations.find(l => l.id === to);
  const options = (skip: string) => KINDS.map(k => <optgroup key={k} label={KIND_PLURAL[k]}>
    {locations.filter(d => d.kind === k && d.id !== skip).map(d => <option key={d.id} value={d.id}>{d.name} ({d.code})</option>)}</optgroup>);

  const problems = lines.map(l => {
    const q = Number(l.qty);
    if (!l.productId) return "pick a product";
    if (!(q > 0)) return "enter a quantity";
    if (q > (held.get(l.productId) || 0)) return `only ${fmt(held.get(l.productId))} there`;
    return "";
  });
  const units = lines.reduce((a, l) => a + (Number(l.qty) || 0), 0);
  const ready = fromLoc && toLoc && lines.length > 0 && problems.every(p => !p) && !busy;

  function pickFrom(id: string) { setFrom(id); setLines([]); setMsg(null); if (id === to) setTo(""); }
  function everything() { setLines(heldProducts.map(p => ({ productId: p.id, qty: String(held.get(p.id)) }))); }
  const setLine = (i: number, patch: Partial<Line>) => setLines(ls => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function save() {
    if (!supabase || !fromLoc || !toLoc || !ready) return;
    if (!await ask(`Move ${plural(units, "unit")} of ${plural(lines.length, "product")} from ${fromLoc.name} to ${toLoc.name}?`)) return;
    setBusy(true); setMsg(null);
    const rows = lines.map(l => {
      const p = products.find(x => x.id === l.productId)!;
      return { date, reference: note.trim() || "Stock moved", distributor: fromLoc.code, retailer: toLoc.code, sku: p.sku, item_name: p.item_name, quantity: Number(l.qty), unit_price: Number(p.unit_price) || 0 };
    });
    const { error } = await supabase.rpc("post_movements", { p_type: "OUT", p_rows: rows, p_holder: fromLoc.code, p_source_file: `Moved from ${fromLoc.name} to ${toLoc.name}`,
      p_file_hash: null, p_allow_duplicate: false, p_reduce_sender: true });
    setBusy(false);
    if (error) return setMsg({ kind: "err", text: `Couldn't move the stock: ${errText(error)}` });
    const text = `Moved ${plural(units, "unit")} of ${plural(lines.length, "product")} from ${fromLoc.name} to ${toLoc.name}. Undo is on the History page.`;
    setMsg({ kind: "ok", text }); notify(text); setLines([]); setNote("");
    await onMoved();
  }

  return <section className="card">
    <div className="rowhead"><div><h2>Move stock between locations</h2>
      <p className="hint">For stock that goes from one distributor, super stockist or godown to another outside your usual files, such as when a distributor closes.</p></div>
      <button className="secondary" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? "Hide" : "Move stock"}</button></div>
    {open && <>
      <div className="bulk">
        <label>From<Select value={from} onChange={e => pickFrom(e.target.value)}><option value="">Choose…</option>{options("")}</Select></label>
        <label>To<Select value={to} onChange={e => setTo(e.target.value)} disabled={!from}><option value="">Choose…</option>{options(from)}</Select></label>
        <label>Date<input type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)} /></label>
        <label>Note or invoice no.<input value={note} onChange={e => setNote(e.target.value)} placeholder="optional" /></label>
      </div>
      {from && !heldProducts.length && <p className="warn">{fromLoc?.name} has no stock in the app.</p>}
      {from && heldProducts.length > 0 && <>
        <div className="tablewrap"><table className="edit"><thead><tr><th>Product</th><th>There now</th><th>Move</th><th /></tr></thead>
          <tbody>{lines.map((l, i) => <tr key={i} className={problems[i] ? "bad" : ""}>
            <td><Select value={l.productId} onChange={e => setLine(i, { productId: e.target.value })}><option value="">Choose…</option>
              {heldProducts.map(p => <option key={p.id} value={p.id} disabled={p.id !== l.productId && lines.some(x => x.productId === p.id)}>{p.item_name}</option>)}</Select></td>
            <td>{l.productId ? fmt(held.get(l.productId)) : ""}</td>
            <td><input type="number" min={0} value={l.qty} onChange={e => setLine(i, { qty: e.target.value })} />{problems[i] && <small className="missing">{problems[i]}</small>}</td>
            <td><button className="del" aria-label="Remove line" onClick={() => setLines(ls => ls.filter((_, j) => j !== i))}>✕</button></td></tr>)}</tbody></table></div>
        <div className="actions wrap">
          <button className="secondary" onClick={() => setLines(ls => [...ls, { productId: "", qty: "" }])} disabled={lines.length >= heldProducts.length}>+ Add a product</button>
          <button className="secondary" onClick={everything}>Move everything it holds ({plural(heldProducts.length, "product")})</button>
          <button onClick={save} disabled={!ready}>{busy ? "Moving…" : lines.length ? `Move ${plural(units, "unit")}` : "Move stock"}</button>
        </div>
      </>}
      {msg && <div className={`status ${msg.kind}`}>{msg.text}</div>}
    </>}
  </section>;
}
