import { useEffect, useRef, useState } from "react";
import { supabase, Distributor, KIND_LABEL, SalesOfficer, StockLine, fetchAll, fmt, money, plural, errText } from "../lib/supabase";
import { ChartData } from "../lib/insights";
import { ChartView } from "./Charts";
import Modal from "./Modal";
import { exportPng, printOnly, togglePresent } from "../lib/present";

interface Month { month: string; bought_units: number; bought_value: number; sold_units: number; sold_value: number; closing_units: number; closing_value: number; paid: number; so_value: number }
export interface Billing { party_type: string; party_id: string; billed: number; collected: number; billed_all: number; collected_all: number; last_bill: string | null; last_payment: string | null }

const n = (x: unknown) => Number(x) || 0;
const mon = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
const day = (d?: string | null) => (d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");
/** "+12%" / "−8%" / "new" / "—" */
function change(now: number, before: number) {
  if (!before) return now ? "new" : "—";
  const p = ((now - before) / before) * 100;
  return `${p >= 0 ? "+" : "−"}${fmt(Math.abs(p))}%`;
}
export const collectionPct = (b?: Billing) => (b && n(b.billed) > 0 ? (n(b.collected) / n(b.billed)) * 100 : null);

/** One location's report: contact details, stock, billing and payments, month by month. */
export default function DistributorReport({ location, locations, stock, officers, onClose }: {
  location: Distributor; locations: Distributor[]; stock: StockLine[]; officers: SalesOfficer[]; onClose: () => void;
}) {
  const [months, setMonths] = useState<Month[] | null>(null);
  const [bill, setBill] = useState<Billing | undefined>();
  const [err, setErr] = useState("");
  const panel = useRef<HTMLDivElement>(null), charts = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!supabase) return;
    const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
    Promise.all([
      fetchAll<Month>((a, b) => supabase!.rpc("location_months", { p_location: location.id, p_months: 25 }).range(a, b)),
      supabase.rpc("billing_summary", { p_from: from, p_to: to }),
    ]).then(([m, b]) => {
      setMonths(m.map(x => ({ ...x, month: String(x.month).slice(0, 10) })));
      setBill(((b.data || []) as Billing[]).find(x => x.party_type === "LOCATION" && x.party_id === location.id));
    }).catch(e => setErr(errText(e)));
  }, [location.id]);

  const lines = stock.filter(s => s.distributor_id === location.id);
  const held = lines.filter(s => n(s.current_stock) !== 0);
  const units = held.reduce((a, s) => a + n(s.current_stock), 0), value = held.reduce((a, s) => a + n(s.stock_value), 0);
  const lastIn = lines.map(s => s.last_in || "").sort().pop() || null, lastOut = lines.map(s => s.last_out || "").sort().pop() || null;
  const ss = locations.find(l => l.id === location.parent_id), so = officers.find(o => o.id === location.so_id);
  const kids = locations.filter(l => l.parent_id === location.id);
  const pct = collectionPct(bill);

  // Last complete month against the month before and the same month a year earlier.
  const m = months || [];
  const last = m[m.length - 2], prev = m[m.length - 3], yearAgo = m[m.length - 14];
  const recent = m.slice(-13);
  const flow: ChartData | null = recent.length ? { type: "lines", unit: "money", summary: "", x: recent.map(x => mon(x.month)),
    series: [{ key: "bought", name: "Billed to them", slot: 1 }, { key: "sold", name: "Sold on", slot: 2 }, { key: "so", name: "SO secondary", slot: 3 }],
    values: [recent.map(x => n(x.bought_value)), recent.map(x => n(x.sold_value)), recent.map(x => n(x.so_value))] } : null;
  const closing: ChartData | null = recent.length ? { type: "columns", unit: "money", summary: "", x: recent.map(x => mon(x.month)),
    series: [{ key: "stock", name: "Stock at month end", slot: 1 }], values: [recent.map(x => n(x.closing_value))] } : null;
  const hasFlow = recent.some(x => n(x.bought_value) || n(x.sold_value) || n(x.so_value));

  async function exportCharts() { try { if (charts.current) await exportPng(charts.current, `${location.name} report`, `${location.name} (${location.code})`); } catch (e) { setErr(errText(e)); } }
  const phones = (location.phone || "").split(/,\s*/).filter(Boolean);

  return <Modal wide panelRef={panel} onClose={onClose} className="report"
    title={<>{location.name} <small className="muted">{location.code}</small></>}
    subtitle={[KIND_LABEL[location.kind], ss && `under ${ss.name}`, location.territory, location.region, location.state].filter(Boolean).join(" · ")}
    actions={<span className="noprint actions">
      <button className="secondary" onClick={() => panel.current && togglePresent(panel.current)}>Present</button>
      <button className="secondary" onClick={() => panel.current && printOnly(panel.current)}>Print</button>
      <button className="secondary" onClick={exportCharts} disabled={!months}>Export Chart</button>
    </span>}>
    {err && <div className="status err">{err}</div>}
    <div className="kpis">
      <div className="kpi"><small>Stock now</small><b>{money(value)}</b><span>{plural(units, "unit")} · {plural(held.length, "product")}</span></div>
      <div className="kpi"><small>Last bill received</small><b>{day(lastIn)}</b><span>last sale {day(lastOut)}</span></div>
      <div className="kpi"><small>Sold on, {last ? mon(last.month) : "last month"}</small><b>{money(last?.sold_value)}</b>
        <span>{last ? `${change(n(last.sold_value), n(prev?.sold_value))} MoM · ${change(n(last.sold_value), n(yearAgo?.sold_value))} YoY` : "—"}</span></div>
      <div className="kpi"><small>Billed to them, {last ? mon(last.month) : "last month"}</small><b>{money(last?.bought_value)}</b>
        <span>{last ? `${change(n(last.bought_value), n(prev?.bought_value))} MoM · ${change(n(last.bought_value), n(yearAgo?.bought_value))} YoY` : "—"}</span></div>
      <div className={`kpi${pct !== null && pct < 60 ? " bad" : ""}`}><small>Collection, last 12 months</small><b>{pct === null ? "—" : `${fmt(pct)}%`}</b>
        <span>{bill ? `${money(bill.collected)} of ${money(bill.billed)} · owes ${money(n(bill.billed_all) - n(bill.collected_all))}` : "no bills or payments yet"}</span></div>
    </div>

    <div className="reportgrid">
      <section className="contact">
        <h3>Contact</h3>
        <dl>
          <dt>Owner</dt><dd>{location.owner_name || "—"}</dd>
          <dt>Phone</dt><dd>{phones.length ? phones.map(p => <a key={p} href={`tel:${p}`}>{p}</a>) : "—"}</dd>
          <dt>Email</dt><dd>{location.email ? <a href={`mailto:${location.email}`}>{location.email}</a> : "—"}</dd>
          <dt>Company</dt><dd>{location.company_name || "—"}</dd>
          {location.kind === "DISTRIBUTOR" && <><dt>Super stockist</dt><dd>{ss?.name || "—"}</dd><dt>SO / ASE</dt><dd>{so ? `${so.name}${so.phone ? ` · ${so.phone}` : ""}` : "—"}</dd></>}
          {location.kind === "SUPER_STOCKIST" && <><dt>Distributors</dt><dd>{kids.length}</dd></>}
          <dt>Last payment</dt><dd>{day(bill?.last_payment)}</dd>
        </dl>
      </section>
      <section className="topstock">
        <h3>Biggest stock lines</h3>
        {held.length ? <table><thead><tr><th>Product</th><th>Units</th><th>Value</th><th>Last in</th></tr></thead>
          <tbody>{[...held].sort((a, b) => n(b.stock_value) - n(a.stock_value)).slice(0, 8).map(s => <tr key={s.product_id}><td>{s.item_name}</td><td>{fmt(s.current_stock)}</td><td>{money(s.stock_value)}</td><td>{day(s.last_in)}</td></tr>)}</tbody></table>
          : <p className="empty">No stock recorded.</p>}
      </section>
    </div>

    <div ref={charts} className="reportcharts">
      {!months ? <p className="empty">Loading…</p> : <>
        <section><h3>Billed, sold on and SO secondary, by month</h3>{hasFlow && flow ? <ChartView data={flow} size="focus" /> : <p className="empty">No bills, sales or SO reports in the last 13 months.</p>}</section>
        <section><h3>Stock at month end</h3>{closing && recent.some(x => n(x.closing_value)) ? <ChartView data={closing} size="card" /> : <p className="empty">No stock recorded.</p>}</section>
      </>}
    </div>

    {months && hasFlow && <section><h3>Month by month</h3><div className="tablewrap"><table><thead><tr><th>Month</th><th>Billed to them</th><th>Sold on</th><th>MoM</th><th>Stock at end</th><th>Paid</th><th>SO secondary</th></tr></thead>
      <tbody>{[...recent].reverse().map((x, i, arr) => <tr key={x.month}><td>{mon(x.month)}</td><td>{money(x.bought_value)}</td><td>{money(x.sold_value)}</td>
        <td>{arr[i + 1] ? change(n(x.sold_value), n(arr[i + 1].sold_value)) : "—"}</td><td>{money(x.closing_value)}</td><td>{money(x.paid)}</td><td>{money(x.so_value)}</td></tr>)}</tbody></table></div></section>}
  </Modal>;
}
