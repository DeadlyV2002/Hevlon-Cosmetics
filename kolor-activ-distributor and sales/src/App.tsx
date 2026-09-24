import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import { supabase, Distributor, Product, StockLine, Role, fmt } from "./lib/supabase";
import Inventory from "./pages/Inventory";
import Distributors from "./pages/Distributors";
import History from "./pages/History";

type Page = "Dashboard" | "Inventory" | "Distributors" | "History" | "Reports" | "Retailers" | "Team";
const NAV: Page[] = ["Dashboard", "Inventory", "Distributors", "History", "Reports", "Retailers", "Team"];
const ROLE_LABEL: Record<Role, string> = { HO_ADMIN: "HO admin", STATE_MANAGER: "State manager", DISTRIBUTOR_MANAGER: "Distributor manager", SALESMAN: "Salesman" };

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [email, setEmail] = useState(""), [password, setPassword] = useState("");
  const [page, setPage] = useState<Page>("Dashboard");
  const [message, setMessage] = useState(""), [loading, setLoading] = useState(false);
  const [distributors, setDistributors] = useState<Distributor[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [stock, setStock] = useState<StockLine[]>([]);
  const [retailers, setRetailers] = useState<any[]>([]);
  const [recent, setRecent] = useState<any[]>([]);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => { if (session) refreshAll(); }, [session?.user.id]);

  async function q<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, label: string): Promise<T | null> {
    const { data, error } = await p;
    if (error) { setMessage(`Could not load ${label}: ${error.message}`); return null; }
    return data;
  }
  async function refreshAll() {
    if (!supabase || !session) return;
    const [prof, d, p, s, r, b] = await Promise.all([
      q(supabase.from("profiles").select("role").eq("id", session.user.id).maybeSingle(), "profile"),
      q(supabase.from("distributors").select("*").order("name"), "distributors"),
      q(supabase.from("products").select("id,sku,item_name,unit_price").order("item_name").limit(10000), "products"),
      q(supabase.from("distributor_stock_summary").select("*").order("distributor_name").order("item_name").limit(20000), "stock"),
      q(supabase.from("retailers").select("id,name,code,territory,created_at,distributors(name)").order("name").limit(2000), "retailers"),
      q(supabase.from("inventory_batch_summary").select("*").order("created_at", { ascending: false }).limit(6), "recent postings"),
    ]);
    setRole(((prof as any)?.role as Role) ?? null);
    if (d) setDistributors(d as Distributor[]);
    if (p) setProducts(p as Product[]);
    if (s) setStock(s as StockLine[]);
    if (r) setRetailers(r as any[]);
    if (b) setRecent(b as any[]);
  }
  async function login() {
    if (!supabase) return;
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setLoading(false);
    setMessage(error ? (error.message === "Invalid login credentials" ? "Wrong email or password." : error.message) : "");
  }
  const canManage = role === "HO_ADMIN" || role === "STATE_MANAGER";

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

  return (
    <div className="app">
      <aside>
        <div className="logo">KA</div><strong>Kolor Activ</strong><small>Distributor control</small>
        <nav>{NAV.map(n => <button key={n} className={page === n ? "nav active" : "nav"} onClick={() => { setPage(n); setMessage(""); }}>{n}</button>)}</nav>
        <button className="secondary logout" onClick={() => supabase!.auth.signOut()}>Sign out</button>
      </aside>
      <main>
        <header><div><small>KOLOR ACTIV · HEVLON COSMETICS</small><h1>{page}</h1></div>
          <span className="who">{session.user.email}{role && <em className="tag">{ROLE_LABEL[role]}</em>}</span></header>
        {message && <div className="notice" onClick={() => setMessage("")}>{message}<span className="x">✕</span></div>}
        {page === "Dashboard" && <Dashboard stock={stock} distributors={distributors} products={products} recent={recent} go={setPage} />}
        {page === "Inventory" && <Inventory distributors={distributors} products={products} stock={stock} onPosted={refreshAll} notify={setMessage} />}
        {page === "Distributors" && <Distributors distributors={distributors} stock={stock} canManage={canManage} onChanged={refreshAll} notify={setMessage} />}
        {page === "History" && <History canManage={canManage} onChanged={refreshAll} notify={setMessage} />}
        {page === "Reports" && <Reports stock={stock} distributors={distributors} />}
        {page === "Retailers" && <Retailers retailers={retailers} />}
        {page === "Team" && <Team role={role} />}
      </main>
    </div>
  );
}

function Metric({ title, value, sub }: { title: string; value: string | number; sub?: string }) {
  return <div className="metric"><small>{title}</small><b>{value}</b>{sub && <small>{sub}</small>}</div>;
}

