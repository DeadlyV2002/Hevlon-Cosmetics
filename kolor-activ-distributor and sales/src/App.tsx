import { useEffect, useMemo, useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.js?url";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const supabase = url && key ? createClient(url, key) : null;

type Mode = "INPUT" | "OUTPUT";
type Page = "Dashboard" | "Distributors" | "Retailers" | "Sales" | "Collections" | "Inventory" | "Reports" | "Team";
type Row = { date: string; reference: string; distributor: string; sku: string; item_name: string; quantity: number; unit_price: number; retailer: string };
const COLS: (keyof Row)[] = ["date", "reference", "distributor", "sku", "item_name", "quantity", "unit_price", "retailer"];
const COL_LABELS: Record<keyof Row, string> = { date: "Date", reference: "Invoice / Ref", distributor: "Distributor", sku: "SKU", item_name: "Product", quantity: "Qty", unit_price: "Rate", retailer: "Retailer" };
const today = () => new Date().toISOString().slice(0, 10);
const emptyRow = (): Row => ({ date: today(), reference: "", distributor: "", sku: "", item_name: "", quantity: 0, unit_price: 0, retailer: "" });

/** Converts Excel serials, JS Dates, dd-mm-yyyy / dd/mm/yyyy and yyyy-mm-dd into yyyy-mm-dd. */
function toISODate(v: unknown): string {
  if (v === null || v === undefined || v === "") return today();
  if (v instanceof Date && !isNaN(v.getTime())) {
    const d = new Date(v.getTime() - v.getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 10);
  }
  if (typeof v === "number" && v > 20000 && v < 80000) {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/); // Indian format: day first
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return s;
}
const toNum = (v: unknown) => {
  const n = Number(String(v ?? "").replace(/[,₹\s]/g, ""));
  return isFinite(n) ? n : 0;
};
const isValidDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState(""), [password, setPassword] = useState("");
  const [page, setPage] = useState<Page>("Dashboard");
  const [mode, setMode] = useState<Mode>("INPUT"), [rows, setRows] = useState<Row[]>([]), [stock, setStock] = useState<any[]>([]);
  const [message, setMessage] = useState(""), [loading, setLoading] = useState(false), [search, setSearch] = useState("");
  const [distributors, setDistributors] = useState<any[]>([]), [retailers, setRetailers] = useState<any[]>([]);
  const [sales, setSales] = useState<any[]>([]), [collections, setCollections] = useState<any[]>([]);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => { if (session) refreshAll(); }, [session]);

  async function refreshAll() {
    await Promise.all([loadStock(), load("distributors", setDistributors), load("retailers", setRetailers), load("sales_invoices", setSales), load("collections", setCollections)]);
  }
  async function load(table: string, setter: (x: any[]) => void) {
    if (!supabase) return;
    const { data, error } = await supabase.from(table).select("*").limit(500);
    if (error) setMessage(`Could not load ${table}: ${error.message}`); else setter(data || []);
  }
  async function loadStock() {
    if (!supabase) return;
    const { data, error } = await supabase.from("distributor_stock_summary").select("*").order("distributor_name").order("sku");
    if (error) setMessage(error.message); else setStock(data || []);
  }
  async function login() {
    if (!supabase) return setMessage("Supabase environment variables are missing in Vercel.");
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setLoading(false);
    setMessage(error ? error.message : "");
  }

  function normalize(raw: Record<string, unknown>): Row {
    // Match headers case-insensitively and ignore stray spaces.
    const x: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) x[k.trim().toLowerCase()] = v;
    const pick = (...names: string[]) => { for (const n of names) if (x[n] !== undefined && x[n] !== "") return x[n]; return ""; };
    return {
      date: toISODate(pick("date", "invoice date", "bill date")),
      reference: String(pick("invoice", "invoice no", "invoice no.", "reference", "ref", "bill no")).trim(),
      distributor: String(pick("distributor", "distributor name", "distributor code")).trim(),
      sku: String(pick("sku", "item code", "code", "product code")).trim(),
      item_name: String(pick("product", "item name", "name", "product name", "description")).trim(),
      quantity: toNum(pick("qty", "quantity", "pcs")),
      unit_price: toNum(pick("rate", "price", "unit price", "mrp")),
      retailer: String(pick("retailer", "retailer name", "party", "party name")).trim(),
    };
  }

  function importExcel(file: File) {
    setLoading(true);
    const r = new FileReader();
    r.onload = () => {
      try {
        const wb = XLSX.read(r.result, { type: "array", cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const a = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
        const parsed = a.map(normalize).filter(x => x.sku || x.item_name || x.quantity);
        setRows(parsed);
        setPage("Inventory");
        setMessage(`${parsed.length} rows imported. Review before posting.`);
      } catch (e) {
        console.error(e);
        setMessage("Excel/CSV parsing failed.");
      } finally { setLoading(false); }
    };
    r.readAsArrayBuffer(file);
  }

  async function importPDF(file: File) {
    setLoading(true);
    try {
      // Loaded on demand so the login page stays light.
      const pdfjsLib = await import("pdfjs-dist");
      pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
      // isEvalSupported:false closes the pdf.js font-eval hole (CVE-2024-4367).
      const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false }).promise;

      // Rebuild text line by line using each text item's y position.
      const lines: string[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const p = await pdf.getPage(i), c = await p.getTextContent();
        const byY = new Map<number, { x: number; s: string }[]>();
        for (const it of c.items as any[]) {
          if (!it.str?.trim()) continue;
          const y = Math.round(it.transform[5] / 3) * 3;
          if (!byY.has(y)) byY.set(y, []);
          byY.get(y)!.push({ x: it.transform[4], s: it.str });
        }
        [...byY.entries()].sort((a, b) => b[0] - a[0]).forEach(([, items]) => lines.push(items.sort((a, b) => a.x - b.x).map(t => t.s).join(" ")));
      }
      let parsed = parseLines(lines);

      if (!parsed.length || lines.join(" ").trim().length < 40) {
        setMessage("Scanned PDF detected. Starting OCR…");
        const { createWorker } = await import("tesseract.js");
        const worker = await createWorker("eng");
        const ocrLines: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          setMessage(`OCR reading scanned PDF — page ${i} of ${pdf.numPages}…`);
          const pg = await pdf.getPage(i);
          const viewport = pg.getViewport({ scale: 2 });
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          await pg.render({ canvasContext: ctx, viewport }).promise;
          const result = await worker.recognize(canvas);
          ocrLines.push(...result.data.text.split(/\r?\n/));
          canvas.width = 1; canvas.height = 1;
        }
        await worker.terminate();
        parsed = parseLines(ocrLines);
      }

      if (!parsed.length) {
        setMessage("PDF was read, but no item rows were detected. Use the Excel template for this document.");
        setRows([]);
      } else {
        setRows(parsed);
        setPage("Inventory");
        setMessage(`${parsed.length} rows detected from PDF. Fill in the distributor, check every row, then post.`);
      }
    } catch (e) {
      console.error(e);
      setMessage("PDF/OCR failed. Please try a clearer PDF or the Excel template.");
    } finally { setLoading(false); }
  }

  /** Heuristic: a line that starts with a code, then a name, then qty and rate. */
  function parseLines(lines: string[]): Row[] {
    const re = /^\s*([A-Za-z0-9][A-Za-z0-9_\-/]{1,30})\s+([A-Za-z][A-Za-z0-9 .&()/'-]{2,60}?)\s+(\d[\d,]*(?:\.\d+)?)\s+(\d[\d,]*(?:\.\d+)?)\b/;
    const skipWords = /^(gstin|gst|invoice|total|sub|page|date|phone|mobile|state|hsn|sr|s\.no|no\.?)$/i;
    const out: Row[] = [];
    for (const line of lines) {
      const m = line.match(re);
      if (!m || skipWords.test(m[1])) continue;
      out.push({ ...emptyRow(), sku: m[1], item_name: m[2].trim(), quantity: toNum(m[3]), unit_price: toNum(m[4]) });
    }
    return out;
  }

  function updateRow(i: number, k: keyof Row, v: string) {
    setRows(rs => rs.map((r, j) => j === i ? { ...r, [k]: k === "quantity" || k === "unit_price" ? toNum(v) : v } : r));
  }
  function applyToAll(k: "distributor" | "date" | "reference" | "retailer", v: string) {
    setRows(rs => rs.map(r => ({ ...r, [k]: v })));
  }
  function validate() {
    const errors: string[] = [];
    rows.forEach((r, i) => {
      if (!r.distributor.trim()) errors.push(`Row ${i + 1}: distributor missing`);
      if (!r.sku.trim()) errors.push(`Row ${i + 1}: SKU missing`);
      if (!isValidDate(r.date)) errors.push(`Row ${i + 1}: date must be YYYY-MM-DD`);
      if (!r.quantity || r.quantity <= 0) errors.push(`Row ${i + 1}: quantity must be greater than zero`);
      if (mode === "OUTPUT" && !r.retailer.trim()) errors.push(`Row ${i + 1}: retailer required for output`);
    });
    return errors;
  }
  async function post() {
    if (!supabase || !session) return setMessage("Please sign in.");
    const errors = validate();
    if (errors.length) return setMessage(errors.slice(0, 5).join(" • ") + (errors.length > 5 ? ` (+${errors.length - 5} more)` : ""));
    if (!confirm(`Post ${rows.length} ${mode} rows? This cannot be undone from the app.`)) return;
    setLoading(true);
    const clean = rows.map(r => ({ ...r, distributor: r.distributor.trim(), sku: r.sku.trim(), retailer: r.retailer.trim() }));
    const { data, error } = await supabase.rpc("post_inventory_batch", { p_mode: mode, p_rows: clean });
    setLoading(false);
    if (error) setMessage(`Post failed: ${error.message}`);
    else { setMessage(`Posted ${data?.posted_rows ?? rows.length} rows.`); setRows([]); await refreshAll(); }
  }
  function downloadTemplate() {
    const ws = XLSX.utils.json_to_sheet([{ Date: today(), Invoice: "", Distributor: "", SKU: "", Product: "", Qty: 0, Rate: 0, Retailer: "" }]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Inventory");
    XLSX.writeFile(wb, `${mode.toLowerCase()}-template.xlsx`);
  }
  function exportStock() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(stock), "Stock");
    XLSX.writeFile(wb, "distributor-stock-report.xlsx");
  }
  const filtered = useMemo(() => stock.filter(x => `${x.distributor_name} ${x.sku} ${x.item_name}`.toLowerCase().includes(search.toLowerCase())), [stock, search]);

  if (!supabase) return <div className="login"><div className="loginCard"><div className="brand">KA</div><h1>Setup needed</h1><p>VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are not set in Vercel. Add them and redeploy.</p></div></div>;

  if (!session) return (
    <div className="login"><form className="loginCard" onSubmit={e => { e.preventDefault(); login(); }}>
      <div className="brand">KA</div><h1>Kolor Activ</h1><p>Distributor Sales &amp; Inventory Control</p>
      <input placeholder="Email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} />
      <input placeholder="Password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
      <button type="submit" disabled={loading}>{loading ? "Signing in…" : "Sign in"}</button>
      <small>{message || "Accounts are created by the admin."}</small>
    </form></div>
  );

  const nav: Page[] = ["Dashboard", "Distributors", "Retailers", "Sales", "Collections", "Inventory", "Reports", "Team"];
  return (
    <div className="app">
      <aside>
        <div className="logo">KA</div><strong>Kolor Activ</strong><small>Remote Control</small>
        <nav>{nav.map(n => <button key={n} className={page === n ? "nav active" : "nav"} onClick={() => setPage(n)}>{n}</button>)}</nav>
        <button className="secondary logout" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </aside>
      <main>
        <header><div><small>REMOTE CONTROL CENTER</small><h1>{page}</h1></div><span className="who">{session.user.email}</span></header>
        {message && <div className="notice" onClick={() => setMessage("")}>{message}</div>}
        {page === "Dashboard" && <Dashboard stock={stock} distributors={distributors} sales={sales} collections={collections} onInventory={() => setPage("Inventory")} />}
        {page === "Inventory" && <Inventory mode={mode} setMode={setMode} rows={rows} setRows={setRows} updateRow={updateRow} applyToAll={applyToAll} post={post} loading={loading} importExcel={importExcel} importPDF={importPDF} downloadTemplate={downloadTemplate} stock={filtered} search={search} setSearch={setSearch} exportStock={exportStock} distributors={distributors} />}
        {page === "Distributors" && <SimpleTable title="Distributors" data={distributors} hide={["id", "assigned_user"]} />}
        {page === "Retailers" && <SimpleTable title="Retailers" data={retailers} hide={["id", "distributor_id"]} />}
        {page === "Sales" && <SimpleTable title="Sales Invoices" data={sales} hide={["id"]} />}
        {page === "Collections" && <SimpleTable title="Collections" data={collections} hide={["id"]} />}
        {page === "Reports" && <Reports stock={stock} sales={sales} collections={collections} />}
        {page === "Team" && <Team />}
      </main>
    </div>
  );
}

