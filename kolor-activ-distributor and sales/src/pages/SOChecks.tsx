import { Select } from "../components/Select";
import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { supabase, Distributor, Product, SalesOfficer, KIND_LABEL, fetchAll, fmt, plural, money, errText } from "../lib/supabase";
import { localDate, today } from "../lib/parse";
import FilterBar, { Scope, emptyScope, applyScope, scopeLabel } from "../components/FilterBar";
import DateRange, { Range, defaultRange } from "../components/DateRange";
import SalesOfficers from "./SalesOfficers";
import { startTask } from "../lib/tasks";
import CheckAll, { CheckItem, Fix, whatsapp } from "../components/CheckAll";
import { normName } from "../lib/parse";
import { dmy, dmyText } from "../lib/dates";
import SortTable from "../components/SortTable";
import { similarity } from "../lib/fuzzy";

type Tab = "oversell" | "aged" | "vs" | "retailers" | "low" | "stale" | "counts" | "near";
interface Oversell { distributor_id: string; product_id: string; report_date: string; so_qty: number; so_total: number; available: number; so_names: string; has_stock_data: boolean }
interface Aged { location_id: string; product_id: string; stock: number; aged_qty: number; oldest_in: string | null; last_in: string | null; last_out: string | null }
interface Vs { distributor_id: string; product_id: string; so_qty: number; so_checked: number; dist_out: number; so_names: string; data_until: string | null }
interface Line { id: string; report_date: string; so_name: string; distributor_id: string; distributor_name: string; sku: string; item_name: string; quantity: number; retailer_name: string | null; retailer_status: string; retailer_other_distributor: string | null }
interface Period { location_id: string; product_id: string; qty_out: number; closing: number }
interface Status { location_id: string; last_count: string | null; last_sale: string | null; last_movement: string | null; last_file: string | null }
/** A stock count difference; each location's opening count is left out by the database. */
interface CountLine { id: string; counted_on: string; location_id: string; product_id: string; change: number; source_file: string | null }
/** First and last day an SO booked at a distributor (DSRs and SO reports). */
interface Span { distributor_id: string; so_id: string; first_day: string; last_day: string; days: number }
interface Data { oversell: Oversell[]; aged: Aged[]; vs: Vs[]; lines: Line[]; period: Period[]; status: Status[]; counts: CountLine[]; spans: Span[] }
const EMPTY: Data = { oversell: [], aged: [], vs: [], lines: [], period: [], status: [], counts: [], spans: [] };

const n = (v: unknown) => Number(v || 0);
const daysSince = (d: string | null, to = today()) => (d ? Math.round((Date.parse(to) - Date.parse(d)) / 86400000) : null);
const minusDays = (d: string, k: number) => { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() - k); return localDate(x); };

interface Props { locations: Distributor[]; products: Product[]; officers: SalesOfficer[]; canManage: boolean; onChanged: () => Promise<void>; notify: (m: string) => void }

