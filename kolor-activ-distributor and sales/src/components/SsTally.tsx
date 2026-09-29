import { useEffect, useMemo, useState } from "react";
import { supabase, Distributor, Product, fetchAll, fmt, money, errText } from "../lib/supabase";
import DateRange, { PRESETS, Range } from "./DateRange";
import { startTask } from "../lib/tasks";

interface Period { location_id: string; product_id: string; opening: number; in_purchase: number; in_transfer: number; in_count: number; out_sale: number; out_transfer: number; out_count: number; closing: number }
interface Status { location_id: string; last_count: string | null }
const n = (v: unknown) => Number(v) || 0;
const dz = (v: number) => `${fmt(v, 1)} dz`;
const pcs = (v: number) => fmt(Math.round(v * 12));

/** Company billing against each super stockist's stock counts: what they were billed, what they report holding, and the gap. */
export default function SsTally({ locations, products, refresh }: { locations: Distributor[]; products: Product[]; refresh: unknown }) {
  const [range, setRange] = useState<Range>(() => PRESETS.find(p => p.id === "fy")!.range()), [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Period[] | null>(null), [status, setStatus] = useState<Map<string, string | null>>(new Map()), [err, setErr] = useState("");
  const supers = useMemo(() => locations.filter(l => l.kind === "SUPER_STOCKIST"), [locations]);
  const prod = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);
  useEffect(() => {
    if (!supabase || !open) return;
    if (!supers.length) { setRows([]); return; }
    let live = true;
    const task = startTask("Tallying billing against SS stock", 0, true);
    Promise.all([
      fetchAll<Period>((a, b) => supabase!.rpc("stock_period", { p_from: range.from, p_to: range.to, p_locations: supers.map(s => s.id) }).range(a, b)),
      fetchAll<Status>((a, b) => supabase!.from("location_data_status").select("location_id,last_count").order("location_id").range(a, b)),
    ]).then(([p, s]) => { if (!live) return; setRows(p); setStatus(new Map(s.map(x => [x.location_id, x.last_count]))); setErr(""); task.ok(); })
      .catch(e => { if (live) { setErr(errText(e)); setRows([]); } task.fail(errText(e)); });
    return () => { live = false; task.cancel(); };
  }, [range.from, range.to, supers, refresh, open]);

  // Per SS: billed, other stock in, recorded sales on, the gap found at stock counts, and stock now.
  const bySs = useMemo(() => {
    const m = new Map<string, { ss: Distributor; lines: (Period & { name: string; category: string; rate: number; gap: number })[] }>();
    (rows || []).forEach(r => {
      const ss = supers.find(s => s.id === r.location_id); if (!ss) return;
      const p = prod.get(r.product_id);
      const e = m.get(ss.id) || { ss, lines: [] };
      e.lines.push({ ...r, name: p?.item_name || "Deleted product", category: p?.category || "Other", rate: n(p?.unit_price), gap: n(r.in_count) - n(r.out_count) });
      m.set(ss.id, e);
    });
    return [...m.values()].map(e => {
      const sum = (k: keyof Period | "gap") => e.lines.reduce((a, l) => a + n(l[k as keyof typeof l]), 0);
      const value = (k: keyof Period | "gap") => e.lines.reduce((a, l) => a + n(l[k as keyof typeof l]) * l.rate, 0);
      return { ...e, billed: sum("in_purchase"), billedV: value("in_purchase"), other: sum("in_transfer"), out: sum("out_sale") + sum("out_transfer"), gap: sum("gap"), gapV: value("gap"), now: sum("closing"), nowV: value("closing"), opening: sum("opening") };
    }).filter(e => e.billed || e.now || e.gap).sort((a, b) => b.billedV - a.billedV);
  }, [rows, supers, prod]);

  return <section className="card">
    <div className="rowhead"><div><h2>Super Stockists: What We Billed Vs What They Hold</h2>
      <p className="hint">Checks each super stockist's closing stock against the company's bills to them. Billed stock should either still be with them or have gone on to their distributors; a minus gap is stock that isn't accounted for.</p></div>
      <div className="actions">{open && <DateRange value={range} onChange={setRange} />}<button className="secondary" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? "Hide" : "Show"}</button></div></div>
    {open && err && <div className="status err">{err}</div>}
    {open && <>
    {!rows ? <p className="empty">Adding up billing and stock…</p> : !bySs.length ? <p className="empty">No company billing or stock for super stockists in this period. Upload the SS billing sheet under Upload Stock Files above.</p> :
      <div className="sk-cats">{bySs.map(e => {
        const cats = [...e.lines.reduce((m, l) => m.set(l.category, [...(m.get(l.category) || []), l]), new Map<string, typeof e.lines>())].sort((a, b) => b[1].reduce((t, l) => t + n(l.in_purchase) * l.rate, 0) - a[1].reduce((t, l) => t + n(l.in_purchase) * l.rate, 0));
        const last = status.get(e.ss.id);
        return <details key={e.ss.id}>
          <summary><b>{e.ss.name}<small className="muted"> · {[e.ss.territory, e.ss.state].filter(Boolean).join(", ")}</small></b>
            <span>billed {dz(e.billed)} · {money(e.billedV)}</span>
            <span className={e.gap < -0.05 ? "err" : ""}>{last ? `gap at counts ${e.gap > 0 ? "+" : ""}${dz(e.gap)}` : "no stock count yet"}</span></summary>
          <div className="tallybody">
            <p className="hint">Last stock count: {last || "none received"}. Stock now {dz(e.now)} ({pcs(e.now)} pcs, {money(e.nowV)}).{e.other ? ` Also received ${dz(e.other)} from other locations.` : ""}{e.out ? ` Sent on (recorded): ${dz(e.out)}.` : " No sales to distributors recorded for this SS."}</p>
            {cats.map(([cat, list]) => <details key={cat}><summary><b>{cat}</b><span>billed {dz(list.reduce((a, l) => a + n(l.in_purchase), 0))}</span><span>gap {dz(list.reduce((a, l) => a + l.gap, 0))}</span></summary>
              <div className="tablewrap"><table><thead><tr><th>SKU</th><th>Start (dz)</th><th>Billed (dz)</th><th>Billed (pcs)</th><th>Sent On (dz)</th><th>Gap At Counts (dz)</th><th>Now (dz)</th><th>Now (pcs)</th></tr></thead>
                <tbody>{list.sort((a, b) => n(b.in_purchase) - n(a.in_purchase)).map(l => <tr key={l.product_id} className={l.gap < -0.05 ? "flagged" : ""}><td>{l.name}</td><td>{fmt(l.opening, 1)}</td><td>{fmt(l.in_purchase, 1)}</td><td>{pcs(n(l.in_purchase))}</td>
                  <td>{fmt(n(l.out_sale) + n(l.out_transfer), 1)}</td><td className={l.gap < -0.05 ? "out" : l.gap > 0.05 ? "in" : ""}>{l.gap ? fmt(l.gap, 1) : "—"}</td><td>{fmt(l.closing, 1)}</td><td>{pcs(n(l.closing))}</td></tr>)}</tbody></table></div></details>)}
          </div></details>;
      })}</div>}
    </>}
  </section>;
}