function Dashboard({ stock, distributors, sales, collections, onInventory }: any) {
  const current = stock.reduce((a: number, x: any) => a + Number(x.current_stock || 0), 0);
  return <><div className="cards"><Metric title="Distributors" value={distributors.length} /><Metric title="Stock Units" value={current} /><Metric title="Sales Records" value={sales.length} /><Metric title="Collections" value={collections.length} /></div>
    <section className="card"><h2>Remote Inventory Control</h2><p>Manage distributor stock, sales and collections from one shared database.</p><button onClick={onInventory}>Open Inventory</button></section></>;
}
function Metric({ title, value }: any) { return <div className="metric"><small>{title}</small><b>{value}</b></div>; }

function Inventory(p: any) {
  const pickFile = (fn: (f: File) => void) => (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (f) fn(f); e.target.value = ""; };
  return <>
    <section className="tabs">
      <button className={p.mode === "INPUT" ? "active" : ""} onClick={() => p.setMode("INPUT")}>Inventory Input</button>
      <button className={p.mode === "OUTPUT" ? "active" : ""} onClick={() => p.setMode("OUTPUT")}>Inventory Output</button>
    </section>
    <section className="card upload">
      <div className="rowhead"><div><h2>{p.mode === "INPUT" ? "Distributor Stock IN" : "Distributor Stock OUT"}</h2><p>{p.mode === "INPUT" ? "HO purchases, receipts and opening stock" : "Retailer sales, dispatches and approved stock-out"}</p></div>
        <button className="secondary" onClick={p.downloadTemplate}>Download Template</button></div>
      <div className="uploadGrid">
        <label>Excel / CSV<input type="file" accept=".xlsx,.xls,.csv" disabled={p.loading} onChange={pickFile(p.importExcel)} /></label>
        <label>PDF (text or scanned)<input type="file" accept=".pdf" disabled={p.loading} onChange={pickFile(p.importPDF)} /></label>
      </div>
      <button className="secondary" onClick={() => p.setRows((rs: Row[]) => [...rs, emptyRow()])}>+ Add row manually</button>
    </section>
    {p.rows.length > 0 && <section className="card">
      <div className="rowhead"><h2>Preview ({p.rows.length})</h2>
        <div className="actions"><button className="secondary" onClick={() => p.setRows([])}>Clear</button><button onClick={p.post} disabled={p.loading}>{p.loading ? "Posting…" : `Post ${p.mode}`}</button></div></div>
      <div className="bulk">
        <label>Set distributor for all rows
          <select defaultValue="" onChange={e => e.target.value && p.applyToAll("distributor", e.target.value)}>
            <option value="">Choose…</option>
            {p.distributors.map((d: any) => <option key={d.id} value={d.code}>{d.code} — {d.name}</option>)}
          </select></label>
        <label>Set date for all rows<input type="date" onChange={e => e.target.value && p.applyToAll("date", e.target.value)} /></label>
      </div>
      <div className="tablewrap"><table className="edit"><thead><tr>{COLS.map(h => <th key={h}>{COL_LABELS[h]}</th>)}<th /></tr></thead>
        <tbody>{p.rows.map((r: Row, i: number) => <tr key={i}>
          {COLS.map(k => <td key={k}><input type={k === "quantity" || k === "unit_price" ? "number" : "text"} value={r[k]} onChange={e => p.updateRow(i, k, e.target.value)} /></td>)}
          <td><button className="del" title="Remove row" onClick={() => p.setRows((rs: Row[]) => rs.filter((_, j) => j !== i))}>✕</button></td>
        </tr>)}</tbody></table></div>
    </section>}
    <section className="card">
      <div className="rowhead"><h2>Live Distributor Stock</h2>
        <div className="actions"><input className="search" placeholder="Search…" value={p.search} onChange={e => p.setSearch(e.target.value)} /><button className="secondary" onClick={p.exportStock}>Export Excel</button></div></div>
      <div className="tablewrap"><table><thead><tr><th>Distributor</th><th>SKU</th><th>Product</th><th>IN</th><th>OUT</th><th>Current</th></tr></thead>
        <tbody>{p.stock.map((x: any) => <tr key={`${x.distributor_id}-${x.sku}`}><td>{x.distributor_name}</td><td>{x.sku}</td><td>{x.item_name}</td><td className="in">+{x.total_input}</td><td className="out">-{x.total_output}</td><td><b>{x.current_stock}</b></td></tr>)}</tbody></table>
        {!p.stock.length && <p className="empty">No stock posted yet.</p>}</div>
    </section>
  </>;
}