export default function SOChecks({ locations, products, officers, canManage, onChanged, notify }: Props) {
  const [scope, setScope] = useState<Scope>(emptyScope());
  const [range, setRange] = useState<Range>(defaultRange("30"));
  const [so, setSo] = useState("");
  const [agedDays, setAgedDays] = useState(60);
  const [staleDays, setStaleDays] = useState(45);
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
    const task = startTask("Running the SO checks", 0, true);
    Promise.all([
      fetchAll<Oversell>((a, b) => sb.rpc("so_oversell", args).range(a, b)),
      fetchAll<Aged>((a, b) => sb.rpc("aged_stock", { p_days: agedDays, p_as_of: range.to, p_locations: null }).range(a, b)),
      fetchAll<Vs>((a, b) => sb.rpc("so_vs_distributor", args).range(a, b)),
      fetchAll<Line>((a, b) => sb.from("so_line_details").select("id,report_date,so_name,distributor_id,distributor_name,sku,item_name,quantity,retailer_name,retailer_status,retailer_other_distributor")
        .gte("report_date", range.from).lte("report_date", range.to).neq("retailer_status", "OK").order("report_date").order("id").range(a, b)),
      fetchAll<Period>((a, b) => sb.rpc("stock_period", { p_from: minusDays(range.to, 29), p_to: range.to, p_locations: null }).range(a, b)),
      fetchAll<Status>((a, b) => sb.from("location_data_status").select("*").order("location_id").range(a, b)),
      fetchAll<CountLine>((a, b) => sb.rpc("count_changes", { p_from: range.from, p_to: range.to, p_locations: null }).range(a, b)),
      fetchAll<Span>((a, b) => sb.rpc("distributor_booking_span").range(a, b)).catch(() => [] as Span[]),
    ]).then(([oversell, aged, vs, lines, period, status, counts, spans]) => { if (live) setData({ oversell, aged, vs, lines, period, status, counts, spans }); task.ok(); })
      .catch(e => { if (live) { setErr(`Could not run the checks: ${errText(e)}`); task.fail(errText(e)); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; task.cancel(); };
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
    const own = [s.last_count, s.last_sale, s.last_file].filter(Boolean).sort().pop() || null;
    return { ...s, own, days: daysSince(own) };
  }).filter(s => s.days === null || s.days > staleDays).sort((a, b) => (b.days ?? 1e9) - (a.days ?? 1e9));
  const counts = data.counts.filter(c => ids.has(c.location_id)).map(c => ({ ...c, change: n(c.change), place: loc(c.location_id)?.name || "Deleted location" }))
    .sort((a, b) => Math.abs(b.change * price(b.product_id)) - Math.abs(a.change * price(a.product_id)));

  // Distributors in the same market (same state, town names alike). A party opened next to an old one,
  // with bookings moving across (often by the same SO) while the old one still holds stock or dues, is a red flag.
  const held = useMemo(() => { const m = new Map<string, number>(); data.aged.forEach(a => m.set(a.location_id, (m.get(a.location_id) || 0) + n(a.stock) * price(a.product_id))); return m; }, [data.aged, productById]);
  const spanOf = useMemo(() => {
    const m = new Map<string, { first: string; last: string; sos: Map<string, { first: string; last: string }> }>();
    data.spans.forEach(x => {
      const e = m.get(x.distributor_id) || { first: x.first_day, last: x.last_day, sos: new Map() };
      if (x.first_day < e.first) e.first = x.first_day; if (x.last_day > e.last) e.last = x.last_day;
      e.sos.set(x.so_id, { first: x.first_day, last: x.last_day }); m.set(x.distributor_id, e);
    });
    return m;
  }, [data.spans]);
  const near = useMemo(() => {
    const list = inScope.filter(d => d.kind === "DISTRIBUTOR" && (d.territory || "").trim());
    const groups: Distributor[][] = [];
    for (const d of list) {
      const g = groups.find(g => (g[0].state || "") === (d.state || "") && (normName(g[0].territory!) === normName(d.territory!) || similarity(g[0].territory!, d.territory!) >= 0.85));
      if (g) g.push(d); else groups.push([d]);
    }
    const since = (d: Distributor) => spanOf.get(d.id)?.first || d.created_at?.slice(0, 10) || "";
    const officer = (id: string) => officers.find(o => o.id === id)?.name || "";
    const quiet = minusDays(range.to, 30);
    const out: { level: number; town: string; a: Distributor; b: Distributor; shared: string; stock: number; why: string[] }[] = [];
    groups.filter(g => g.length > 1).forEach(g => {
      for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
        const [a, b] = since(g[i]) <= since(g[j]) ? [g[i], g[j]] : [g[j], g[i]];
        const sa = spanOf.get(a.id), sb = spanOf.get(b.id);
        const shared = sa && sb ? [...sa.sos.keys()].filter(k => sb.sos.has(k)) : [];
        // The same SO stopped booking at the old party and started at the new one.
        const movedSO = shared.filter(k => sa!.sos.get(k)!.last <= minusDays(sb!.sos.get(k)!.first, -45) && sa!.sos.get(k)!.last < quiet);
        const moved = !!(sa && sb && sb.first >= sa.first && sa.last < quiet && sa.last <= minusDays(sb.first, -45));
        const stock = held.get(a.id) || 0;
        const why: string[] = [];
        if (movedSO.length) why.push(`${movedSO.map(officer).join(", ")} stopped booking at ${a.name} (last ${dmy(sa!.last)}) and started at ${b.name} (${dmy(sb!.first)})`);
        else if (moved) why.push(`Bookings at ${a.name} stopped (last ${dmy(sa!.last)}) around when ${b.name} started (${dmy(sb!.first)})`);
        if (stock > 0) why.push(`${a.name} still holds ${money(stock)} of stock`);
        if (a.status === "DORMANT") why.push(`${a.name} is marked dormant`);
        if (!why.length) why.push(shared.length ? `Both served by ${shared.map(officer).join(", ")}` : "Two parties in the same market");
        out.push({ level: movedSO.length ? 3 : moved || (stock > 0 && a.status === "DORMANT") ? 2 : 1, town: `${a.territory}${a.state ? `, ${a.state}` : ""}`, a, b, shared: shared.map(officer).join(", "), stock, why });
      }
    });
    return out.sort((x, y) => y.level - x.level || y.stock - x.stock);
  }, [inScope.map(d => d.id).join(), spanOf, held, officers, range.to]);
  const LEVEL = ["", "Same market", "Check", "Red flag"];

  const TABS: { id: Tab; label: string; count: number; help: string }[] = [
    { id: "oversell", label: "Sold without stock", count: oversell.length, help: "SOs reported selling more than the distributor had: stock at the start of the period plus everything received up to that day. These are the bogus entries." },
    { id: "aged", label: "Stock to clear", count: aged.length, help: `Stock that has sat unsold at a distributor or super stockist for more than ${agedDays} days, biggest value first. Send this list to the SOs covering them.` },
    { id: "vs", label: "SO vs distributor sales", count: vs.length, help: `SOs reported more sales than the distributor's own data (stock counts, sales files) shows going out, over the days that data covers.${vsWaiting ? ` ${plural(vsWaiting, "more product line")} ${vsWaiting > 1 ? "have" : "has"} SO sales after the distributor's last data; ${vsWaiting > 1 ? "they" : "it"} can't be checked until the distributor sends more.` : ""}` },
    { id: "retailers", label: "Retailer problems", count: retailerProblems.length, help: "SO lines whose retailer isn't in your list, belongs to a different distributor, or is blank. New outlets are fine once verified; the rest can be fake." },
    { id: "low", label: "Running low", count: low.length, help: "Products with less than 7 days of stock left at the rate they went out over the last 30 days. Push a reorder before the shelf runs dry." },
    { id: "stale", label: "No recent data", count: stale.length, help: `Distributors and super stockists that haven't sent a stock count or sales file in the last ${staleDays} days. Their stock in the app is out of date, so checks on them are weaker.` },
    { id: "near", label: "Parties in the same market", count: near.length, help: "Distributors in the same town or market. When an SO falls out with a distributor, opening a new party next door instead of settling the dispute, taking the stock back to the SS and collecting the dues is a red flag. Red flag: the same SO stopped booking at the old party and started at the new one. Check: bookings moved across, or the old party is dormant and still holds stock." },
    { id: "counts", label: "Stock count gaps", count: counts.length, help: "Stock that appeared or disappeared at a stock count without a recorded purchase or sale. Each location's opening count is left out. For distributors who also send sales files, a drop here is unexplained stock." },
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
    stale: () => stale.map(s => { const d = loc(s.location_id); return { Location: d?.name, Type: d ? KIND_LABEL[d.kind] : "", State: d?.state, "Last stock count": s.last_count || "never", "Last sales file": s.last_sale || "never", "Last file of its own": s.last_file || "never", "Days since their own data": s.days ?? "never" }; }),
    near: () => near.map(x => ({ Level: LEVEL[x.level], Market: x.town, "Older party": x.a.name, "Older since": dmy(spanOf.get(x.a.id)?.first || x.a.created_at?.slice(0, 10) || ""), "Older last booking": dmy(spanOf.get(x.a.id)?.last || "") || "none",
      "Newer party": x.b.name, "Newer since": dmy(spanOf.get(x.b.id)?.first || x.b.created_at?.slice(0, 10) || ""), "SOs at both": x.shared, "Older still holds ₹": Math.round(x.stock), Why: x.why.join("; ") })),
    counts: () => counts.map(c => ({ Date: c.counted_on, Location: c.place, SKU: prod(c.product_id)?.sku, Product: prod(c.product_id)?.item_name, Change: c.change, "Value ₹": Math.round(c.change * price(c.product_id)), File: c.source_file || "" })),
  };

  // ---------- the same checks for Check Everything: every row, and the fixes the app can make ----------
  const askStock = (id: string) => { const d = loc(id); return whatsapp(d, `Hello ${d?.owner_name || d?.name || ""}, please send your latest closing stock statement and sales to Kolor Activ. Thank you.`); };
  const askOrder = (id: string, pid: string) => { const d = loc(id); return whatsapp(d, `Hello ${d?.owner_name || d?.name || ""}, your stock of ${prod(pid)?.item_name || "this product"} is running low. Please place your reorder with your super stockist.`); };
  const newRetailers = () => { const m = new Map<string, Line>(); retailerProblems.filter(l => l.retailer_status === "UNKNOWN" && l.retailer_name?.trim()).forEach(l => m.set(`${l.distributor_id}|${normName(l.retailer_name!)}`, l)); return [...m.values()]; };
  const fixesFor = (t: Tab): Fix[] => {
    const out: Fix[] = [];
    if (t === "retailers" && canManage && newRetailers().length) out.push({ label: `Add ${plural(newRetailers().length, "New Retailer")} To The List`, hint: "Only outlets you know are real. Blank and other-distributor lines stay for review.",
      run: async task => {
        const list = newRetailers();
        for (let i = 0; i < list.length; i += 200) {
          const { error } = await supabase!.from("retailers").insert(list.slice(i, i + 200).map(l => ({ distributor_id: l.distributor_id, name: l.retailer_name!.trim() })));
          if (error) throw new Error(error.code === "42501" ? "Only HO admins and state managers can add retailers." : error.message);
          task.step(Math.min(i + 200, list.length), list.length);
        }
        setReload(x => x + 1); await onChanged();
        return `Added ${plural(list.length, "retailer")}.`;
      } });
    out.push({ label: "Download This List", run: async () => { download(rowsFor[t](), TABS.find(x => x.id === t)!.label); return "Downloaded."; } });
    return out;
  };
  const extra: Partial<Record<Tab, { head: string; cell: (i: number) => React.ReactNode }>> = {
    oversell: { head: "Ask for stock", cell: i => (oversell[i].has_stock_data ? "" : askStock(oversell[i].distributor_id)) },
    stale: { head: "Ask for stock", cell: i => askStock(stale[i].location_id) },
    low: { head: "Remind to reorder", cell: i => askOrder(low[i].location_id, low[i].product_id) },
  };
  const checkItems = useMemo<CheckItem[]>(() => TABS.map(t => {
    const rows = t.count ? rowsFor[t.id]() : [], head = rows.length ? Object.keys(rows[0]) : [], x = extra[t.id];
    return { id: t.id, label: t.label, count: t.count, help: t.help, tab: t.id, fixes: t.count ? fixesFor(t.id) : [],
      head: x ? [...head, x.head] : head,
      lines: rows.map((r, i) => ({ cells: [...Object.values(r as Record<string, unknown>).map(v => (typeof v === "number" ? fmt(v, 2) : dmyText(String(v ?? "")))), ...(x ? [x.cell(i)] : [])], ok: false })) };
  }), [data, scope, so, agedDays, staleDays, byId, productById, canManage, range.from, range.to]);

  return <>
    <CheckAll officers={officers} locations={locations} canManage={canManage} checks={checkItems} onFixed={async () => { setReload(x => x + 1); await onChanged(); }}
      onOpen={t => { setTab(t as Tab); setTimeout(() => document.querySelector(".checktiles")?.scrollIntoView({ behavior: "smooth" }), 50); }} />
    <section className="card">
      <div className="checkbar">
        <DateRange value={range} onChange={setRange} />
        <Select value={so} onChange={e => setSo(e.target.value)} aria-label="Sales officer"><option value="">All SOs</option>{officers.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>
      </div>
      <FilterBar locations={locations} value={scope} onChange={setScope} kinds={["DISTRIBUTOR", "SUPER_STOCKIST"]} saveKey="so-checks" />
      {err && <div className="status err">{err}</div>}
      <div className="checktiles" role="tablist">{TABS.map(t => <button key={t.id} role="tab" aria-selected={tab === t.id} className={`checktile${tab === t.id ? " on" : ""}${t.count ? " has" : ""}`} onClick={() => setTab(t.id)}>
        <b>{t.count}</b><span>{t.label}</span></button>)}</div>
      <div className={`checkpanel${loading ? " loading" : ""}`}>
        <div className="checkhead"><div><h3>{current.label}</h3><p className="hint">{current.help}</p>
          {tab === "aged" && <label className="inline">Unsold for over <input type="number" min={7} max={365} value={agedDays} onChange={e => setAgedDays(Math.max(7, Number(e.target.value) || 60))} /> days</label>}
          {tab === "stale" && <label className="inline">No data for over <input type="number" min={1} max={180} value={staleDays} onChange={e => setStaleDays(Math.max(1, Number(e.target.value) || 15))} /> days</label>}</div>
          <button className="secondary" onClick={() => download(rowsFor[tab](), current.label)} disabled={!current.count}>Download this list</button></div>
        <div className="tablewrap">
          {tab === "oversell" && <SortTable rows={oversell} rowKey={o => `${o.distributor_id}${o.product_id}${o.report_date}`} cols={[
            { head: "Date", cell: o => dmy(o.report_date), sort: o => o.report_date },
            { head: "SO(s)", cell: o => o.so_names, className: () => "wrap" },
            { head: "Distributor", cell: o => loc(o.distributor_id)?.name },
            { head: "Product", cell: o => pname(o.product_id), sort: o => prod(o.product_id)?.item_name?.toLowerCase() },
            { head: "SO sales that day", cell: o => fmt(o.so_qty), sort: o => n(o.so_qty) },
            { head: "SO sales so far", cell: o => fmt(o.so_total), sort: o => n(o.so_total) },
            { head: "Distributor had", cell: o => <>{fmt(o.available)}{!o.has_stock_data && <small className="missing">no stock data yet</small>}</>, sort: o => n(o.available) },
            { head: "Sold without stock", cell: o => <b>{fmt(n(o.so_total) - n(o.available))}</b>, sort: o => n(o.so_total) - n(o.available), className: () => "out" },
          ]} />}
          {tab === "aged" && <SortTable rows={aged} rowKey={a => `${a.location_id}${a.product_id}`} cols={[
            { head: "Distributor", cell: a => <>{loc(a.location_id)?.name}<small className="muted">{ssOf(loc(a.location_id))}</small></>, sort: a => loc(a.location_id)?.name?.toLowerCase() },
            { head: "Product", cell: a => pname(a.product_id), sort: a => prod(a.product_id)?.item_name?.toLowerCase() },
            { head: "Stock", cell: a => fmt(a.stock), sort: a => n(a.stock) },
            { head: `Unsold over ${agedDays} days`, cell: a => <b>{fmt(a.aged_qty)}</b>, sort: a => n(a.aged_qty) },
            { head: "Oldest stock", cell: a => { const d = daysSince(a.oldest_in, range.to); return d !== null ? `${d} days` : "—"; }, sort: a => daysSince(a.oldest_in, range.to) },
            { head: "Last sold / sent", cell: a => dmy(a.last_out) || "never", sort: a => a.last_out },
            { head: "Aged value", cell: a => money(a.value), sort: a => a.value },
            { head: "SOs covering", cell: a => covers(a.location_id) || <span className="muted">none in this period</span>, sort: a => covers(a.location_id) || null, className: () => "wrap" },
          ]} />}
          {tab === "vs" && <SortTable rows={vs} rowKey={v => `${v.distributor_id}${v.product_id}`} cols={[
            { head: "Distributor", cell: v => loc(v.distributor_id)?.name },
            { head: "Product", cell: v => pname(v.product_id), sort: v => prod(v.product_id)?.item_name?.toLowerCase() },
            { head: "SO reported", cell: v => fmt(v.so_checked), sort: v => n(v.so_checked) },
            { head: "Distributor's own sales / out", cell: v => fmt(v.dist_out), sort: v => n(v.dist_out) },
            { head: "Extra claimed", cell: v => <b>{fmt(n(v.so_checked) - n(v.dist_out))}</b>, sort: v => n(v.so_checked) - n(v.dist_out), className: () => "out" },
            { head: "Extra value", cell: v => money((n(v.so_checked) - n(v.dist_out)) * price(v.product_id)), sort: v => (n(v.so_checked) - n(v.dist_out)) * price(v.product_id) },
            { head: "SO(s)", cell: v => v.so_names, className: () => "wrap" },
            { head: "Compared up to", cell: v => dmy(v.data_until), sort: v => v.data_until },
          ]} />}
          {tab === "retailers" && <SortTable rows={retailerProblems} limit={2000} rowKey={l => l.id} cols={[
            { head: "Date", cell: l => dmy(l.report_date), sort: l => l.report_date },
            { head: "SO", cell: l => l.so_name },
            { head: "Distributor", cell: l => l.distributor_name },
            { head: "Retailer", cell: l => l.retailer_name },
            { head: "Problem", cell: l => (l.retailer_status === "MISSING" ? "no retailer given" : l.retailer_status === "OTHER_DISTRIBUTOR" ? <span className="err">listed under {l.retailer_other_distributor}</span> : "not in your retailer list"), sort: l => l.retailer_status },
            { head: "Product", cell: l => l.item_name },
            { head: "Qty", cell: l => fmt(l.quantity), sort: l => n(l.quantity) },
            ...(canManage ? [{ head: "", cell: (l: Line) => (l.retailer_status === "UNKNOWN" ? <button className="secondary small" onClick={() => addRetailer(l)}>Add to list</button> : null) }] : []),
          ]} />}
          {tab === "low" && <SortTable rows={low} rowKey={p => `${p.location_id}${p.product_id}`} cols={[
            { head: "Location", cell: p => loc(p.location_id)?.name },
            { head: "Product", cell: p => pname(p.product_id), sort: p => prod(p.product_id)?.item_name?.toLowerCase() },
            { head: "Stock", cell: p => fmt(p.closing), sort: p => n(p.closing) },
            { head: "Out in last 30 days", cell: p => fmt(p.qty_out), sort: p => n(p.qty_out) },
            { head: "Days of stock left", cell: p => <b>{p.cover.toFixed(1)}</b>, sort: p => p.cover, className: p => (p.cover < 2 ? "out" : undefined) },
          ]} />}
          {tab === "stale" && <SortTable rows={stale} rowKey={x => x.location_id} cols={[
            { head: "Location", cell: x => loc(x.location_id)?.name },
            { head: "Type", cell: x => { const d = loc(x.location_id); return d ? KIND_LABEL[d.kind] : ""; } },
            { head: "State", cell: x => loc(x.location_id)?.state },
            { head: "Last stock count", cell: x => dmy(x.last_count) || "never", sort: x => x.last_count },
            { head: "Last sales file", cell: x => dmy(x.last_sale) || "never", sort: x => x.last_sale },
            { head: "Last file of its own", cell: x => dmy(x.last_file) || "never", sort: x => x.last_file },
            { head: "Days since their own data", cell: x => <b>{x.days ?? "never sent"}</b>, sort: x => x.days ?? 1e9 },
          ]} />}
          {tab === "near" && <SortTable rows={near} rowKey={x => x.a.id + x.b.id} rowClass={x => (x.level === 3 ? "flagged" : undefined)} cols={[
            { head: "Level", cell: x => <b className={x.level === 3 ? "err" : x.level === 2 ? "warntext" : "muted"}>{LEVEL[x.level]}</b>, sort: x => x.level },
            { head: "Market", cell: x => x.town },
            { head: "Older party", cell: x => <>{x.a.name}<small className="muted">since {dmy(spanOf.get(x.a.id)?.first || x.a.created_at?.slice(0, 10) || "") || "—"}{spanOf.get(x.a.id) ? `, last booking ${dmy(spanOf.get(x.a.id)!.last)}` : ""}</small></>, sort: x => x.a.name.toLowerCase() },
            { head: "Newer party", cell: x => <>{x.b.name}<small className="muted">since {dmy(spanOf.get(x.b.id)?.first || x.b.created_at?.slice(0, 10) || "") || "—"}</small></>, sort: x => x.b.name.toLowerCase() },
            { head: "SOs at both", cell: x => x.shared || <span className="muted">none</span>, sort: x => x.shared || null, className: () => "wrap" },
            { head: "Older still holds", cell: x => (x.stock ? money(x.stock) : "—"), sort: x => x.stock || null },
            { head: "Why", cell: x => x.why.join(". "), className: () => "wrap" },
          ]} />}
          {tab === "counts" && <SortTable rows={counts} rowKey={c => c.id} cols={[
            { head: "Date", cell: c => dmy(c.counted_on), sort: c => c.counted_on },
            { head: "Location", cell: c => c.place },
            { head: "Product", cell: c => pname(c.product_id), sort: c => prod(c.product_id)?.item_name?.toLowerCase() },
            { head: "Change", cell: c => `${c.change > 0 ? "+" : ""}${fmt(c.change)}`, sort: c => c.change, className: c => (c.change > 0 ? "in" : "out") },
            { head: "Value", cell: c => money(c.change * price(c.product_id)), sort: c => c.change * price(c.product_id) },
            { head: "File", cell: c => c.source_file, className: () => "wrap" },
          ]} />}
          {!current.count && !loading && <p className="empty">{tab === "stale" || tab === "low" || tab === "counts" || tab === "near" ? "Nothing here for this selection." : "Nothing found for this selection and period."}</p>}
        </div>
      </div>
    </section>
    <SalesOfficers officers={officers} canManage={canManage} onChanged={async () => { await onChanged(); setReload(x => x + 1); }} notify={notify} />
  </>;
}
