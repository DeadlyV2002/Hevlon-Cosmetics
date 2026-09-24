import { useMemo } from "react";
import type { Page } from "../App";
import { Distributor, Product, StockLine, Kind, KIND_PLURAL, missingFields, fmt, money } from "../lib/supabase";
import BarChart from "../components/BarChart";
import { TYPE_SERIES, seriesIndex } from "./Reports";

interface Batch { id: string; created_at: string; mode: string; distributor_name: string | null; source_file: string | null; lines: number; transfer_lines?: number }
const MODE_LABEL: Record<string, string> = { INPUT: "Stock received", OUTPUT: "Stock sent out", COUNT: "Stock count" };

export default function Dashboard({ stock, locations, products, recent, go }: { stock: StockLine[]; locations: Distributor[]; products: Product[]; recent: Batch[]; go: (p: Page) => void }) {
  const byId = useMemo(() => new Map(locations.map(d => [d.id, d])), [locations]);
  const byKind = useMemo(() => {
    const m: Record<Kind, { units: number; value: number; n: number }> = { GODOWN: { units: 0, value: 0, n: 0 }, SUPER_STOCKIST: { units: 0, value: 0, n: 0 }, DISTRIBUTOR: { units: 0, value: 0, n: 0 } };
    locations.forEach(d => m[d.kind].n++);
    stock.forEach(s => { const d = byId.get(s.distributor_id); if (!d) return; m[d.kind].units += Number(s.current_stock); m[d.kind].value += Number(s.stock_value); });
    return m;
  }, [stock, locations, byId]);
  const byState = useMemo(() => {
    const m = new Map<string, number[]>();
    stock.forEach(s => {
      const d = byId.get(s.distributor_id), st = d?.state || "No state";
      const seg = m.get(st) || [0, 0, 0];
      seg[seriesIndex(d)] += Number(s.stock_value);
      m.set(st, seg);
    });
    return [...m.entries()].map(([st, seg]) => ({ key: st, label: st, segments: seg }));
  }, [stock, byId]);
  const total = byKind.GODOWN.value + byKind.SUPER_STOCKIST.value + byKind.DISTRIBUTOR.value;
  const totalUnits = byKind.GODOWN.units + byKind.SUPER_STOCKIST.units + byKind.DISTRIBUTOR.units;
  const incomplete = locations.filter(d => missingFields(d).length).length;
  const withStock = new Set(stock.filter(s => Number(s.current_stock)).map(s => s.distributor_id));
  const noStock = locations.filter(d => d.kind !== "GODOWN" && !withStock.has(d.id)).length;

  return <>
    <section className="hero">
      <small>Stock value across India</small>
      <b>{money(total)}</b>
      <small>{fmt(totalUnits)} units · {products.length} products · at the latest purchase rate</small>
    </section>
    <div className="cards">
      {(["GODOWN", "SUPER_STOCKIST", "DISTRIBUTOR"] as Kind[]).map(k => <div className="metric" key={k}>
        <small>At {KIND_PLURAL[k].toLowerCase()} ({byKind[k].n})</small><b>{money(byKind[k].value)}</b>
        <small>{fmt(byKind[k].units)} units{total ? ` · ${Math.round((byKind[k].value / total) * 100)}% of all stock` : ""}</small></div>)}
    </div>
    {(incomplete > 0 || noStock > 0) && <div className="notice static">
      {incomplete > 0 && <span>{incomplete} location{incomplete > 1 ? "s have" : " has"} empty details. <button className="link" onClick={() => go("Distributors")}>Fill them in</button></span>}
      {noStock > 0 && <span>{noStock} distributor{noStock > 1 ? "s" : ""} / super stockist{noStock > 1 ? "s have" : " has"} no stock in the app. <button className="link" onClick={() => go("Inventory")}>Upload their stock</button></span>}
    </div>}
    <section className="card"><div className="rowhead"><h2>Stock value by state</h2><button className="secondary" onClick={() => go("Reports")}>Open reports</button></div>
      <BarChart title="Stock value by state, split by godowns, super stockists and distributors" series={TYPE_SERIES} bars={byState} format={money} limit={12} />
      <div className="tablewrap"><table><thead><tr><th>State</th>{TYPE_SERIES.map(s => <th key={s}>{s} ₹</th>)}<th>Total ₹</th></tr></thead>
        <tbody>{[...byState].sort((a, b) => b.segments.reduce((x, y) => x + y, 0) - a.segments.reduce((x, y) => x + y, 0)).map(r => <tr key={r.key}><td><b>{r.label}</b></td>
          {r.segments.map((v, i) => <td key={i}>{fmt(v)}</td>)}<td><b>{fmt(r.segments.reduce((x, y) => x + y, 0))}</b></td></tr>)}</tbody></table></div>
    </section>
    <section className="card"><div className="rowhead"><h2>Recent postings</h2><button className="secondary" onClick={() => go("History")}>All history</button></div>
      {recent.length ? <div className="tablewrap"><table><tbody>{recent.map(b => <tr key={b.id}><td>{new Date(b.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</td>
        <td><span className={`pill ${String(b.mode).toLowerCase()}`}>{MODE_LABEL[b.mode] || b.mode}</span>{b.transfer_lines ? <span className="pill count">transfers</span> : null}</td>
        <td>{b.distributor_name || "several"}</td><td className="wrap">{b.source_file}</td><td>{b.lines} lines</td></tr>)}</tbody></table></div>
        : <p className="empty">Nothing posted yet. Start by <button className="link" onClick={() => go("Distributors")}>adding your godown, super stockists and distributors</button>, then <button className="link" onClick={() => go("Inventory")}>upload stock</button>.</p>}
    </section>
  </>;
}