function SimpleTable({ title, data, hide = [] }: { title: string; data: any[]; hide?: string[] }) {
  const cols = Object.keys(data[0] || {}).filter(k => !hide.includes(k));
  return <section className="card"><h2>{title}</h2><div className="tablewrap"><table>
    {cols.length > 0 && <thead><tr>{cols.map(k => <th key={k}>{k.replace(/_/g, " ")}</th>)}</tr></thead>}
    <tbody>{data.map((r, i) => <tr key={r.id ?? i}>{cols.map(k => <td key={k}>{String(r[k] ?? "")}</td>)}</tr>)}</tbody></table>
    {!data.length && <p className="empty">No records found.</p>}</div></section>;
}
function Reports({ stock, sales, collections }: any) {
  return <><div className="cards"><Metric title="Stock Lines" value={stock.length} /><Metric title="Sales Records" value={sales.length} /><Metric title="Collections" value={collections.length} /></div>
    <SimpleTable title="Stock Report" data={stock} hide={["distributor_id"]} /></>;
}
function Team() {
  return <section className="card"><h2>Team &amp; Access</h2><p>Accounts are created by the admin in Supabase → Authentication → Users → Add user. Public sign-up is off.</p>
    <ol><li>Create the user in Supabase Auth (tick “Auto confirm”).</li><li>Set their role and territory in the <code>profiles</code> table.</li><li>Assign distributors via <code>distributors.assigned_user</code>.</li></ol></section>;
}
export default App;