function Dashboard({ stock, distributors, products, recent, go }: { stock: StockLine[]; distributors: Distributor[]; products: Product[]; recent: any[]; go: (p: Page) => void }) {
  const units = stock.reduce((a, x) => a + Number(x.current_stock || 0), 0);
  const value = stock.reduce((a, x) => a + Number(x.stock_value || 0), 0);
  const active = new Set(stock.map(s => s.distributor_id));
  const noStock = distributors.filter(d => !active.has(d.id));
  return <>
    <div className="cards">
      <Metric title="Distributors" value={distributors.length} sub={noStock.length ? `${noStock.length} with no stock posted` : undefined} />
      <Metric title="Products" value={products.length} />
      <Metric title="Units at distributors" value={fmt(units)} />
      <Metric title="Stock value" value={`₹${fmt(value)}`} sub="at latest purchase rate" />
    </div>
    <section className="card"><div className="rowhead"><h2>Recent postings</h2><button className="secondary" onClick={() => go("History")}>All history</button></div>
      {recent.length ? <table><tbody>{recent.map(b => <tr key={b.id}><td>{new Date(b.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</td>
        <td><span className={`pill ${String(b.mode).toLowerCase()}`}>{b.mode === "INPUT" ? "Stock IN" : b.mode === "OUTPUT" ? "Stock OUT" : "Stock count"}</span></td>
        <td>{b.distributor_name || "several"}</td><td className="wrap">{b.source_file}</td><td>{b.lines} lines</td></tr>)}</tbody></table>
        : <p className="empty">Nothing posted yet. Start with <button className="link" onClick={() => go("Distributors")}>adding distributors</button>, then <button className="link" onClick={() => go("Inventory")}>upload stock</button>.</p>}
    </section>
  </>;
}

function Reports({ stock, distributors }: { stock: StockLine[]; distributors: Distributor[] }) {
  const [dist, setDist] = useState(""), [search, setSearch] = useState(""), [hideZero, setHideZero] = useState(true);
  const byDist = useMemo(() => distributors.map(d => {
    const lines = stock.filter(s => s.distributor_id === d.id);
    return { Code: d.code, Distributor: d.name, Territory: d.territory || "", Products: lines.filter(l => Number(l.current_stock)).length,
      Units: lines.reduce((a, l) => a + Number(l.current_stock), 0), "Value ₹": lines.reduce((a, l) => a + Number(l.stock_value), 0),
      "Last movement": lines.reduce((a, l) => (l.last_movement > a ? l.last_movement : a), "") };
  }), [stock, distributors]);
  const lines = stock.filter(s => (!dist || s.distributor_id === dist) && (!hideZero || Number(s.current_stock) !== 0)
    && `${s.distributor_name} ${s.sku} ${s.item_name}`.toLowerCase().includes(search.toLowerCase()));
  function exportAll() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(byDist), "By distributor");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lines.map(s => ({ Distributor: s.distributor_name, Code: s.distributor_code, SKU: s.sku, Product: s.item_name, In: Number(s.total_input), Out: Number(s.total_output), Stock: Number(s.current_stock), "Rate ₹": Number(s.unit_price), "Value ₹": Number(s.stock_value), "Last movement": s.last_movement }))), "Stock detail");
    XLSX.writeFile(wb, `distributor-stock-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }
  return <>
    <section className="card"><div className="rowhead"><h2>Stock by distributor</h2><button onClick={exportAll}>Export to Excel</button></div>
      <div className="tablewrap"><table><thead><tr><th>Code</th><th>Distributor</th><th>Territory</th><th>Products in stock</th><th>Units</th><th>Value ₹</th><th>Last movement</th></tr></thead>
        <tbody>{byDist.map(r => <tr key={r.Code}><td>{r.Code}</td><td>{r.Distributor}</td><td>{r.Territory}</td><td>{r.Products}</td><td>{fmt(r.Units)}</td><td>{fmt(r["Value ₹"])}</td><td>{r["Last movement"] || "—"}</td></tr>)}</tbody></table></div></section>
    <section className="card"><div className="rowhead"><h2>Stock detail</h2>
      <div className="actions"><select value={dist} onChange={e => setDist(e.target.value)}><option value="">All distributors</option>{distributors.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <input className="search" placeholder="Search product…" value={search} onChange={e => setSearch(e.target.value)} />
        <label className="inline"><input type="checkbox" checked={hideZero} onChange={e => setHideZero(e.target.checked)} /> Hide zero</label></div></div>
      <div className="tablewrap"><table><thead><tr><th>Distributor</th><th>SKU</th><th>Product</th><th>IN</th><th>OUT</th><th>Stock</th><th>Value ₹</th><th>Last movement</th></tr></thead>
        <tbody>{lines.map(s => <tr key={`${s.distributor_id}-${s.product_id}`}><td>{s.distributor_name}</td><td>{s.sku}</td><td>{s.item_name}</td>
          <td className="in">+{fmt(s.total_input)}</td><td className="out">-{fmt(s.total_output)}</td><td><b>{fmt(s.current_stock)}</b></td><td>{fmt(s.stock_value)}</td><td>{s.last_movement}</td></tr>)}</tbody></table>
        {!lines.length && <p className="empty">No stock lines.</p>}</div></section>
  </>;
}

function Retailers({ retailers }: { retailers: any[] }) {
  const [search, setSearch] = useState("");
  const list = retailers.filter(r => `${r.name} ${r.distributors?.name || ""}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="card"><div className="rowhead"><h2>Retailers ({retailers.length})</h2><input className="search" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} /></div>
    <p className="hint">Retailers are added automatically from Stock OUT uploads.</p>
    <div className="tablewrap"><table><thead><tr><th>Retailer</th><th>Distributor</th><th>Territory</th><th>First seen</th></tr></thead>
      <tbody>{list.map(r => <tr key={r.id}><td>{r.name}</td><td>{r.distributors?.name}</td><td>{r.territory}</td><td>{String(r.created_at || "").slice(0, 10)}</td></tr>)}</tbody></table>
      {!list.length && <p className="empty">No retailers yet.</p>}</div></section>;
}

function Team({ role }: { role: Role | null }) {
  return <section className="card"><h2>Team &amp; access</h2>
    <p>Your role: <b>{role ? ROLE_LABEL[role] : "unknown"}</b>. HO admins and state managers can add/edit distributors and undo postings; everyone signed in can upload stock.</p>
    <ol><li>Supabase → Authentication → Users → <b>Add user</b> → Create new user (tick “Auto Confirm User”).</li>
      <li>Set their role in the <code>profiles</code> table (HO_ADMIN, STATE_MANAGER, DISTRIBUTOR_MANAGER or SALESMAN).</li></ol></section>;
}
