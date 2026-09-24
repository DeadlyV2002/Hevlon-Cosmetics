import { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { supabase, Distributor, Product, StockLine, KINDS, KIND_LABEL, fetchAll, fmt, errText, locLabel } from "../lib/supabase";
import { today } from "../lib/parse";
import FilterBar, { Scope, emptyScope, applyScope, scopeLabel } from "./FilterBar";
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
  const [scope, setScope] = useState<Scope>(emptyScope());
  const [typed, setTyped] = useState("");
  const [period, setPeriod] = useState<"latest" | "range">("latest");
  const [range, setRange] = useState<Range>(defaultRange("month"));
  const [busy, setBusy] = useState(false);

  const picked = applyScope(locations, scope);
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

  /** Typing a full name picks that one location. */
  function type(v: string) {
    setTyped(v);
    const d = locations.find(x => locLabel(x) === v) || locations.find(x => x.name.toLowerCase() === v.trim().toLowerCase());
    if (d) setScope({ ...emptyScope(), ids: [d.id] });
    else if (!v.trim()) setScope(emptyScope());
  }

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
      const label = slug(scopeLabel(locations, scope));
      XLSX.writeFile(wb, `stock-${label}-${period === "latest" ? `latest-${today()}` : `${range.from}-to-${range.to}`}.xlsx`);
      notify(`Downloaded ${title.toLowerCase()} for ${picked.length === 1 ? picked[0].name : `${picked.length} locations`}: ${detail.length} product lines.`);
    } catch (e) { notify(`Download failed: ${errText(e)}`); }
    finally { setBusy(false); }
  }

  return <section className="card">
    <div className="rowhead"><h2>Download stock</h2></div>
    <p className="hint">Type a distributor, super stockist or godown to download its stock, or narrow by state, region and super stockist to download several at once.</p>
    <div className="bulk">
      <label>Location<input list="dl-locations" value={typed} onChange={e => type(e.target.value)} placeholder="Type a name…" />
        <datalist id="dl-locations">{KINDS.flatMap(k => locations.filter(d => d.kind === k)).map(d => <option key={d.id} value={locLabel(d)}>{KIND_LABEL[d.kind]}{d.territory ? ` · ${d.territory}` : ""}</option>)}</datalist></label>
      <div className="periodpick">
        <span className="lbl">Stock</span>
        <label className="inline"><input type="radio" name="period" checked={period === "latest"} onChange={() => setPeriod("latest")} /> Latest</label>
        <label className="inline"><input type="radio" name="period" checked={period === "range"} onChange={() => setPeriod("range")} /> For a date range</label>
        {period === "range" && <DateRange value={range} onChange={setRange} />}
      </div>
    </div>
    <FilterBar locations={locations} value={scope} onChange={s => { setScope(s); setTyped(""); }} kinds={KINDS} rank={rank} saveKey="download" />
    <div className="actions downloadrow">
      <button onClick={download} disabled={busy || !picked.length}>{busy ? "Preparing…" : "Download Excel"}</button>
      <span className="hint">{picked.length === 1 ? picked[0].name : `${picked.length} locations`} · latest stock {fmt(units)} units · ₹{fmt(value)}
        {period === "range" && " · the file shows opening, received, sent / sold and closing for the dates chosen"}</span>
    </div>
  </section>;
}
