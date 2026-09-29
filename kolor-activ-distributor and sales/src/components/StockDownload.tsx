import { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { supabase, Distributor, Product, StockLine, KIND_LABEL, fetchAll, fmt, money, errText } from "../lib/supabase";
import { today } from "../lib/parse";
import DateRange, { Range, defaultRange } from "./DateRange";
import { dmy } from "../lib/dates";

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
/** Stock is kept in dozens; pieces are dozens × 12. */
const dz = (v: unknown) => Math.round(n(v) * 100) / 100;
const pcs = (v: unknown) => Math.round(n(v) * 12);
const catOf = (p?: Product) => p?.category || "Other";
/** A sheet where a location's details and each category are written once, in merged cells, over the rows they cover. */
function grouped(rows: Record<string, unknown>[], locCols: string[], catCol: string): XLSX.WorkSheet {
  const head = Object.keys(rows[0]), aoa: unknown[][] = [head], merges: XLSX.Range[] = [];
  const locKey = (r: Record<string, unknown>) => locCols.map(c => r[c]).join("|");
  const run = (start: number, key: (r: Record<string, unknown>) => string, cols: number[]) => {
    for (let i = start; i < rows.length;) {
      let j = i; while (j + 1 < rows.length && key(rows[j + 1]) === key(rows[i])) j++;
      if (j > i) cols.forEach(c => merges.push({ s: { r: i + 1, c }, e: { r: j + 1, c } }));
      i = j + 1;
    }
  };
  rows.forEach((r, i) => aoa.push(head.map(h => {
    const sameLoc = i > 0 && locKey(rows[i - 1]) === locKey(r);
    if (locCols.includes(h) && sameLoc) return "";
    if (h === catCol && sameLoc && rows[i - 1][catCol] === r[catCol]) return "";
    return r[h];
  })));
  run(0, locKey, locCols.map(c => head.indexOf(c)).filter(c => c >= 0));
  run(0, r => `${locKey(r)}|${r[catCol]}`, [head.indexOf(catCol)]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = merges;
  ws["!cols"] = head.map(h => ({ wch: Math.min(40, Math.max(h.length, 10)) }));
  return ws;
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "stock";

/** The stock tree at the top of the Inventory page; whatever the page puts between them sits above the download card at the bottom. */
export default function StockDownload({ locations, products, stock, notify, children }: { locations: Distributor[]; products: Product[]; stock: StockLine[]; notify: (m: string) => void; children?: React.ReactNode }) {
  const [sel, setSel] = useState<Set<string>>(new Set()), [search, setSearch] = useState(""), [onlyStock, setOnlyStock] = useState(false);
  const [openSS, setOpenSS] = useState<Set<string>>(new Set()), [openLoc, setOpenLoc] = useState<string | null>(null);
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
        .sort((a, b) => `${a.d?.name}|${catOf(a.p)}|${a.p?.item_name}`.localeCompare(`${b.d?.name}|${catOf(b.p)}|${b.p?.item_name}`));
      const detail = keep.map(({ r, d, p }) => {
        const rate = n(p?.unit_price);
        return period === "latest"
          ? { ...where(d), Category: catOf(p), SKU: p?.item_name || p?.sku || "", Dozens: dz(r.closing), Pieces: pcs(r.closing), "Rate ₹ / dozen": rate, "Value ₹": Math.round(n(r.closing) * rate * 100) / 100, "Last received": r.last_in || "", "Last sent / sold": r.last_out || "" }
          : { ...where(d), Category: catOf(p), SKU: p?.item_name || p?.sku || "", "Opening (dz)": dz(r.opening), "Received (dz)": dz(r.qty_in), "Sent / sold (dz)": dz(r.qty_out), "Closing (dz)": dz(r.closing), "Closing (pieces)": pcs(r.closing),
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
          ? { ...where(d), "Products in stock": t.products, Dozens: dz(t.closing), Pieces: pcs(t.closing), "Value ₹": Math.round(t.value) }
          : { ...where(d), "Opening (dz)": dz(t.opening), "Received (dz)": dz(t.inq), "Sent / sold (dz)": dz(t.outq), "Closing (dz)": dz(t.closing), "Closing (pieces)": pcs(t.closing), "Products in stock": t.products, "Closing value ₹": Math.round(t.value) };
      });
      const wb = XLSX.utils.book_new();
      const title = period === "latest" ? `Latest stock as on ${dmy(today())}` : `Stock from ${dmy(range.from)} to ${dmy(range.to)}`;
      const sheet = (data: object[], empty: string) => (data.length ? XLSX.utils.json_to_sheet(data) : XLSX.utils.aoa_to_sheet([[empty]]));
      XLSX.utils.book_append_sheet(wb, detail.length ? grouped(detail, ["Location", "Code", "Type", "State", "Region", "Super stockist"], "Category") : sheet(detail, `No stock for this selection. ${title}.`), "Stock");
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
  // One location's stock by category (dozens, pieces, value), each category opening to its SKUs.
  const cats = (id: string) => {
    const m = new Map<string, { dz: number; value: number; items: { name: string; dz: number; value: number }[] }>();
    stock.filter(s => s.distributor_id === id && n(s.current_stock)).forEach(s => {
      const c = catOf(productById.get(s.product_id)), e = m.get(c) || { dz: 0, value: 0, items: [] };
      e.dz += n(s.current_stock); e.value += n(s.stock_value); e.items.push({ name: s.item_name, dz: n(s.current_stock), value: n(s.stock_value) }); m.set(c, e);
    });
    return [...m].sort((a, b) => b[1].value - a[1].value);
  };
  const breakdown = (id: string) => <div className="sk-cats">{cats(id).map(([c, e]) => <details key={c}><summary><b>{c}</b><span>{fmt(dz(e.dz))} dz · {fmt(pcs(e.dz))} pcs</span><span>{money(e.value)}</span></summary>
    <table className="nice"><thead><tr><th>SKU</th><th>Dozens</th><th>Pieces</th><th>Value</th></tr></thead><tbody>{e.items.sort((a, b) => b.value - a.value).map(i => <tr key={i.name}><td>{i.name}</td><td>{fmt(dz(i.dz))}</td><td>{fmt(pcs(i.dz))}</td><td>{money(i.value)}</td></tr>)}</tbody></table></details>)}</div>;
  const row = (d: Distributor, cls = "") => { const e = perLoc.get(d.id) || zero; return <div key={d.id} className="sk-item"><label className={`sk-row ${cls}${e.units ? "" : " none"}`}>
    <input type="checkbox" checked={sel.has(d.id)} onChange={ev => toggle([d.id], ev.target.checked)} />
    <span className="sk-name">{d.name}<small>{d.code}{d.territory ? ` · ${d.territory}` : ""}{d.status === "DORMANT" ? " · dormant" : ""}</small></span>
    <span className="sk-num">{e.units ? money(e.value) : "no stock"}<small>{e.units ? `${fmt(dz(e.units))} dz · ${fmt(pcs(e.units))} pcs · ${e.products} SKUs${e.last ? ` · ${dmy(e.last)}` : ""}` : e.last ? `last update ${dmy(e.last)}` : "never uploaded"}</small></span>
    {e.units > 0 && <button className="secondary small" aria-expanded={openLoc === d.id} title="Their stock grouped by category, each opening to its SKUs" onClick={ev => { ev.preventDefault(); setOpenLoc(openLoc === d.id ? null : d.id); }}>{openLoc === d.id ? "Hide" : "Stock By Category"}</button>}
  </label>{openLoc === d.id && breakdown(d.id)}</div>; };

  return <><section className="card">
    <div className="rowhead"><h2>Stock At A Glance</h2>
      <div className="actions"><input className="search" placeholder="Search a location…" value={search} onChange={e => setSearch(e.target.value)} />
        <label className="inline"><input type="checkbox" checked={onlyStock} onChange={e => setOnlyStock(e.target.checked)} /> Only those holding stock</label></div></div>
    <p className="hint">Who holds how much stock right now, valued at SS rate, by state and super stockist. It updates as soon as stock is saved. "Stock By Category" opens a location's stock by category and SKU. Tick locations to download just those (Download Stock, lower down).</p>
    <div className="sk-tree">{tree.map(([state, g]) => {
      const all = [...[...g.ss.entries()].flatMap(([ssId, ds]) => [...(byId.get(ssId) ? [byId.get(ssId)!] : []), ...ds]), ...g.godowns];
      const shown = all.filter(d => hit(d) && (!onlyStock || holds(d)));
      if (!shown.length) return null;
      const tot = sum(all);
      return <details key={state} className="rt-state" open={!!t || tree.length <= 2}>
        <summary><h3>{state}</h3><span className="rt-badge">{money(tot.value)}</span><span className="rt-badge">{fmt(dz(tot.units))} dz</span><span className="rt-badge">{all.filter(holds).length} of {all.length} hold stock</span></summary>
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
                <span className="kind">SS</span><b>{ss?.name || "No super stockist / direct"}</b>
                <span className="rt-badge">{money(tt.value)}</span><span className="rt-badge">{ss ? `SS own ${money(perLoc.get(ss.id)?.value || 0)}` : ""}</span><span className="rt-badge">{kids.length} distributors</span></summary>
              {open && <div className="sk-list">{ss && row(ss, "ssrow")}{kids.map(d => row(d))}</div>}
            </details>;
          })}
        </div>
      </details>;
    })}</div>
  </section>
  {children}
  <section className="card">
    <h2>Download Stock</h2>
    <p className="hint">An Excel file of stock by location, category and SKU, in dozens and pieces. It covers the locations ticked in Stock At A Glance, or everything.</p>
    <div className="actions downloadrow">
      <div className="periodpick">
        <label className="inline"><input type="radio" name="period" checked={period === "latest"} onChange={() => setPeriod("latest")} /> Latest stock</label>
        <label className="inline"><input type="radio" name="period" checked={period === "range"} onChange={() => setPeriod("range")} /> For a date range</label>
        {period === "range" && <DateRange value={range} onChange={setRange} />}
      </div>
      <button onClick={download} disabled={busy || !picked.length}>{busy ? "Preparing…" : sel.size ? `Download ${sel.size} Selected` : "Download All"}</button>
      {sel.size > 0 && <button className="link" onClick={() => setSel(new Set())}>Clear Selection</button>}
      <span className="hint">{sel.size ? `${picked.length} selected` : `All ${picked.length} locations`} · {fmt(dz(units))} dz · {money(value)}</span>
    </div>
  </section></>;
}
