import { useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import {
  Mode, Row, Field, Table, Layout, Skipped, FIELD_LABELS, emptyRow, today, isValidDate,
  detectLayout, extractRows, titleText, detectDistributor, cellText, formatSignature, normName,
} from "../lib/parse";
import { readAnyFile, fileHash, ACCEPT } from "../lib/readers";
import { supabase, Distributor, Product, ProductAlias, StockLine, matchDistributor, matchProduct, fmt, errText } from "../lib/supabase";

const MODES: { id: Mode; label: string; help: string }[] = [
  { id: "INPUT", label: "Stock IN", help: "Purchases from HO, receipts, opening stock. Adds to the distributor's stock." },
  { id: "OUTPUT", label: "Stock OUT", help: "Sales to retailers, dispatches. Reduces stock and is blocked if stock is not enough." },
  { id: "COUNT", label: "Stock count (closing stock)", help: "Upload a distributor's closing stock — your stock format or their Tally Stock Summary. Their stock is set to these quantities and the difference is recorded." },
];

interface Props {
  distributors: Distributor[]; products: Product[]; aliases: ProductAlias[]; stock: StockLine[]; canManage: boolean;
  onPosted: () => Promise<void>; onDistributorsChanged: () => Promise<void>; notify: (m: string) => void;
}

export default function Inventory({ distributors, products, aliases, stock, canManage, onPosted, onDistributorsChanged, notify }: Props) {
  const [mode, setMode] = useState<Mode>("INPUT");
  const [table, setTable] = useState<Table | null>(null);
  const [sheet, setSheet] = useState(0);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [file, setFile] = useState<{ name: string; hash: string; heading: string } | null>(null);
  const [distributor, setDistributor] = useState("");
  const [date, setDate] = useState(today());
  const [rows, setRows] = useState<Row[]>([]);
  const [skipped, setSkipped] = useState<Skipped[]>([]);
  const [busy, setBusy] = useState(""); const [showSkipped, setShowSkipped] = useState(false);
  const [detectedFrom, setDetectedFrom] = useState("");
  const [savedFormat, setSavedFormat] = useState(false);
  const [aliasPlan, setAliasPlan] = useState<Record<string, { productId: string; name: string }>>({});
  const [status, setStatus] = useState<{ kind: "err" | "ok" | "info"; text: string } | null>(null);
  const reviewRef = useRef<HTMLDivElement>(null);

  const grid = table?.sheets[sheet]?.grid || [];
  const say = (kind: "err" | "ok" | "info", text: string) => { setStatus({ kind, text }); notify(text); };

  function extract(t: Table, sh: number, l: Layout, m: Mode, dist: string, d: string) {
    const res = extractRows(t.sheets[sh]?.grid || [], l, m, { distributor: dist, date: d }, t.fillDown !== false);
    setRows(res.rows); setSkipped(res.skipped);
    return res;
  }

  /** Detect columns, then override with a saved layout for files with the same headings. */
  async function layoutFor(g: Table["sheets"][number]["grid"], m: Mode): Promise<{ l: Layout; saved: boolean }> {
    const l = detectLayout(g, m);
    if (!supabase || l.headerRow < 0) return { l, saved: false };
    const { data } = await supabase.from("import_formats").select("mapping").eq("signature", `${m}:${formatSignature(l)}`).maybeSingle();
    const saved = data?.mapping as Field[] | undefined;
    if (saved && saved.length === l.labels.length) return { l: { ...l, mapping: saved }, saved: true };
    return { l, saved: false };
  }

  async function load(t: Table, sh: number, m: Mode, f: { name: string; hash: string; heading: string } | null, keepDistributor: boolean) {
    const g = t.sheets[sh]?.grid || [];
    const { l, saved } = await layoutFor(g, m);
    const heading = titleText(g, l);
    let dd = distributor;
    if (!keepDistributor) {
      const auto = detectDistributor(`${heading} ${f?.name || ""}`, distributors);
      dd = auto || "";
      setDistributor(dd); setDetectedFrom(auto ? "file heading / name" : "");
    }
    if (f) setFile({ ...f, heading });
    setLayout(l); setSavedFormat(saved); setAliasPlan({});
    return { l, res: extract(t, sh, l, m, dd, date) };
  }

  async function onFile(f: File) {
    setBusy(`Reading ${f.name}…`); setStatus(null);
    try {
      const [t, hash] = await Promise.all([readAnyFile(f, setBusy), fileHash(f)]);
      if (!t.sheets.length) throw new Error("The file is empty.");
      setTable(t); setSheet(0);
      const { l, res } = await load(t, 0, mode, { name: f.name, hash, heading: "" }, false);
      if (l.headerRow < 0) say("info", `Couldn't find column headings in ${f.name}. Pick what each column is under "Columns" — the app will remember it for next time.`);
      else say("info", `${res.rows.length} rows read from ${f.name}.${res.skipped.length ? ` ${res.skipped.length} lines left out (totals, groups, blanks).` : ""} Check them, then save.`);
      if (t.note) notify(t.note);
      setTimeout(() => reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } catch (e) { say("err", `Could not read the file: ${errText(e)}`); }
    finally { setBusy(""); }
  }

  function changeMode(m: Mode) { setMode(m); setStatus(null); if (table) load(table, sheet, m, null, true); }
  function changeSheet(i: number) { setSheet(i); if (table) load(table, i, mode, null, true); }
  function changeColumn(i: number, f: Field) {
    if (!layout || !table) return;
    const mapping = layout.mapping.map((m, j) => (j === i ? f : f !== "ignore" && m === f ? "ignore" : m)) as Field[];
    const l = { ...layout, mapping };
    setLayout(l); setSavedFormat(false); extract(table, sheet, l, mode, distributor, date);
  }
  function setAll(k: "distributor" | "date", v: string) {
    if (k === "distributor") { setDistributor(v); setDetectedFrom(""); } else setDate(v);
    setRows(rs => rs.map(r => ({ ...r, [k]: v })));
  }
  function updateRow(i: number, k: keyof Row, v: string) {
    setRows(rs => rs.map((r, j) => (j === i ? { ...r, [k]: k === "quantity" || k === "unit_price" ? Number(v.replace(/,/g, "")) || 0 : v } : r)));
  }
  function restore(s: Skipped) { if (s.row) { setRows(rs => [...rs, s.row!]); setSkipped(ss => ss.filter(x => x !== s)); } }
  function clearAll() { setTable(null); setLayout(null); setRows([]); setSkipped([]); setFile(null); setDetectedFrom(""); setAliasPlan({}); setStatus(null); }

  /** "This name in the file = that existing product" — applied to every row with the same name and remembered on save. */
  function matchTo(original: string, value: string) {
    const p = products.find(x => `${x.sku} — ${x.item_name}` === value);
    const key = normName(original);
    if (!p) {
      setAliasPlan(a => { const { [key]: _, ...rest } = a; return rest; });
      setRows(rs => rs.map(r => (normName(r.item_name) === key && aliasPlan[key] ? { ...r, sku: "" } : r)));
      return;
    }
    setAliasPlan(a => ({ ...a, [key]: { productId: p.id, name: original } }));
    setRows(rs => rs.map(r => (normName(r.item_name) === key ? { ...r, sku: p.sku } : r)));
  }

  // ---------- unknown distributor quick fixes ----------
  const countDist = matchDistributor(distributor, distributors);
  const unknownNames = useMemo(() => {
    const names = new Set<string>();
    if (mode === "COUNT") { if (!countDist && distributor.trim()) names.add(distributor.trim()); }
    else rows.forEach(r => { if (r.distributor.trim() && !matchDistributor(r.distributor, distributors)) names.add(r.distributor.trim()); });
    return [...names];
  }, [rows, distributor, distributors, mode, countDist]);
  const headingName = (file?.heading || "").split(" | ")[0]?.replace(/^m\/?s\.?\s+/i, "").trim() || "";
  const [fix, setFix] = useState({ name: "", target: "" });

  async function addAlias(name: string, targetCode: string) {
    const d = distributors.find(x => x.code === targetCode);
    if (!supabase || !d || !name.trim()) return;
    const { error } = await supabase.from("distributors").update({ aliases: [...new Set([...(d.aliases || []), name.trim()])] }).eq("id", d.id);
    if (error) return say("err", `Could not save: ${error.message}`);
    await onDistributorsChanged();
    setRows(rs => rs.map(r => (normName(r.distributor) === normName(name) || !r.distributor ? { ...r, distributor: d.code } : r)));
    setDistributor(d.code);
    say("ok", `"${name}" saved as another name for ${d.name}. Files with this name will match automatically from now on.`);
  }
  async function createDistributor(name: string) {
    if (!supabase || !name.trim()) return;
    const nums = distributors.map(d => Number(d.code.match(/^D(\d+)$/i)?.[1] || 0));
    const code = `D${String(Math.max(0, ...nums) + 1).padStart(3, "0")}`;
    const { error } = await supabase.from("distributors").insert({ code, name: name.trim(), aliases: [] });
    if (error) return say("err", `Could not add distributor: ${error.message}`);
    await onDistributorsChanged();
    setRows(rs => rs.map(r => (normName(r.distributor) === normName(name) || !r.distributor ? { ...r, distributor: code } : r)));
    setDistributor(code);
    say("ok", `Added ${name.trim()} as ${code}. Fill in owner, company and super stockist on the Distributors page.`);
  }

  // ---------- row checks ----------
  const stockFor = useMemo(() => {
    const m = new Map<string, number>();
    stock.forEach(s => m.set(`${s.distributor_id}|${s.product_id}`, Number(s.current_stock)));
    return m;
  }, [stock]);
  const checked = rows.map(r => {
    const d = mode === "COUNT" ? countDist : matchDistributor(r.distributor, distributors);
    const p = matchProduct(r.sku, r.item_name, products, aliases);
    const cur = d && p ? stockFor.get(`${d.id}|${p.id}`) ?? 0 : 0;
    const problems: string[] = [];
    if (!d) problems.push(mode === "COUNT" ? "choose the distributor above" : r.distributor ? `"${r.distributor}" not in distributor list` : "distributor missing");
    if (!r.sku.trim() && !r.item_name.trim()) problems.push("product missing");
    if (mode === "OUTPUT" && !p && (r.sku || r.item_name)) problems.push("product never stocked in — match it to an existing product");
    if (mode === "OUTPUT" && p && d && r.quantity > cur) problems.push(`only ${fmt(cur)} in stock`);
    if (mode === "OUTPUT" && !r.retailer.trim()) problems.push("retailer missing");
    if (mode !== "COUNT" && !(r.quantity > 0)) problems.push("quantity must be more than 0");
    if (mode === "COUNT" && r.quantity < 0) problems.push("negative quantity");
    if (!isValidDate(r.date)) problems.push("date must be a valid date");
    return { d, p, cur, problems };
  });
  const problemRows = checked.map((c, i) => (c.problems.length ? i : -1)).filter(i => i >= 0);
  const newProducts = checked.filter(c => !c.p).length;
  const blocker = !rows.length ? "Nothing to save yet."
    : problemRows.length ? `${problemRows.length} row(s) need fixing — see the red "Check" column${unknownNames.length || (mode === "COUNT" && !countDist) ? " and the distributor box above the table" : ""}.`
    : "";

  async function post(allowDuplicate = false): Promise<void> {
    if (!supabase) return;
    if (blocker) {
      say("err", blocker);
      document.querySelector("tr.bad")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const what = mode === "COUNT"
      ? `Set stock for ${countDist?.name} to the counted quantities of ${rows.length} products?`
      : `Post ${rows.length} ${mode === "INPUT" ? "stock IN" : "stock OUT"} rows?`;
    if (!allowDuplicate && !confirm(`${what}${newProducts && mode !== "OUTPUT" ? `\n\n${newProducts} new product(s) will be created.` : ""}`)) return;
    setBusy("Saving…"); setStatus({ kind: "info", text: "Saving…" });
    const clean = rows.map(r => ({ ...r, distributor: r.distributor.trim(), sku: r.sku.trim(), item_name: r.item_name.trim(), retailer: r.retailer.trim() }));
    const { data, error } = mode === "COUNT"
      ? await supabase.rpc("post_stock_count", { p_distributor: countDist!.code, p_rows: clean, p_date: date, p_source_file: file?.name ?? "manual entry", p_file_hash: file?.hash ?? null, p_allow_duplicate: allowDuplicate })
      : await supabase.rpc("post_inventory_batch", { p_mode: mode, p_rows: clean, p_source_file: file?.name ?? "manual entry", p_file_hash: file?.hash ?? null, p_allow_duplicate: allowDuplicate });
    setBusy("");
    if (error) {
      if (error.message.startsWith("DUPLICATE_FILE")) {
        if (confirm(`${error.message.replace("DUPLICATE_FILE: ", "")}.\n\nSaving it again will count this stock twice. Save anyway?`)) return post(true);
        return say("err", "Not saved: this file was already posted.");
      }
      return say("err", `Save failed: ${error.message}`);
    }
    // Learn from this upload: the column layout and any product matches.
    if (layout && table && layout.headerRow >= 0)
      await supabase.from("import_formats").upsert({ signature: `${mode}:${formatSignature(layout)}`, mapping: layout.mapping, labels: layout.labels, updated_at: new Date().toISOString() });
    for (const a of Object.values(aliasPlan)) await supabase.from("product_aliases").insert({ product_id: a.productId, alias: a.name });

    const msg = mode === "COUNT"
      ? `Stock count saved for ${countDist?.name}: ${data.increased} products up, ${data.decreased} down, ${data.unchanged} unchanged. Undo is on the History page.`
      : `Saved ${data.posted_rows} rows. Undo is on the History page.`;
    clearAll(); say("ok", msg);
    await onPosted();
  }

  function downloadTemplate() {
    const sample = mode === "COUNT"
      ? [{ Distributor: distributors[0]?.code || "", Date: today(), SKU: "", Product: "KA Lipstick Red 01", "Closing Qty": 0, Rate: 0 }]
      : [{ Date: today(), Invoice: "", Distributor: distributors[0]?.code || "", SKU: "", Product: "", Qty: 0, Rate: 0, Retailer: "" }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sample), "Inventory");
    XLSX.writeFile(wb, `${mode === "COUNT" ? "stock-count" : mode.toLowerCase()}-template.xlsx`);
  }

  const cols: (keyof Row)[] = mode === "COUNT" ? ["sku", "item_name", "quantity", "unit_price"] : ["date", "reference", "distributor", "sku", "item_name", "quantity", "unit_price", "retailer"];
  const COL_LABEL: Record<keyof Row, string> = { date: "Date", reference: "Invoice / Ref", distributor: "Distributor", sku: "SKU", item_name: "Product (as in file)", quantity: mode === "COUNT" ? "Counted qty" : "Qty", unit_price: "Rate", retailer: "Retailer" };
  const saveLabel = mode === "COUNT" ? "Save stock count" : `Save ${mode === "INPUT" ? "stock IN" : "stock OUT"}`;
  const showDistFix = rows.length > 0 && (unknownNames.length > 0 || (mode === "COUNT" && !countDist));
  const fixName = fix.name || unknownNames[0] || headingName;

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
        <small>Your Excel format, any Excel/CSV, Tally exports (Excel, XML, JSON, HTML, TXT, PDF), scanned PDFs and photos</small>
      </label>
      {mode === "COUNT" && <p className="hint">From Tally: <b>Stock Summary</b> → <b>Alt+F5</b> (Detailed) → <b>Alt+E</b> Export → Excel or XML. Products missing from the file keep their current stock.</p>}
      <div className="bulk">
        <label>Distributor {detectedFrom && <em className="tag">auto-detected from {detectedFrom}</em>}
          <select value={countDist?.code || matchDistributor(distributor, distributors)?.code || ""} onChange={e => setAll("distributor", e.target.value)}>
            <option value="">{distributor && !countDist ? `"${distributor}" — not in list` : "Choose…"}</option>
            {distributors.map(d => <option key={d.id} value={d.code}>{d.name} ({d.code}){d.super_stockist ? ` · ${d.super_stockist}` : ""}</option>)}
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
      <p className="hint">{savedFormat
        ? <><span className="tag">saved format</span> Columns set the same way as the last file with these headings.</>
        : <>Check what each column is and correct any that are wrong. When you save, the app remembers this setup for every future file with the same headings.</>}</p>
      {file?.heading && <p className="hint">File heading: <b>{file.heading.slice(0, 160)}</b></p>}
      <div className="tablewrap"><table className="map"><tbody>
        <tr>{layout.labels.map((l, i) => <td key={i}><small>{l || `column ${i + 1}`}</small>
          <select value={layout.mapping[i] || "ignore"} onChange={e => changeColumn(i, e.target.value as Field)}>
            {(Object.keys(FIELD_LABELS) as Field[]).map(f => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}
          </select>
          <small className="sample">{cellText(grid[layout.headerRow + Math.max(layout.headerRows, 1)]?.[i]).slice(0, 24)}</small></td>)}</tr>
      </tbody></table></div>
    </section>}

    {(rows.length > 0 || skipped.length > 0) && <section className="card" ref={reviewRef}>
      <div className="rowhead"><h2>Review ({rows.length} rows{problemRows.length ? `, ${problemRows.length} need fixing` : ""})</h2>
        <div className="actions"><button className="secondary" onClick={clearAll}>Clear</button>
          <button onClick={() => post()} disabled={!!busy || !rows.length}>{busy === "Saving…" ? "Saving…" : saveLabel}</button></div></div>
      {status && <div className={`status ${status.kind}`}>{status.text}</div>}
      {!status && blocker && rows.length > 0 && <div className="status err">{blocker}</div>}

      {showDistFix && <div className="fixbox">
        <b>{mode === "COUNT" && !distributor ? "Which distributor is this file from?" : `The file's distributor "${fixName}" isn't in your list.`}</b>
        {canManage ? <div className="fixrow">
          <label>Name in file<input value={fixName} onChange={e => setFix({ ...fix, name: e.target.value })} /></label>
          <label>It is the same as…<select value={fix.target} onChange={e => setFix({ ...fix, target: e.target.value })}>
            <option value="">choose existing distributor</option>{distributors.map(d => <option key={d.id} value={d.code}>{d.name} ({d.code})</option>)}</select></label>
          <button disabled={!fix.target || !fixName} onClick={() => addAlias(fixName, fix.target)}>Save as its other name</button>
          <span className="or">or</span>
          <button className="secondary" disabled={!fixName} onClick={() => createDistributor(fixName)}>Add “{fixName.slice(0, 30)}” as new distributor</button>
        </div> : <p className="hint">Pick the distributor in the box above, or ask an HO admin to add this name on the Distributors page.</p>}
      </div>}

      {newProducts > 0 && <p className="hint">{newProducts} product name(s) aren't in your product list{mode === "OUTPUT" ? "" : " and will be created as new products"}. If a name is just how this distributor writes one of your products, pick the product under “Same as” — the app will remember it.</p>}
      <datalist id="products-dl">{products.map(p => <option key={p.id} value={`${p.sku} — ${p.item_name}`} />)}</datalist>
      <div className="tablewrap"><table className="edit"><thead><tr>
        {cols.map(h => <th key={h}>{COL_LABEL[h]}</th>)}
        {mode === "COUNT" && <><th>Current</th><th>Change</th></>}
        <th>Same as (your product)</th><th>Check</th><th /></tr></thead>
        <tbody>{rows.map((r, i) => {
          const ck = checked[i];
          const diff = r.quantity - ck.cur;
          const plan = aliasPlan[normName(r.item_name)];
          return <tr key={i} className={ck.problems.length ? "bad" : ""}>
            {cols.map(k => <td key={k}><input className={k} type={k === "quantity" || k === "unit_price" ? "number" : k === "date" ? "date" : "text"} value={r[k]} onChange={e => updateRow(i, k, e.target.value)} /></td>)}
            {mode === "COUNT" && <><td>{fmt(ck.cur)}</td><td className={diff > 0 ? "in" : diff < 0 ? "out" : ""}>{diff > 0 ? "+" : ""}{fmt(diff)}</td></>}
            <td>{ck.p && !plan ? <small>{ck.p.item_name}</small>
              : <input className="match" list="products-dl" placeholder="new product — or pick…" defaultValue={plan ? `${products.find(p => p.id === plan.productId)?.sku} — ${products.find(p => p.id === plan.productId)?.item_name}` : ""}
                  onChange={e => matchTo(r.item_name, e.target.value)} />}</td>
            <td className="check">{ck.problems.length ? <span className="err">{ck.problems.join("; ")}</span> : plan ? <span className="tag">will remember</span> : !ck.p ? <span className="tag">new</span> : <span className="ok">✓</span>}</td>
            <td><button className="del" title="Remove row" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}>✕</button></td>
          </tr>;
        })}</tbody></table></div>
      {skipped.length > 0 && <div className="skipped">
        <button className="link" onClick={() => setShowSkipped(s => !s)}>{showSkipped ? "▾" : "▸"} Left out ({skipped.length}) — totals, group lines, blank quantities</button>
        {showSkipped && <table><tbody>{skipped.map((s, i) => <tr key={i}><td>Line {s.line}</td><td>{s.text}</td><td><small>{s.reason}</small></td>
          <td>{s.row && <button className="secondary small" onClick={() => restore(s)}>Add back</button>}</td></tr>)}</tbody></table>}
      </div>}
      <div className="footer-actions">
        {status && <div className={`status ${status.kind}`}>{status.text}</div>}
        <button onClick={() => post()} disabled={!!busy || !rows.length}>{busy === "Saving…" ? "Saving…" : saveLabel}</button>
      </div>
    </section>}
    {!rows.length && status?.kind === "ok" && <div className="status ok">{status.text}</div>}
  </>;
}
