import { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { supabase, Distributor, Product, StockLine, KIND_LABEL, fetchAll, fmt, money, errText } from "../lib/supabase";
import { today } from "../lib/parse";
import DateRange, { Range, defaultRange } from "./DateRange";

interface PeriodRow {
  location_id: string; product_id: string; opening: number; qty_in: number; qty_out: number; closing: number;
  in_purchase: number; in_transfer: number; in_count: number; out_sale: number; out_transfer: number; out_count: number;
  last_in: string | null; last_out: string | null;
}
interface Move {
  transaction_date: string; mode: string; source: string; distributor_name: string; distributor_code: string; distributor_kind: string;
  counterparty_name: string | null; party: string | null; retailer_name: string | null; reference: string | null;
  sku: string; item_name: string; quantity: number; unit_price: number; source_file: string | null;
}
const HOW: Record<string, string> = { PURCHASE: "Purchase", SALE: "Sale", TRANSFER: "Transfer", COUNT: "Stock count" };
const n = (v: unknown) => Number(v || 0);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "stock";

export default function StockDownload({ locations, products, stock, notify }: { locations: Distributor[]; products: Product[]; stock: StockLine[]; notify: (m: string) => void }) {
  const [sel, setSel] = useState<Set<string>>(new Set()), [search, setSearch] = useState(""), [onlyStock, setOnlyStock] = useState(false);
  const [openSS, setOpenSS] = useState<Set<string>>(new Set());
  const [period, setPeriod] = useState<"latest" | "range">("latest");
  const [range, setRange] = useState<Range>(defaultRange("month"));
  const [busy, setBusy] = useState(false);

  // Ticked locations, or all of them when nothing is ticked.
  const picked = sel.size ? locations.filter(d => sel.has(d.id)) : locations;
  const byId = useMemo(() => new Map(locations.map(d => [d.id, d])), [locations]);
  const productById = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);
  const rank = useMemo(() => {
    const m = new Map<string, number>();
    stock.forEach(s => m.set(s.distributor_id, (m.get(s.distributor_id) || 0) + n(s.stock_value)));
    return m;
  }, [stock]);
  const ids = new Set(picked.map(d => d.id));
  const units = stock.filter(s => ids.has(s.distributor_id)).reduce((a, s) => a + n(s.current_stock), 0);
  const value = picked.reduce((a, d) => a + (rank.get(d.id) || 0), 0);

  async function download() {
    if (!supabase || !picked.length) return;
    setBusy(true);
    try {
      const everything = picked.length === locations.length;
      const args = { p_from: period === "range" ? range.from : null, p_to: period === "range" ? range.to : null, p_locations: everything ? null : picked.map(d => d.id) };
      const rows = await fetchAll<PeriodRow>((a, b) => supabase!.rpc("stock_period", args).range(a, b));
      const moves = period === "range" ? await fetchAll<Move>((a, b) => supabase!.rpc("stock_movements", args).range(a, b)) : [];
      const where = (d?: Distributor) => ({
        Location: d?.name || "", Code: d?.code || "", Type: d ? KIND_LABEL[d.kind] : "", State: d?.state || "", Region: d?.region || "",
        "Super stockist": d?.kind === "DISTRIBUTOR" ? byId.get(d.parent_id || "")?.name || "" : "",
      });
      const keep = rows.filter(r => period === "latest" ? n(r.closing) !== 0 : n(r.opening) || n(r.qty_in) || n(r.qty_out) || n(r.closing))
        .map(r => ({ r, d: byId.get(r.location_id), p: productById.get(r.product_id) }))
        .sort((a, b) => `${a.d?.name} ${a.p?.item_name}`.localeCompare(`${b.d?.name} ${b.p?.item_name}`));
      const detail = keep.map(({ r, d, p }) => {
        const rate = n(p?.unit_price);
        return period === "latest"
          ? { ...where(d), SKU: p?.sku || "", Product: p?.item_name || "", Stock: n(r.closing), "Rate ₹": rate, "Value ₹": Math.round(n(r.closing) * rate * 100) / 100, "Last received": r.last_in || "", "Last sent / sold": r.last_out || "" }
          : { ...where(d), SKU: p?.sku || "", Product: p?.item_name || "", Opening: n(r.opening), Received: n(r.qty_in), "Sent / sold": n(r.qty_out), Closing: n(r.closing),
              "Rate ₹": rate, "Closing value ₹": Math.round(n(r.closing) * rate * 100) / 100,
              Purchases: n(r.in_purchase), "Transfers in": n(r.in_transfer), "Count +": n(r.in_count), Sales: n(r.out_sale), "Transfers out": n(r.out_transfer), "Count −": n(r.out_count) };
      });
      const sums = new Map<string, { products: number; opening: number; inq: number; outq: number; closing: number; value: number }>();
      keep.forEach(({ r, p }) => {
        const t = sums.get(r.location_id) || { products: 0, opening: 0, inq: 0, outq: 0, closing: 0, value: 0 };
        t.products += n(r.closing) ? 1 : 0; t.opening += n(r.opening); t.inq += n(r.qty_in); t.outq += n(r.qty_out); t.closing += n(r.closing); t.value += n(r.closing) * n(p?.unit_price);
        sums.set(r.location_id, t);
      });
      const summary = picked.slice().sort((a, b) => a.name.localeCompare(b.name)).map(d => {
        const t = sums.get(d.id) || { products: 0, opening: 0, inq: 0, outq: 0, closing: 0, value: 0 };
        return period === "latest"
          ? { ...where(d), "Products in stock": t.products, Units: t.closing, "Value ₹": Math.round(t.value) }
          : { ...where(d), Opening: t.opening, Received: t.inq, "Sent / sold": t.outq, Closing: t.closing, "Products in stock": t.products, "Closing value ₹": Math.round(t.value) };
      });
      const wb = XLSX.utils.book_new();
      const title = period === "latest" ? `Latest stock as on ${today()}` : `Stock from ${range.from} to ${range.to}`;
      const sheet = (data: object[], empty: string) => (data.length ? XLSX.utils.json_to_sheet(data) : XLSX.utils.aoa_to_sheet([[empty]]));
      XLSX.utils.book_append_sheet(wb, sheet(detail, `No stock for this selection. ${title}.`), "Stock");
      XLSX.utils.book_append_sheet(wb, sheet(summary, title), "Summary");
      if (period === "range") XLSX.utils.book_append_sheet(wb, sheet(moves.map(m => ({
        Date: m.transaction_date, Location: m.distributor_name, Code: m.distributor_code, "In / out": m.mode === "INPUT" ? "In" : "Out", How: HOW[m.source] || m.source,
        "From / to": m.counterparty_name || m.retailer_name || m.party || "", "Invoice / ref": m.reference || "", SKU: m.sku, Product: m.item_name,
        Qty: n(m.quantity), "Rate ₹": n(m.unit_price), File: m.source_file || "",
      })), "No movements in this period."), "Movements");
      const label = slug(picked.length === 1 ? picked[0].name : sel.size ? `${picked.length}-locations` : "all-locations");
      XLSX.writeFile(wb, `stock-${label}-${period === "latest" ? `latest-${today()}` : `${range.from}-to-${range.to}`}.xlsx`);
      notify(`Downloaded ${title.toLowerCase()} for ${picked.length === 1 ? picked[0].name : `${picked.length} locations`}: ${detail.length} product lines.`);
    } catch (e) { notify(`Download failed: ${errText(e)}`); }
    finally { setBusy(false); }
  }

  // ---------- stock at a glance: state → super stockist → distributors ----------
  const perLoc = useMemo(() => {
    const m = new Map<string, { units: number; value: number; products: number; last: string }>();
    stock.forEach(s => {
      const e = m.get(s.distributor_id) || { units: 0, value: 0, products: 0, last: "" };
      if (n(s.current_stock)) { e.units += n(s.current_stock); e.value += n(s.stock_value); e.products++; }
      if ((s.last_movement || "") > e.last) e.last = s.last_movement || "";
      m.set(s.distributor_id, e);
    });
    return m;
  }, [stock]);
  const zero = { units: 0, value: 0, products: 0, last: "" };
  const t = search.trim().toLowerCase();
  const hit = (d: Distributor) => !t || `${d.name} ${d.code} ${d.territory || ""} ${d.state || ""}`.toLowerCase().includes(t);
  const holds = (d: Distributor) => (perLoc.get(d.id)?.units || 0) !== 0;
  const tree = useMemo(() => {
    const states = new Map<string, { ss: Map<string, Distributor[]>; godowns: Distributor[] }>();
    const add = (st: string) => { if (!states.has(st)) states.set(st, { ss: new Map(), godowns: [] }); return states.get(st)!; };
    locations.forEach(d => {
      if (d.kind === "GODOWN") { add(d.state || "No state").godowns.push(d); return; }
      const ssId = d.kind === "SUPER_STOCKIST" ? d.id : d.parent_id || "";
      const st = add((d.kind === "SUPER_STOCKIST" ? d.state : byId.get(d.parent_id || "")?.state || d.state) || "No state");
      if (!st.ss.has(ssId)) st.ss.set(ssId, []);
      if (d.kind === "DISTRIBUTOR") st.ss.get(ssId)!.push(d);
    });
    return [...states].sort((a, b) => a[0].localeCompare(b[0]));
  }, [locations, byId]);
  const sum = (ds: Distributor[]) => ds.reduce((a, d) => { const e = perLoc.get(d.id) || zero; return { units: a.units + e.units, value: a.value + e.value, products: a.products + e.products, last: e.last > a.last ? e.last : a.last }; }, { ...zero });
  const toggle = (ids: string[], on: boolean) => setSel(s => { const x = new Set(s); ids.forEach(id => (on ? x.add(id) : x.delete(id))); return x; });
  const row = (d: Distributor, cls = "") => { const e = perLoc.get(d.id) || zero; return <label key={d.id} className={`sk-row ${cls}${e.units ? "" : " none"}`}>
    <input type="checkbox" checked={sel.has(d.id)} onChange={ev => toggle([d.id], ev.target.checked)} />
    <span className="sk-name">{d.name}<small>{d.code}{d.territory ? ` · ${d.territory}` : ""}{d.status === "DORMANT" ? " · dormant" : ""}</small></span>
    <span className="sk-num">{e.units ? money(e.value) : "no stock"}<small>{e.units ? `${fmt(e.units)} units · ${e.products} products${e.last ? ` · ${e.last}` : ""}` : e.last ? `last update ${e.last}` : "never uploaded"}</small></span>
  </label>; };

  return <section className="card">
    <div className="rowhead"><h2>Stock At A Glance</h2>
      <div className="actions"><input className="search" placeholder="Search a location…" value={search} onChange={e => setSearch(e.target.value)} />
        <label className="inline"><input type="checkbox" checked={onlyStock} onChange={e => setOnlyStock(e.target.checked)} /> Only those holding stock</label></div></div>
    <p className="hint">Who holds how much stock right now, at SS rate. It updates as soon as any stock is saved. Tick locations to download their stock, or download everything.</p>
    <div className="sk-tree">{tree.map(([state, g]) => {
      const all = [...[...g.ss.entries()].flatMap(([ssId, ds]) => [...(byId.get(ssId) ? [byId.get(ssId)!] : []), ...ds]), ...g.godowns];
      const shown = all.filter(d => hit(d) && (!onlyStock || holds(d)));
      if (!shown.length) return null;
      const tot = sum(all);
      return <details key={state} className="rt-state" open={!!t || tree.length <= 2}>
        <summary><h3>{state}</h3><span className="rt-badge">{money(tot.value)}</span><span className="rt-badge">{fmt(tot.units)} units</span><span className="rt-badge">{all.filter(holds).length} of {all.length} hold stock</span></summary>
        <div className="rt-branch">
          {g.godowns.filter(d => hit(d) && (!onlyStock || holds(d))).map(d => row(d, "godown"))}
          {[...g.ss.entries()].sort((a, b) => sum([...(byId.get(b[0]) ? [byId.get(b[0])!] : []), ...b[1]]).value - sum([...(byId.get(a[0]) ? [byId.get(a[0])!] : []), ...a[1]]).value).map(([ssId, ds]) => {
            const ss = byId.get(ssId), team = [...(ss ? [ss] : []), ...ds], tt = sum(team);
            const kids = ds.filter(d => hit(d) && (!onlyStock || holds(d))).sort((a, b) => (perLoc.get(b.id)?.value || 0) - (perLoc.get(a.id)?.value || 0));
            if (!kids.length && !(ss && hit(ss) && (!onlyStock || holds(ss)))) return null;
            const key = `${state}|${ssId}`, open = !!t || openSS.has(key);
            return <details key={key} className="rt-ss" open={open} onToggle={e => { const o = (e.currentTarget as HTMLDetailsElement).open; if (o !== open) setOpenSS(s => { const x = new Set(s); o ? x.add(key) : x.delete(key); return x; }); }}>
              <summary><input type="checkbox" aria-label={`Select ${ss?.name || "no super stockist"} and its distributors`} checked={team.length > 0 && team.every(d => sel.has(d.id))}
                  onClick={e => e.stopPropagation()} onChange={e => toggle(team.map(d => d.id), e.target.checked)} />
                <span className="kind">SS</span><b>{ss?.name || "No super stockist"}</b>
                <span className="rt-badge">{money(tt.value)}</span><span className="rt-badge">{ss ? `SS own ${money(perLoc.get(ss.id)?.value || 0)}` : ""}</span><span className="rt-badge">{kids.length} distributors</span></summary>
              {open && <div className="sk-list">{ss && row(ss, "ssrow")}{kids.map(d => row(d))}</div>}
            </details>;
          })}
        </div>
      </details>;
    })}</div>
    <div className="actions downloadrow">
      <div className="periodpick">
        <label className="inline"><input type="radio" name="period" checked={period === "latest"} onChange={() => setPeriod("latest")} /> Latest stock</label>
        <label className="inline"><input type="radio" name="period" checked={period === "range"} onChange={() => setPeriod("range")} /> For a date range</label>
        {period === "range" && <DateRange value={range} onChange={setRange} />}
      </div>
      <button onClick={download} disabled={busy || !picked.length}>{busy ? "Preparing…" : sel.size ? `Download ${sel.size} Selected` : "Download All"}</button>
      {sel.size > 0 && <button className="link" onClick={() => setSel(new Set())}>Clear Selection</button>}
      <span className="hint">{sel.size ? `${picked.length} selected` : `All ${picked.length} locations`} · {fmt(units)} units · {money(value)}</span>
    </div>
  </section>;
}
