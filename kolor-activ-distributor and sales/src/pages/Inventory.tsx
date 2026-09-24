import { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import {
  Mode, Row, Field, Table, Layout, Skipped, FIELD_LABELS, emptyRow, today, isValidDate,
  detectLayout, extractRows, titleText, detectDistributor, cellText,
} from "../lib/parse";
import { readAnyFile, fileHash, ACCEPT } from "../lib/readers";
import { supabase, Distributor, Product, StockLine, matchDistributor, matchProduct, fmt, errText } from "../lib/supabase";

const MODES: { id: Mode; label: string; help: string }[] = [
  { id: "INPUT", label: "Stock IN", help: "Purchases from HO, receipts, opening stock. Adds to the distributor's stock." },
  { id: "OUTPUT", label: "Stock OUT", help: "Sales to retailers, dispatches. Reduces stock and is blocked if stock is not enough." },
  { id: "COUNT", label: "Stock count (Tally closing stock)", help: "Upload a distributor's Tally Stock Summary. The app sets their stock to these closing quantities and records the difference." },
];

interface Props {
  distributors: Distributor[]; products: Product[]; stock: StockLine[];
  onPosted: () => Promise<void>; notify: (m: string) => void;
}

export default function Inventory({ distributors, products, stock, onPosted, notify }: Props) {
  const [mode, setMode] = useState<Mode>("INPUT");
  const [table, setTable] = useState<Table | null>(null);
  const [sheet, setSheet] = useState(0);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [file, setFile] = useState<{ name: string; hash: string } | null>(null);
  const [distributor, setDistributor] = useState("");
  const [date, setDate] = useState(today());
  const [rows, setRows] = useState<Row[]>([]);
  const [skipped, setSkipped] = useState<Skipped[]>([]);
  const [busy, setBusy] = useState(""); const [showSkipped, setShowSkipped] = useState(false);
  const [detectedFrom, setDetectedFrom] = useState("");

  const grid = table?.sheets[sheet]?.grid || [];

  function reextract(t: Table | null, sh: number, l: Layout | null, m: Mode, dist: string, d: string) {
    if (!t || !l) return;
    const g = t.sheets[sh]?.grid || [];
    const res = extractRows(g, l, m, { distributor: dist, date: d }, t.fillDown !== false);
    setRows(res.rows); setSkipped(res.skipped);
  }
  function relayout(t: Table, sh: number, m: Mode, dist?: string) {
    const g = t.sheets[sh]?.grid || [];
    const l = detectLayout(g, m);
    let dd = dist ?? distributor;
    if (dist === undefined) {
      const auto = detectDistributor(`${titleText(g, l)} ${file?.name || ""}`, distributors);
      if (auto) { dd = auto; setDistributor(auto); setDetectedFrom("file heading"); }
    }
    setLayout(l); reextract(t, sh, l, m, dd, date);
    return l;
  }

  async function onFile(f: File) {
    setBusy(`Reading ${f.name}…`);
    try {
      const [t, hash] = await Promise.all([readAnyFile(f, setBusy), fileHash(f)]);
      if (!t.sheets.length) throw new Error("The file is empty.");
      setTable(t); setSheet(0); setFile({ name: f.name, hash }); setDetectedFrom("");
      const g = t.sheets[0].grid;
      const l = detectLayout(g, mode);
      const auto = detectDistributor(`${titleText(g, l)} ${f.name}`, distributors);
      const dd = auto || distributor;
      if (auto) { setDistributor(auto); setDetectedFrom("file heading / name"); }
      setLayout(l);
      const res = extractRows(g, l, mode, { distributor: dd, date }, t.fillDown !== false);
      setRows(res.rows); setSkipped(res.skipped);
      notify(l.headerRow < 0
        ? `Couldn't find column headings in ${f.name}. Pick what each column is in "Columns" below.`
        : `${res.rows.length} rows read from ${f.name} (${t.source}).${res.skipped.length ? ` ${res.skipped.length} lines left out — see "Left out".` : ""} Check them before posting.`);
      if (t.note) notify(t.note);
    } catch (e) { notify(`Could not read the file: ${errText(e)}`); }
    finally { setBusy(""); }
  }

  function changeMode(m: Mode) { setMode(m); if (table) relayout(table, sheet, m, distributor); }
  function changeSheet(i: number) { setSheet(i); if (table) relayout(table, i, mode, distributor); }
  function changeColumn(i: number, f: Field) {
    if (!layout || !table) return;
    const mapping = layout.mapping.map((m, j) => (j === i ? f : f !== "ignore" && m === f ? "ignore" : m)) as Field[];
    const l = { ...layout, mapping };
    setLayout(l); reextract(table, sheet, l, mode, distributor, date);
  }
  function setAll(k: "distributor" | "date", v: string) {
    if (k === "distributor") { setDistributor(v); setDetectedFrom(""); } else setDate(v);
    setRows(rs => rs.map(r => ({ ...r, [k]: v })));
  }
  function updateRow(i: number, k: keyof Row, v: string) {
    setRows(rs => rs.map((r, j) => (j === i ? { ...r, [k]: k === "quantity" || k === "unit_price" ? Number(v.replace(/,/g, "")) || 0 : v } : r)));
  }
  function restore(s: Skipped) {
    if (!s.row) return;
    setRows(rs => [...rs, s.row!]); setSkipped(ss => ss.filter(x => x !== s));
  }
  function clearAll() { setTable(null); setLayout(null); setRows([]); setSkipped([]); setFile(null); setDetectedFrom(""); }

  // Row checks shown before posting.
  const stockFor = useMemo(() => {
    const m = new Map<string, number>();
    stock.forEach(s => m.set(`${s.distributor_id}|${s.product_id}`, Number(s.current_stock)));
    return m;
  }, [stock]);
  const countDist = matchDistributor(distributor, distributors);
  const checked = rows.map(r => {
    const d = mode === "COUNT" ? countDist : matchDistributor(r.distributor, distributors);
    const p = matchProduct(r.sku, r.item_name, products);
    const cur = d && p ? stockFor.get(`${d.id}|${p.id}`) ?? 0 : 0;
    const problems: string[] = [];
    if (!d) problems.push(r.distributor || mode === "COUNT" ? "unknown distributor" : "distributor missing");
    if (!r.sku.trim() && !r.item_name.trim()) problems.push("product missing");
    if (mode === "OUTPUT" && !p) problems.push("product never stocked in");
    if (mode === "OUTPUT" && p && d && r.quantity > cur) problems.push(`only ${fmt(cur)} in stock`);
    if (mode === "OUTPUT" && !r.retailer.trim()) problems.push("retailer missing");
    if (mode !== "COUNT" && !(r.quantity > 0)) problems.push("quantity must be > 0");
    if (mode === "COUNT" && r.quantity < 0) problems.push("negative");
    if (!isValidDate(r.date)) problems.push("bad date");
    return { d, p, cur, problems };
  });
  const problemCount = checked.filter(c => c.problems.length).length;
  const newProducts = checked.filter(c => !c.p).length;

  async function post(allowDuplicate = false): Promise<void> {
    if (!supabase) return;
    if (!rows.length) return notify("Nothing to post.");
    if (problemCount) return notify(`Fix the ${problemCount} highlighted row(s) first, or remove them.`);
    const what = mode === "COUNT"
      ? `Set stock for ${countDist?.name} to the counted quantities of ${rows.length} products?`
      : `Post ${rows.length} ${mode === "INPUT" ? "stock IN" : "stock OUT"} rows?`;
    if (!allowDuplicate && !confirm(`${what}${newProducts && mode !== "OUTPUT" ? `\n\n${newProducts} new product(s) will be created.` : ""}`)) return;
    setBusy("Posting…");
    const clean = rows.map(r => ({ ...r, distributor: r.distributor.trim(), sku: r.sku.trim(), item_name: r.item_name.trim(), retailer: r.retailer.trim() }));
    const { data, error } = mode === "COUNT"
      ? await supabase.rpc("post_stock_count", { p_distributor: countDist!.code, p_rows: clean, p_date: date, p_source_file: file?.name ?? "manual entry", p_file_hash: file?.hash ?? null, p_allow_duplicate: allowDuplicate })
      : await supabase.rpc("post_inventory_batch", { p_mode: mode, p_rows: clean, p_source_file: file?.name ?? "manual entry", p_file_hash: file?.hash ?? null, p_allow_duplicate: allowDuplicate });
    setBusy("");
    if (error) {
      if (error.message.startsWith("DUPLICATE_FILE")) {
        if (confirm(`${error.message.replace("DUPLICATE_FILE: ", "")}.\n\nPosting it again will count this stock twice. Post anyway?`)) return post(true);
        return notify("Not posted: this file was already posted.");
      }
      return notify(`Post failed: ${error.message}`);
    }
    notify(mode === "COUNT"
      ? `Stock count saved: ${data.increased} products increased, ${data.decreased} decreased, ${data.unchanged} unchanged. You can undo it from History.`
      : `Posted ${data.posted_rows} rows. You can undo it from History.`);
    clearAll();
    await onPosted();
  }

  function downloadTemplate() {
    const sample = mode === "COUNT"
      ? [{ SKU: "", Product: "KA Lipstick Red 01", "Closing Qty": 0, Rate: 0 }]
      : [{ Date: today(), Invoice: "", Distributor: distributors[0]?.code || "", SKU: "", Product: "", Qty: 0, Rate: 0, Retailer: "" }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sample), "Inventory");
    XLSX.writeFile(wb, `${mode.toLowerCase()}-template.xlsx`);
  }

  const cols: (keyof Row)[] = mode === "COUNT" ? ["sku", "item_name", "quantity", "unit_price"] : ["date", "reference", "distributor", "sku", "item_name", "quantity", "unit_price", "retailer"];
  const COL_LABEL: Record<keyof Row, string> = { date: "Date", reference: "Invoice / Ref", distributor: "Distributor", sku: "SKU", item_name: "Product", quantity: mode === "COUNT" ? "Counted qty" : "Qty", unit_price: "Rate", retailer: "Retailer" };

  return <>
    <section className="tabs">
      {MODES.map(m => <button key={m.id} className={mode === m.id ? "active" : ""} onClick={() => changeMode(m.id)}>{m.label}</button>)}
    </section>

    <section className="card upload">
      <div className="rowhead">
        <div><h2>{MODES.find(m => m.id === mode)!.label}</h2><p>{MODES.find(m => m.id === mode)!.help}</p></div>
        <button className="secondary" onClick={downloadTemplate}>Download Excel template</button>
      </div>
      <label className="drop">
        <input type="file" accept={ACCEPT} disabled={!!busy} onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
        <b>{busy || "Choose a file"}</b>
        <small>Excel, CSV, Tally exports (Excel, XML, JSON, HTML, ASCII/TXT, PDF), scanned PDFs and photos</small>
      </label>
      {mode === "COUNT" && <p className="hint">In Tally: <b>Stock Summary</b> → press <b>Alt+F5</b> (Detailed) so items show under their groups → <b>Alt+E</b> Export → Excel or XML. Products missing from the file keep their current stock.</p>}
      <div className="bulk">
        <label>Distributor {detectedFrom && <em className="tag">auto-detected from {detectedFrom}</em>}
          <select value={matchDistributor(distributor, distributors)?.code || ""} onChange={e => setAll("distributor", e.target.value)}>
            <option value="">{distributor && !countDist ? `"${distributor}" — not in list` : "Choose…"}</option>
            {distributors.map(d => <option key={d.id} value={d.code}>{d.name} ({d.code})</option>)}
          </select></label>
        <label>{mode === "COUNT" ? "Stock count date" : "Date for rows without a date"}<input type="date" value={date} onChange={e => setAll("date", e.target.value)} /></label>
      </div>
      {!distributors.length && <p className="warn">No distributors yet. Add them on the Distributors page first.</p>}
      <button className="secondary" onClick={() => setRows(rs => [...rs, { ...emptyRow(), distributor, date }])}>+ Add row manually</button>
    </section>

    {table && layout && <section className="card">
      <div className="rowhead"><h2>Columns in {file?.name}</h2>
        {table.sheets.length > 1 && <label className="inline">Sheet <select value={sheet} onChange={e => changeSheet(Number(e.target.value))}>{table.sheets.map((s, i) => <option key={i} value={i}>{s.name}</option>)}</select></label>}
      </div>
      <p className="hint">Check what each column is. Change a column here if something was picked wrongly — the rows below are re-read (manual edits are lost).</p>
      <div className="tablewrap"><table className="map"><tbody>
        <tr>{layout.labels.map((l, i) => <td key={i}><small>{l || `column ${i + 1}`}</small>
          <select value={layout.mapping[i] || "ignore"} onChange={e => changeColumn(i, e.target.value as Field)}>
            {(Object.keys(FIELD_LABELS) as Field[]).map(f => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}
          </select>
          <small className="sample">{cellText(grid[layout.headerRow + Math.max(layout.headerRows, 1)]?.[i]).slice(0, 24)}</small></td>)}</tr>
      </tbody></table></div>
    </section>}

    {(rows.length > 0 || skipped.length > 0) && <section className="card">
      <div className="rowhead"><h2>Review ({rows.length} rows{problemCount ? `, ${problemCount} need fixing` : ""})</h2>
        <div className="actions"><button className="secondary" onClick={clearAll}>Clear</button>
          <button onClick={() => post()} disabled={!!busy || !rows.length}>{busy === "Posting…" ? "Posting…" : mode === "COUNT" ? "Save stock count" : `Post ${mode === "INPUT" ? "stock IN" : "stock OUT"}`}</button></div></div>
      {newProducts > 0 && mode !== "OUTPUT" && <p className="hint">{newProducts} product(s) are not in the product list yet and will be created (marked <span className="tag">new</span>). If one is just spelled differently, correct the name or SKU to match an existing product.</p>}
      <div className="tablewrap"><table className="edit"><thead><tr>
        {cols.map(h => <th key={h}>{COL_LABEL[h]}</th>)}
        {mode === "COUNT" && <><th>Current</th><th>Change</th></>}
        <th>Check</th><th /></tr></thead>
        <tbody>{rows.map((r, i) => {
          const ck = checked[i];
          const diff = r.quantity - ck.cur;
          return <tr key={i} className={ck.problems.length ? "bad" : ""}>
            {cols.map(k => <td key={k}><input className={k} type={k === "quantity" || k === "unit_price" ? "number" : k === "date" ? "date" : "text"} value={r[k]} onChange={e => updateRow(i, k, e.target.value)} /></td>)}
            {mode === "COUNT" && <><td>{fmt(ck.cur)}</td><td className={diff > 0 ? "in" : diff < 0 ? "out" : ""}>{diff > 0 ? "+" : ""}{fmt(diff)}</td></>}
            <td className="check">{ck.problems.length ? <span className="err">{ck.problems.join(", ")}</span> : !ck.p ? <span className="tag">new</span> : <span className="ok">✓</span>}</td>
            <td><button className="del" title="Remove row" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}>✕</button></td>
          </tr>;
        })}</tbody></table></div>
      {skipped.length > 0 && <div className="skipped">
        <button className="link" onClick={() => setShowSkipped(s => !s)}>{showSkipped ? "▾" : "▸"} Left out ({skipped.length}) — totals, group lines, blank quantities</button>
        {showSkipped && <table><tbody>{skipped.map((s, i) => <tr key={i}><td>Line {s.line}</td><td>{s.text}</td><td><small>{s.reason}</small></td>
          <td>{s.row && <button className="secondary small" onClick={() => restore(s)}>Add back</button>}</td></tr>)}</tbody></table>}
      </div>}
    </section>}
  </>;
}
