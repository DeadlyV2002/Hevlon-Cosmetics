import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { supabase, Distributor, Product, SalesOfficer, KIND_LABEL, fetchAll, fmt, plural, money, errText } from "../lib/supabase";
import { localDate, today } from "../lib/parse";
import FilterBar, { Scope, emptyScope, applyScope, scopeLabel } from "../components/FilterBar";
import DateRange, { Range, defaultRange } from "../components/DateRange";
import SalesOfficers from "./SalesOfficers";

type Tab = "oversell" | "aged" | "vs" | "retailers" | "low" | "stale" | "counts";
interface Oversell { distributor_id: string; product_id: string; report_date: string; so_qty: number; so_total: number; available: number; so_names: string; has_stock_data: boolean }
interface Aged { location_id: string; product_id: string; stock: number; aged_qty: number; oldest_in: string | null; last_in: string | null; last_out: string | null }
interface Vs { distributor_id: string; product_id: string; so_qty: number; so_checked: number; dist_out: number; so_names: string; data_until: string | null }
interface Line { id: string; report_date: string; so_name: string; distributor_id: string; distributor_name: string; sku: string; item_name: string; quantity: number; retailer_name: string | null; retailer_status: string; retailer_other_distributor: string | null }
interface Period { location_id: string; product_id: string; qty_out: number; closing: number }
interface Status { location_id: string; last_count: string | null; last_sale: string | null; last_movement: string | null }
interface CountLine { id: string; transaction_date: string; distributor_id: string; distributor_name: string; product_id: string; mode: string; quantity: number; source_file: string | null }
interface Data { oversell: Oversell[]; aged: Aged[]; vs: Vs[]; lines: Line[]; period: Period[]; status: Status[]; counts: CountLine[] }
const EMPTY: Data = { oversell: [], aged: [], vs: [], lines: [], period: [], status: [], counts: [] };

const n = (v: unknown) => Number(v || 0);
const daysSince = (d: string | null, to = today()) => (d ? Math.round((Date.parse(to) - Date.parse(d)) / 86400000) : null);
const minusDays = (d: string, k: number) => { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() - k); return localDate(x); };

interface Props { locations: Distributor[]; products: Product[]; officers: SalesOfficer[]; canManage: boolean; onChanged: () => Promise<void>; notify: (m: string) => void }

