import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, Distributor, Product, ProductAlias, StockLine, Retailer, SalesOfficer, Role, fetchAll, errText } from "./lib/supabase";
import Dashboard from "./pages/Dashboard";
import Inventory from "./pages/Inventory";
import Distributors from "./pages/Distributors";
import Retailers from "./pages/Retailers";
import SOChecks from "./pages/SOChecks";
import Reports from "./pages/Reports";
import History from "./pages/History";

export type Page = "Dashboard" | "Inventory" | "Distributors" | "Retailers" | "SO checks" | "Reports" | "History" | "Team";
const NAV: Page[] = ["Dashboard", "Inventory", "Distributors", "Retailers", "SO checks", "Reports", "History", "Team"];
const ROLE_LABEL: Record<Role, string> = { HO_ADMIN: "HO admin", STATE_MANAGER: "State manager", DISTRIBUTOR_MANAGER: "Distributor manager", SALESMAN: "Salesman" };

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [email, setEmail] = useState(""), [password, setPassword] = useState("");
  const [page, setPage] = useState<Page>("Dashboard");
  const [message, setMessage] = useState(""), [loading, setLoading] = useState(false);
  const [locations, setLocations] = useState<Distributor[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [aliases, setAliases] = useState<ProductAlias[]>([]);
  const [stock, setStock] = useState<StockLine[]>([]);
  const [retailers, setRetailers] = useState<Retailer[]>([]);
  const [officers, setOfficers] = useState<SalesOfficer[]>([]);
  const [commentCounts, setCommentCounts] = useState<Map<string, number>>(new Map());
  const [recent, setRecent] = useState<any[]>([]);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => { if (session) refreshAll(); }, [session?.user.id]);

  async function refreshAll() {
    if (!supabase || !session) return;
    const sb = supabase, failed: string[] = [];
    /** One list failing (say, before the latest database step is run) shouldn't blank the others. */
    const all = <T,>(label: string, page: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) =>
      fetchAll<T>(page).catch(e => { failed.push(`${label}: ${errText(e)}`); return null; });
    const [prof, d, p, s, r, al, so, cc, b] = await Promise.all([
      sb.from("profiles").select("role").eq("id", session.user.id).maybeSingle(),
      all<Distributor>("locations", (a, z) => sb.from("distributors").select("*").order("name").order("id").range(a, z)),
      all<Product>("products", (a, z) => sb.from("products").select("id,sku,item_name,unit_price").order("item_name").order("id").range(a, z)),
      all<StockLine>("stock", (a, z) => sb.from("distributor_stock_summary").select("*").order("distributor_id").order("product_id").range(a, z)),
      all<Retailer>("retailers", (a, z) => sb.from("retailers").select("id,distributor_id,code,name,territory,owner_name,phone,created_at").order("name").order("id").range(a, z)),
      all<ProductAlias>("product names", (a, z) => sb.from("product_aliases").select("product_id,alias").order("id").range(a, z)),
      all<SalesOfficer>("sales officers", (a, z) => sb.from("sales_officers").select("*").order("name").order("id").range(a, z)),
      all<{ distributor_id: string; n: number }>("comments", (a, z) => sb.from("distributor_comment_counts").select("distributor_id,n").order("distributor_id").range(a, z)),
      sb.from("inventory_batch_summary").select("*").order("created_at", { ascending: false }).limit(6),
    ]);
    setRole(((prof.data as any)?.role as Role) ?? null);
    if (d) setLocations(d.map(x => ({ ...x, kind: x.kind || "DISTRIBUTOR" })));
    if (p) setProducts(p);
    if (s) setStock(s);
    if (r) setRetailers(r);
    if (al) setAliases(al);
    if (so) setOfficers(so);
    if (cc) setCommentCounts(new Map(cc.map(x => [x.distributor_id, Number(x.n)])));
    if (b.data) setRecent(b.data);
    if (failed.length) setMessage(`Could not load ${failed.join("; ")}. If this mentions a missing table or column, run the latest database step (supabase/migrations) in Supabase.`);
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
        {page === "Dashboard" && <Dashboard stock={stock} locations={locations} products={products} recent={recent} go={setPage} />}
        {page === "Inventory" && <Inventory locations={locations} products={products} aliases={aliases} stock={stock} officers={officers} retailers={retailers}
          canManage={canManage} onPosted={refreshAll} onListsChanged={refreshAll} notify={setMessage} />}
        {page === "Distributors" && <Distributors locations={locations} stock={stock} commentCounts={commentCounts} canManage={canManage} userId={session.user.id} onChanged={refreshAll} notify={setMessage} />}
        {page === "Retailers" && <Retailers retailers={retailers} locations={locations} canManage={canManage} onChanged={refreshAll} notify={setMessage} />}
        {page === "SO checks" && <SOChecks locations={locations} products={products} officers={officers} canManage={canManage} onChanged={refreshAll} notify={setMessage} />}
        {page === "Reports" && <Reports stock={stock} locations={locations} />}
        {page === "History" && <History canManage={canManage} onChanged={refreshAll} notify={setMessage} />}
        {page === "Team" && <Team role={role} />}
      </main>
    </div>
  );
}

function Team({ role }: { role: Role | null }) {
  return <section className="card"><h2>Team &amp; access</h2>
    <p>Your role: <b>{role ? ROLE_LABEL[role] : "unknown"}</b>. HO admins and state managers can add and edit godowns, super stockists, distributors, retailers and SOs, and undo postings. Everyone signed in can upload stock and SO reports.</p>
    <ol><li>Supabase → Authentication → Users → <b>Add user</b> → Create new user (tick “Auto Confirm User”).</li>
      <li>Set their role in the <code>profiles</code> table (HO_ADMIN, STATE_MANAGER, DISTRIBUTOR_MANAGER or SALESMAN).</li></ol></section>;
}
