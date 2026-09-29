import { useEffect, useMemo, useState } from "react";
import { supabase, Distributor, Product, StockLine, fetchAll, fmt, money, plural, errText } from "../lib/supabase";
import { today } from "../lib/parse";
import { ask } from "../lib/ask";
import { runTask } from "../lib/tasks";
import { Select } from "./Select";

interface Line { productId: string; qty: string }
interface Returned { id: string; from_id: string | null; to_id: string | null; returned_on: string; reason: string; freight: number | null; note: string | null; quantity: number; value: number; days_held: number | null }
const REASONS = ["Didn't sell", "Quality issue", "Damaged in transit", "Near expiry", "Super stockist closing", "Other"];
const n = (v: unknown) => Number(v) || 0;

/** Stock a super stockist or distributor sends back: it leaves their stock and comes into the godown, with why and what it cost. */
export default function ReturnStock({ locations, products, stock, onSaved, notify }: { locations: Distributor[]; products: Product[]; stock: StockLine[]; onSaved: () => Promise<void>; notify: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const godowns = useMemo(() => locations.filter(l => l.kind === "GODOWN"), [locations]);
  const [from, setFrom] = useState(""), [to, setTo] = useState(""), [date, setDate] = useState(today());
  const [reason, setReason] = useState(REASONS[0]), [freight, setFreight] = useState(""), [note, setNote] = useState("");
  const [pieces, setPieces] = useState(false), [lines, setLines] = useState<Line[]>([]), [busy, setBusy] = useState(false);
  const [log, setLog] = useState<Returned[]>([]), [reload, setReload] = useState(0);
  useEffect(() => { if (!to && godowns[0]) setTo(godowns[0].id); }, [godowns]);
  useEffect(() => {
    if (!supabase || !open) return;
    fetchAll<Returned>((a, b) => supabase!.from("stock_returns").select("*").order("returned_on", { ascending: false }).order("id").range(a, b)).then(setLog).catch(() => setLog([]));
  }, [open, reload]);

  const held = useMemo(() => new Map(stock.filter(s => s.distributor_id === from && n(s.current_stock) > 0).map(s => [s.product_id, n(s.current_stock)])), [stock, from]);
  const heldProducts = products.filter(p => held.has(p.id)).sort((a, b) => a.item_name.localeCompare(b.item_name));
  const fromLoc = locations.find(l => l.id === from), toLoc = locations.find(l => l.id === to);
  const name = (id: string | null) => locations.find(l => l.id === id)?.name || "Deleted";
  const dz = (v: string) => (pieces ? n(v) / 12 : n(v));
  const problems = lines.map(l => !l.productId ? "pick a product" : !(n(l.qty) > 0) ? "enter a quantity" : dz(l.qty) > (held.get(l.productId) || 0) + 0.001 ? `only ${fmt(held.get(l.productId), 2)} dz there` : "");
  const total = lines.reduce((a, l) => a + dz(l.qty), 0);
  const ready = fromLoc && toLoc && lines.length > 0 && problems.every(p => !p) && !busy;
  const setLine = (i: number, patch: Partial<Line>) => setLines(ls => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function save() {
    if (!supabase || !ready || !fromLoc || !toLoc) return;
    if (!await ask(`Record ${fmt(total, 2)} dz (${fmt(Math.round(total * 12))} pieces) of ${plural(lines.length, "product")} returned from ${fromLoc.name} to ${toLoc.name} on ${date}?\n\nReason: ${reason}${freight ? `. Freight ₹${freight}` : ""}. It comes off ${fromLoc.name}'s stock and goes into ${toLoc.name}.`)) return;
    setBusy(true);
    try {
      const r = await runTask(`Recording the return from ${fromLoc.name}`, async () => {
        const { data, error } = await supabase!.rpc("post_return", { p_from: from, p_to: to, p_date: date, p_reason: reason, p_freight: freight ? n(freight) : null, p_note: note,
          p_lines: lines.map(l => ({ product_id: l.productId, qty: Math.round(dz(l.qty) * 1000) / 1000 })) });
        if (error) throw new Error(errText(error));
        return data as { lines: number; quantity: number; value: number };
      }, 0, r => `${fmt(r.quantity, 2)} dz worth ${money(r.value)} back in ${toLoc.name}.`);
      notify(`Recorded the return from ${fromLoc.name}: ${fmt(r.quantity, 2)} dz (${money(r.value)}) moved to ${toLoc.name}. Undo is on the History page.`);
      setLines([]); setNote(""); setFreight(""); setReload(x => x + 1);
      await onSaved();
    } catch (e) { notify(`Return not recorded: ${errText(e)}`); }
    finally { setBusy(false); }
  }

  const tot = log.reduce((a, r) => ({ q: a.q + n(r.quantity), v: a.v + n(r.value), f: a.f + n(r.freight), d: a.d + n(r.days_held) * n(r.quantity) }), { q: 0, v: 0, f: 0, d: 0 });
  return <section className="card">
    <div className="rowhead"><div><h2>Stock Returned To The Godown</h2>
      <p className="hint">When a super stockist or distributor sends stock back (it didn't sell, or had a quality problem), record it here: it comes off their stock and goes into your godown. Freight and how long it sat unsold are kept, so the cost of returns is visible.</p></div>
      <button className="secondary" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? "Hide" : "Record A Return"}</button></div>
    {open && <>
      <div className="bulk">
        <label>Returned by<Select value={from} onChange={e => { setFrom(e.target.value); setLines([]); }}><option value="">Choose…</option>
          <optgroup label="Super stockists">{locations.filter(l => l.kind === "SUPER_STOCKIST").map(l => <option key={l.id} value={l.id}>{l.name}{l.status === "DORMANT" ? " (dormant)" : ""}</option>)}</optgroup>
          <optgroup label="Distributors">{locations.filter(l => l.kind === "DISTRIBUTOR").map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</optgroup></Select></label>
        <label>Into<Select value={to} onChange={e => setTo(e.target.value)}><option value="">Choose…</option>{godowns.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</Select></label>
        <label>Date received back<input type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)} /></label>
        <label>Reason<Select value={reason} onChange={e => setReason(e.target.value)}>{REASONS.map(r => <option key={r} value={r}>{r}</option>)}</Select></label>
        <label>Freight, both ways (₹)<input inputMode="decimal" value={freight} onChange={e => setFreight(e.target.value)} placeholder="optional" /></label>
        <label>Note<input value={note} onChange={e => setNote(e.target.value)} placeholder="optional, e.g. challan no." /></label>
      </div>
      {!godowns.length && <p className="warn">Add your godown first (Distributors › Godowns), or upload SS billing, which adds one.</p>}
      {from && !heldProducts.length && <p className="warn">{fromLoc?.name} has no stock in the app.</p>}
      {from && heldProducts.length > 0 && <>
        <div className="unitpick"><span>Quantities in</span>
          <label className="inline"><input type="radio" checked={!pieces} onChange={() => setPieces(false)} /> Dozens</label>
          <label className="inline"><input type="radio" checked={pieces} onChange={() => setPieces(true)} /> Pieces</label></div>
        <div className="tablewrap"><table className="edit"><thead><tr><th>Product</th><th>They hold</th><th>Came back ({pieces ? "pcs" : "dz"})</th><th /></tr></thead>
          <tbody>{lines.map((l, i) => <tr key={i} className={problems[i] ? "bad" : ""}>
            <td><Select value={l.productId} onChange={e => setLine(i, { productId: e.target.value })}><option value="">Choose…</option>
              {heldProducts.map(p => <option key={p.id} value={p.id} disabled={p.id !== l.productId && lines.some(x => x.productId === p.id)}>{p.item_name}</option>)}</Select></td>
            <td>{l.productId ? `${fmt(held.get(l.productId), 2)} dz · ${fmt(Math.round((held.get(l.productId) || 0) * 12))} pcs` : ""}</td>
            <td><input type="number" min={0} value={l.qty} onChange={e => setLine(i, { qty: e.target.value })} />{problems[i] && <small className="missing">{problems[i]}</small>}</td>
            <td><button className="del" aria-label="Remove line" onClick={() => setLines(ls => ls.filter((_, j) => j !== i))}>✕</button></td></tr>)}</tbody></table></div>
        <div className="actions wrap">
          <button className="secondary" onClick={() => setLines(ls => [...ls, { productId: "", qty: "" }])} disabled={lines.length >= heldProducts.length}>+ Add A Product</button>
          <button className="secondary" onClick={() => setLines(heldProducts.map(p => ({ productId: p.id, qty: String(pieces ? Math.round((held.get(p.id) || 0) * 12) : held.get(p.id)) })))}>Everything They Hold ({plural(heldProducts.length, "Product")})</button>
          <button onClick={save} disabled={!ready}>{busy ? "Saving…" : lines.length ? `Record ${fmt(total, 2)} dz Returned` : "Record Return"}</button>
        </div>
      </>}
      {log.length > 0 && <>
        <h3>Returns So Far</h3>
        <div className="cards">
          <div className="metric"><small>Stock returned</small><b>{fmt(tot.q, 1)} dz</b><span className="muted">{money(tot.v)} at SS rate</span></div>
          <div className="metric"><small>Freight paid on returns</small><b>{money(tot.f)}</b></div>
          <div className="metric"><small>Sat unsold, on average</small><b>{tot.q ? `${fmt(tot.d / tot.q)} days` : "—"}</b><span className="muted">since it last reached them</span></div>
        </div>
        <div className="tablewrap scrolltable short"><table className="nice"><thead><tr><th>Date</th><th>From</th><th>Into</th><th>Reason</th><th>Dozens</th><th>Pieces</th><th>Value</th><th>Freight</th><th>Days unsold</th><th>Note</th></tr></thead>
          <tbody>{log.map(r => <tr key={r.id}><td>{r.returned_on}</td><td>{name(r.from_id)}</td><td>{name(r.to_id)}</td><td>{r.reason}</td><td>{fmt(r.quantity, 2)}</td><td>{fmt(Math.round(n(r.quantity) * 12))}</td>
            <td>{money(r.value)}</td><td>{r.freight !== null ? money(r.freight) : "—"}</td><td>{r.days_held ?? "—"}</td><td className="wrap">{r.note}</td></tr>)}</tbody></table></div>
      </>}
    </>}
  </section>;
}