export default function SOChecks({ locations, products, officers, canManage, onChanged, notify }: Props) {
  const [scope, setScope] = useState<Scope>(emptyScope());
  const [range, setRange] = useState<Range>(defaultRange("30"));
  const [so, setSo] = useState("");
  const [agedDays, setAgedDays] = useState(60);
  const [staleDays, setStaleDays] = useState(15);
  const [tab, setTab] = useState<Tab>("oversell");
  const [data, setData] = useState<Data>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [reload, setReload] = useState(0);

  const byId = useMemo(() => new Map(locations.map(d => [d.id, d])), [locations]);
  const productById = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);
  const sellers = useMemo(() => locations.filter(l => l.kind !== "GODOWN"), [locations]);
  const inScope = applyScope(sellers, scope);
  const ids = new Set(inScope.map(d => d.id));
  const soName = officers.find(o => o.id === so)?.name || "";
  const bySO = (names: string | null) => !so || (names || "").split(", ").includes(soName);

  useEffect(() => {
    if (!supabase) return;
    let live = true;
    const sb = supabase;
    const args = { p_from: range.from, p_to: range.to, p_locations: null };
    setLoading(true); setErr("");
    Promise.all([
      fetchAll<Oversell>((a, b) => sb.rpc("so_oversell", args).range(a, b)),
      fetchAll<Aged>((a, b) => sb.rpc("aged_stock", { p_days: agedDays, p_as_of: range.to, p_locations: null }).range(a, b)),
      fetchAll<Vs>((a, b) => sb.rpc("so_vs_distributor", args).range(a, b)),
      fetchAll<Line>((a, b) => sb.from("so_line_details").select("id,report_date,so_name,distributor_id,distributor_name,sku,item_name,quantity,retailer_name,retailer_status,retailer_other_distributor")
        .gte("report_date", range.from).lte("report_date", range.to).neq("retailer_status", "OK").order("report_date").order("id").range(a, b)),
      fetchAll<Period>((a, b) => sb.rpc("stock_period", { p_from: minusDays(range.to, 29), p_to: range.to, p_locations: null }).range(a, b)),
      fetchAll<Status>((a, b) => sb.from("location_data_status").select("*").order("location_id").range(a, b)),
      fetchAll<CountLine>((a, b) => sb.from("inventory_history").select("id,transaction_date,distributor_id,distributor_name,product_id,mode,quantity,source_file")
        .eq("source", "COUNT").gte("transaction_date", range.from).lte("transaction_date", range.to).order("transaction_date").order("id").range(a, b)),
    ]).then(([oversell, aged, vs, lines, period, status, counts]) => { if (live) setData({ oversell, aged, vs, lines, period, status, counts }); })
      .catch(e => { if (live) setErr(`Could not run the checks: ${errText(e)}`); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [range.from, range.to, agedDays, reload]);

  // Which SOs have reported for each distributor in this period (for the clearance list).
  const soCover = useMemo(() => {
    const m = new Map<string, Set<string>>();
    data.vs.forEach(v => (v.so_names || "").split(", ").filter(Boolean).forEach(s => { if (!m.has(v.distributor_id)) m.set(v.distributor_id, new Set()); m.get(v.distributor_id)!.add(s); }));
    return m;
  }, [data.vs]);
  const covers = (id: string) => [...(soCover.get(id) || [])].join(", ");
  const loc = (id: string) => byId.get(id);
  const prod = (id: string) => productById.get(id);
  const ssOf = (d?: Distributor) => (d?.kind === "DISTRIBUTOR" ? byId.get(d.parent_id || "")?.name || "" : "");
  const price = (id: string) => n(prod(id)?.unit_price);
  /** Product name, with the SKU when it adds something. */
  const pname = (id: string) => { const p = prod(id); return <>{p?.item_name}{p && p.sku !== p.item_name && <small className="muted">{p.sku}</small>}</>; };

  // ---------- each check, filtered to the selection ----------
  const oversell = data.oversell.filter(o => ids.has(o.distributor_id) && bySO(o.so_names))
    .sort((a, b) => (n(b.so_total) - n(b.available)) * n(prod(b.product_id)?.unit_price) - (n(a.so_total) - n(a.available)) * n(prod(a.product_id)?.unit_price));
  const aged = data.aged.filter(a => ids.has(a.location_id) && n(a.aged_qty) > 0 && (!so || (soCover.get(a.location_id) || new Set()).has(soName)))
    .map(a => ({ ...a, value: n(a.aged_qty) * n(prod(a.product_id)?.unit_price) })).sort((a, b) => b.value - a.value);
  const vsAll = data.vs.filter(v => ids.has(v.distributor_id) && bySO(v.so_names));
  const vs = vsAll.filter(v => n(v.so_checked) > n(v.dist_out))
    .sort((a, b) => (n(b.so_checked) - n(b.dist_out)) * price(b.product_id) - (n(a.so_checked) - n(a.dist_out)) * price(a.product_id));
  const vsWaiting = vsAll.filter(v => n(v.so_qty) > n(v.so_checked)).length;
  const retailerProblems = data.lines.filter(l => ids.has(l.distributor_id) && (!so || l.so_name === soName));
  const low = data.period.filter(p => ids.has(p.location_id) && n(p.qty_out) > 0)
    .map(p => ({ ...p, cover: n(p.closing) / (n(p.qty_out) / 30) })).filter(p => p.cover < 7).sort((a, b) => a.cover - b.cover);
  const stale = data.status.filter(s => ids.has(s.location_id)).map(s => {
    const own = [s.last_count, s.last_sale].filter(Boolean).sort().pop() || null;
    return { ...s, own, days: daysSince(own) };
  }).filter(s => s.days === null || s.days > staleDays).sort((a, b) => (b.days ?? 1e9) - (a.days ?? 1e9));
  const counts = data.counts.filter(c => ids.has(c.distributor_id)).map(c => ({ ...c, change: c.mode === "INPUT" ? n(c.quantity) : -n(c.quantity) }))
    .sort((a, b) => Math.abs(b.change * price(b.product_id)) - Math.abs(a.change * price(a.product_id)));

  const TABS: { id: Tab; label: string; count: number; help: string }[] = [
    { id: "oversell", label: "Sold without stock", count: oversell.length, help: "SOs reported selling more than the distributor had: stock at the start of the period plus everything received up to that day. These are the bogus entries." },
    { id: "aged", label: "Stock to clear", count: aged.length, help: `Stock that has sat unsold at a distributor or super stockist for more than ${agedDays} days, biggest value first. Send this list to the SOs covering them.` },
    { id: "vs", label: "SO vs distributor sales", count: vs.length, help: `SOs reported more sales than the distributor's own data (stock counts, sales files) shows going out, over the days that data covers.${vsWaiting ? ` ${plural(vsWaiting, "more product line")} ${vsWaiting > 1 ? "have" : "has"} SO sales after the distributor's last data; ${vsWaiting > 1 ? "they" : "it"} can't be checked until the distributor sends more.` : ""}` },
    { id: "retailers", label: "Retailer problems", count: retailerProblems.length, help: "SO lines whose retailer isn't in your list, belongs to a different distributor, or is blank. New outlets are fine once verified; the rest can be fake." },
    { id: "low", label: "Running low", count: low.length, help: "Products with less than 7 days of stock left at the rate they went out over the last 30 days. Push a reorder before the shelf runs dry." },
    { id: "stale", label: "No recent data", count: stale.length, help: `Distributors and super stockists that haven't sent a stock count or sales file in the last ${staleDays} days. Their stock in the app is out of date, so checks on them are weaker.` },
    { id: "counts", label: "Stock count gaps", count: counts.length, help: "Stock that appeared or disappeared at a stock count without a recorded purchase or sale. For distributors who also send sales files, a drop here is unexplained stock." },
  ];
  const current = TABS.find(t => t.id === tab)!;

  function download(rows: object[], name: string) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, rows.length ? XLSX.utils.json_to_sheet(rows) : XLSX.utils.aoa_to_sheet([["Nothing to show for this selection."]]), name.slice(0, 31));
    XLSX.writeFile(wb, `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${scopeLabel(sellers, scope).toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${range.from}-to-${range.to}.xlsx`);
  }
  async function addRetailer(l: Line) {
    if (!supabase || !l.retailer_name) return;
    const { error } = await supabase.from("retailers").insert({ distributor_id: l.distributor_id, name: l.retailer_name.trim() });
    if (error) return notify(error.code === "42501" ? "Only HO admins and state managers can add retailers." : `Could not add: ${error.message}`);
    notify(`Added ${l.retailer_name} under ${l.distributor_name}.`);
    setReload(x => x + 1); await onChanged();
  }

  const rowsFor: Record<Tab, () => object[]> = {
    oversell: () => oversell.map(o => { const d = loc(o.distributor_id), p = prod(o.product_id); return { Date: o.report_date, "SO(s)": o.so_names, Distributor: d?.name, "Super stockist": ssOf(d), SKU: p?.sku, Product: p?.item_name, "SO sales that day": n(o.so_qty), "SO sales so far": n(o.so_total), "Distributor had": n(o.available), "Sold without stock": n(o.so_total) - n(o.available), Note: o.has_stock_data ? "" : "no stock data for this distributor yet" }; }),
    aged: () => aged.map(a => { const d = loc(a.location_id), p = prod(a.product_id); return { Distributor: d?.name, Type: d ? KIND_LABEL[d.kind] : "", "Super stockist": ssOf(d), State: d?.state, Region: d?.region, SKU: p?.sku, Product: p?.item_name, Stock: n(a.stock), [`Unsold over ${agedDays} days`]: n(a.aged_qty), "Oldest stock (days)": daysSince(a.oldest_in, range.to), "Last sold / sent": a.last_out || "never", "Aged value ₹": Math.round(a.value), "SOs covering": covers(a.location_id) }; }),
    vs: () => vs.map(v => { const d = loc(v.distributor_id), p = prod(v.product_id); return { Distributor: d?.name, "Super stockist": ssOf(d), SKU: p?.sku, Product: p?.item_name, "SO reported": n(v.so_checked), "Distributor's own sales / out": n(v.dist_out), "Extra claimed by SO": n(v.so_checked) - n(v.dist_out), "Extra value ₹": Math.round((n(v.so_checked) - n(v.dist_out)) * price(v.product_id)), "SO(s)": v.so_names, "Compared up to": v.data_until || "" }; }),
    retailers: () => retailerProblems.map(l => ({ Date: l.report_date, SO: l.so_name, Distributor: l.distributor_name, Retailer: l.retailer_name || "", Problem: l.retailer_status === "MISSING" ? "no retailer given" : l.retailer_status === "OTHER_DISTRIBUTOR" ? `listed under ${l.retailer_other_distributor}` : "not in your retailer list", SKU: l.sku, Product: l.item_name, Qty: n(l.quantity) })),
    low: () => low.map(p => { const d = loc(p.location_id), pr = prod(p.product_id); return { Location: d?.name, Type: d ? KIND_LABEL[d.kind] : "", SKU: pr?.sku, Product: pr?.item_name, Stock: n(p.closing), "Out in last 30 days": n(p.qty_out), "Days of stock left": Math.round(p.cover * 10) / 10 }; }),
    stale: () => stale.map(s => { const d = loc(s.location_id); return { Location: d?.name, Type: d ? KIND_LABEL[d.kind] : "", State: d?.state, "Last stock count": s.last_count || "never", "Last sales file": s.last_sale || "never", "Days since their own data": s.days ?? "never" }; }),
    counts: () => counts.map(c => ({ Date: c.transaction_date, Location: c.distributor_name, SKU: prod(c.product_id)?.sku, Product: prod(c.product_id)?.item_name, Change: c.change, "Value ₹": Math.round(c.change * price(c.product_id)), File: c.source_file || "" })),
  };

  return <>
    <section className="card">
      <div className="checkfilters">
        <DateRange value={range} onChange={setRange} />
        <select value={so} onChange={e => setSo(e.target.value)} aria-label="Sales officer"><option value="">All SOs</option>{officers.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
        <label className="inline">Stock unsold for over <input type="number" min={7} max={365} value={agedDays} onChange={e => setAgedDays(Math.max(7, Number(e.target.value) || 60))} /> days</label>
        <label className="inline">No data for over <input type="number" min={1} max={180} value={staleDays} onChange={e => setStaleDays(Math.max(1, Number(e.target.value) || 15))} /> days</label>
      </div>
      <FilterBar locations={locations} value={scope} onChange={setScope} kinds={["DISTRIBUTOR", "SUPER_STOCKIST"]} saveKey="so-checks" />
      {err && <div className="status err">{err}</div>}
      <div className="tabs checks" role="tablist">{TABS.map(t => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
        {t.label} <span className={`count${t.count ? " has" : ""}`}>{t.count}</span></button>)}</div>
      <div className={loading ? "loading" : ""}>
        <div className="rowhead"><p className="hint">{current.help}</p>
          <button className="secondary" onClick={() => download(rowsFor[tab](), current.label)} disabled={!current.count}>Download this list</button></div>
        <div className="tablewrap">
          {tab === "oversell" && <table><thead><tr><th>Date</th><th>SO(s)</th><th>Distributor</th><th>Product</th><th>SO sales that day</th><th>SO sales so far</th><th>Distributor had</th><th>Sold without stock</th></tr></thead>
            <tbody>{oversell.map(o => { const p = prod(o.product_id); return <tr key={`${o.distributor_id}${o.product_id}${o.report_date}`}>
              <td>{o.report_date}</td><td className="wrap">{o.so_names}</td><td>{loc(o.distributor_id)?.name}</td><td>{pname(o.product_id)}</td>
              <td>{fmt(o.so_qty)}</td><td>{fmt(o.so_total)}</td><td>{fmt(o.available)}{!o.has_stock_data && <small className="missing">no stock data yet</small>}</td>
              <td className="out"><b>{fmt(n(o.so_total) - n(o.available))}</b></td></tr>; })}</tbody></table>}
          {tab === "aged" && <table><thead><tr><th>Distributor</th><th>Product</th><th>Stock</th><th>Unsold over {agedDays} days</th><th>Oldest stock</th><th>Last sold / sent</th><th>Aged value</th><th>SOs covering</th></tr></thead>
            <tbody>{aged.map(a => { const p = prod(a.product_id), age = daysSince(a.oldest_in, range.to); return <tr key={`${a.location_id}${a.product_id}`}>
              <td>{loc(a.location_id)?.name}<small className="muted">{ssOf(loc(a.location_id))}</small></td><td>{pname(a.product_id)}</td>
              <td>{fmt(a.stock)}</td><td><b>{fmt(a.aged_qty)}</b></td><td>{age !== null ? `${age} days` : "—"}</td><td>{a.last_out || "never"}</td><td>{money(a.value)}</td><td className="wrap">{covers(a.location_id) || <span className="muted">none in this period</span>}</td></tr>; })}</tbody></table>}
          {tab === "vs" && <table><thead><tr><th>Distributor</th><th>Product</th><th>SO reported</th><th>Distributor's own sales / out</th><th>Extra claimed</th><th>Extra value</th><th>SO(s)</th><th>Compared up to</th></tr></thead>
            <tbody>{vs.map(v => <tr key={`${v.distributor_id}${v.product_id}`}>
              <td>{loc(v.distributor_id)?.name}</td><td>{pname(v.product_id)}</td><td>{fmt(v.so_checked)}</td><td>{fmt(v.dist_out)}</td>
              <td className="out"><b>{fmt(n(v.so_checked) - n(v.dist_out))}</b></td><td>{money((n(v.so_checked) - n(v.dist_out)) * price(v.product_id))}</td><td className="wrap">{v.so_names}</td>
              <td>{v.data_until}</td></tr>)}</tbody></table>}
          {tab === "retailers" && <table><thead><tr><th>Date</th><th>SO</th><th>Distributor</th><th>Retailer</th><th>Problem</th><th>Product</th><th>Qty</th>{canManage && <th />}</tr></thead>
            <tbody>{retailerProblems.slice(0, 2000).map(l => <tr key={l.id}><td>{l.report_date}</td><td>{l.so_name}</td><td>{l.distributor_name}</td><td>{l.retailer_name}</td>
              <td>{l.retailer_status === "MISSING" ? "no retailer given" : l.retailer_status === "OTHER_DISTRIBUTOR" ? <span className="err">listed under {l.retailer_other_distributor}</span> : "not in your retailer list"}</td>
              <td>{l.item_name}</td><td>{fmt(l.quantity)}</td>
              {canManage && <td>{l.retailer_status === "UNKNOWN" && <button className="secondary small" onClick={() => addRetailer(l)}>Add to list</button>}</td>}</tr>)}</tbody></table>}
          {tab === "low" && <table><thead><tr><th>Location</th><th>Product</th><th>Stock</th><th>Out in last 30 days</th><th>Days of stock left</th></tr></thead>
            <tbody>{low.map(p => <tr key={`${p.location_id}${p.product_id}`}><td>{loc(p.location_id)?.name}</td><td>{pname(p.product_id)}</td>
              <td>{fmt(p.closing)}</td><td>{fmt(p.qty_out)}</td><td className={p.cover < 2 ? "out" : ""}><b>{p.cover.toFixed(1)}</b></td></tr>)}</tbody></table>}
          {tab === "stale" && <table><thead><tr><th>Location</th><th>Type</th><th>State</th><th>Last stock count</th><th>Last sales file</th><th>Days since their own data</th></tr></thead>
            <tbody>{stale.map(s => { const d = loc(s.location_id); return <tr key={s.location_id}><td>{d?.name}</td><td>{d ? KIND_LABEL[d.kind] : ""}</td><td>{d?.state}</td>
              <td>{s.last_count || "never"}</td><td>{s.last_sale || "never"}</td><td><b>{s.days ?? "never sent"}</b></td></tr>; })}</tbody></table>}
          {tab === "counts" && <table><thead><tr><th>Date</th><th>Location</th><th>Product</th><th>Change</th><th>Value</th><th>File</th></tr></thead>
            <tbody>{counts.map(c => <tr key={c.id}><td>{c.transaction_date}</td><td>{c.distributor_name}</td><td>{pname(c.product_id)}</td>
              <td className={c.change > 0 ? "in" : "out"}>{c.change > 0 ? "+" : ""}{fmt(c.change)}</td><td>{money(c.change * price(c.product_id))}</td><td className="wrap">{c.source_file}</td></tr>)}</tbody></table>}
          {!current.count && !loading && <p className="empty">{tab === "stale" || tab === "low" || tab === "counts" ? "Nothing here for this selection." : "Nothing found for this selection and period."}</p>}
        </div>
      </div>
    </section>
    <SalesOfficers officers={officers} canManage={canManage} onChanged={async () => { await onChanged(); setReload(x => x + 1); }} notify={notify} />
  </>;
}
