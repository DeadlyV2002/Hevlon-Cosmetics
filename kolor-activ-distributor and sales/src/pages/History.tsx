import { Fragment, useEffect, useState } from "react";
import { supabase, fmt, errText } from "../lib/supabase";

interface Batch { id: string; created_at: string; mode: string; source_file: string | null; distributor_name: string | null; lines: number; units_in: number; units_out: number; transfer_lines: number }
interface Line { id: string; transaction_date: string; mode: string; source: string | null; quantity: number; unit_price: number; reference: string | null; distributor_name: string; sku: string; item_name: string; retailer_name: string | null; counterparty_name: string | null; party: string | null }
const MODE_LABEL: Record<string, string> = { INPUT: "Stock received", OUTPUT: "Stock sent out", COUNT: "Stock count" };
const HOW: Record<string, string> = { PURCHASE: "purchase", SALE: "sale", TRANSFER: "transfer", COUNT: "count" };

export default function History({ canManage, onChanged, notify }: { canManage: boolean; onChanged: () => Promise<void>; notify: (m: string) => void }) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);

  async function load() {
    if (!supabase) return;
    const { data, error } = await supabase.from("inventory_batch_summary").select("*").order("created_at", { ascending: false }).limit(200);
    if (error) notify(`Could not load history: ${error.message}`); else setBatches(data as Batch[]);
  }
  useEffect(() => { load(); }, []);

  async function show(id: string) {
    if (open === id) return setOpen(null);
    setOpen(id); setLines([]);
    const { data, error } = await supabase!.from("inventory_history").select("*").eq("batch_id", id).order("item_name").order("id").limit(5000);
    if (error) notify(error.message); else setLines(data as Line[]);
  }
  async function undo(b: Batch) {
    if (!confirm(`Undo this ${MODE_LABEL[b.mode]?.toLowerCase()} posting from ${new Date(b.created_at).toLocaleString("en-IN")}?\n${b.lines} lines will be removed and stock recalculated${b.transfer_lines ? ", at both ends of each transfer" : ""}.`)) return;
    const { error } = await supabase!.rpc("delete_inventory_batch", { p_batch: b.id });
    if (error) return notify(`Undo failed: ${errText(error)}`);
    notify("Posting undone."); setOpen(null); await load(); await onChanged();
  }

  return <section className="card">
    <div className="rowhead"><h2>Postings</h2><button className="secondary" onClick={load}>Refresh</button></div>
    <p className="hint">Every upload or manual entry is one posting. Click a posting to see its lines.{canManage ? " Undo removes it completely (blocked if stock from it was already sold)." : ""}</p>
    <div className="tablewrap"><table><thead><tr><th>When</th><th>Type</th><th>Location</th><th>File</th><th>Lines</th><th>Units in</th><th>Units out</th>{canManage && <th />}</tr></thead>
      <tbody>{batches.map(b => <Fragment key={b.id}>
        <tr className="clickable" onClick={() => show(b.id)}>
          <td>{open === b.id ? "▾" : "▸"} {new Date(b.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</td>
          <td><span className={`pill ${b.mode.toLowerCase()}`}>{MODE_LABEL[b.mode] || b.mode}</span>{b.transfer_lines ? <span className="pill count">transfers</span> : null}</td>
          <td>{b.distributor_name || "several"}</td><td className="wrap">{b.source_file}</td><td>{b.lines}</td>
          <td className="in">{Number(b.units_in) ? `+${fmt(b.units_in)}` : ""}</td><td className="out">{Number(b.units_out) ? `-${fmt(b.units_out)}` : ""}</td>
          {canManage && <td><button className="secondary small" onClick={e => { e.stopPropagation(); undo(b); }}>Undo</button></td>}
        </tr>
        {open === b.id && <tr><td colSpan={8} className="sub">
          {!lines.length ? "Loading…" : <table><thead><tr><th>Date</th><th>Location</th><th>How</th><th>SKU</th><th>Product</th><th>Qty</th><th>Rate</th><th>Ref</th><th>From / to</th></tr></thead>
            <tbody>{lines.map(l => <tr key={l.id}><td>{l.transaction_date}</td><td>{l.distributor_name}</td><td>{HOW[l.source || ""] || ""}</td><td>{l.sku}</td><td>{l.item_name}</td>
              <td className={l.mode === "INPUT" ? "in" : "out"}>{l.mode === "INPUT" ? "+" : "-"}{fmt(l.quantity, 2).replace(/\.00$/, "")}</td><td>{fmt(l.unit_price, 2)}</td><td>{l.reference}</td>
              <td>{l.counterparty_name || l.retailer_name || l.party}</td></tr>)}</tbody></table>}
        </td></tr>}
      </Fragment>)}</tbody></table>
      {!batches.length && <p className="empty">Nothing posted yet.</p>}</div>
  </section>;
}
