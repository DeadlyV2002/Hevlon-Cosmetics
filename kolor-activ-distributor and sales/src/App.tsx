import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, Distributor, Product, ProductAlias, StockLine, Retailer, SalesOfficer, Role, Margins, Scheme, fetchAll, errText } from "./lib/supabase";
import { Alert, ChartKind, Ctx, clearInsightCache } from "./lib/insights";
import Dashboard from "./pages/Dashboard";
import Inventory from "./pages/Inventory";
import Distributors from "./pages/Distributors";
import Retailers from "./pages/Retailers";
import SOChecks from "./pages/SOChecks";
import Reports from "./pages/Reports";
import History from "./pages/History";
import Settings from "./pages/Settings";
import Pricing from "./pages/Pricing";
import Collections from "./pages/Collections";
import SOReports from "./pages/SOReports";
import AlertsBell from "./components/AlertsBell";
import ClearButton from "./components/ClearButton";
import { useSessionLog } from "./components/LogBook";

export type Page = "Dashboard" | "Inventory" | "Distributors" | "Retailers" | "Collections" | "SO reports" | "SO checks" | "Reports" | "Pricing" | "History" | "Settings";
const NAV: Page[] = ["Dashboard", "Inventory", "Distributors", "Retailers", "Collections", "SO reports", "SO checks", "Reports", "Pricing", "History", "Settings"];
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
  const [testingMode, setTestingMode] = useState(false);
  const [margins, setMargins] = useState<Margins>({ ss: 10, distributor: 15 });
  const [schemes, setSchemes] = useState<Scheme[]>([]);
  /** Only logins listed in pricing_access see the Pricing page. */
  const [canPrice, setCanPrice] = useState(false);
  /** Goes up after every reload, so charts and alerts know to fetch fresh numbers. */
  const [version, setVersion] = useState(0);
  const [openKind, setOpenKind] = useState<ChartKind | null>(null);
  const ctx: Ctx = useMemo(() => ({ locations, products, stock, officers }), [locations, products, stock, officers]);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => { if (session) refreshAll(); }, [session?.user.id]);
  useSessionLog(session?.user.id, session?.user.email);

  async function refreshAll() {
    if (!supabase || !session) return;
    const sb = supabase, failed: string[] = [];
    /** One list failing (say, before the latest database step is run) shouldn't blank the others. */
    const all = <T,>(label: string, page: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) =>
      fetchAll<T>(page).catch(e => { failed.push(`${label}: ${errText(e)}`); return null; });
    const [prof, d, p, s, r, al, so, cc, settings, sch, cp] = await Promise.all([
      sb.from("profiles").select("role").eq("id", session.user.id).maybeSingle(),
      all<Distributor>("locations", (a, z) => sb.from("distributors").select("*").order("name").order("id").range(a, z)),
      all<Omit<Product, "purchase_rate">>("products", (a, z) => sb.from("products").select("id,sku,item_name,unit_price,ss_rate,mrp").order("item_name").order("id").range(a, z)),
      all<StockLine>("stock", (a, z) => sb.from("distributor_stock_summary").select("*").order("distributor_id").order("product_id").range(a, z)),
      all<Retailer>("retailers", (a, z) => sb.from("retailers").select("id,distributor_id,code,name,territory,owner_name,phone,created_at").order("name").order("id").range(a, z)),
      all<ProductAlias>("product names", (a, z) => sb.from("product_aliases").select("product_id,alias").order("id").range(a, z)),
      all<SalesOfficer>("sales officers", (a, z) => sb.from("sales_officers").select("*").order("name").order("id").range(a, z)),
      all<{ distributor_id: string; n: number }>("comments", (a, z) => sb.from("distributor_comment_counts").select("distributor_id,n").order("distributor_id").range(a, z)),
      sb.from("app_settings").select("key,value").in("key", ["testing_mode", "margins"]),
      all<Scheme>("pricing schemes", (a, z) => sb.from("schemes").select("*").order("starts_on", { ascending: false }).order("id").range(a, z)),
      sb.rpc("can_price"),
    ]);
    setRole(((prof.data as any)?.role as Role) ?? null);
    if (d) setLocations(d.map(x => ({ ...x, kind: x.kind || "DISTRIBUTOR" })));
    // Stock is valued at the SS rate; the last purchase rate stands in until it's set.
    if (p) setProducts(p.map(x => ({ ...x, purchase_rate: Number(x.unit_price) || 0, unit_price: Number(x.ss_rate) || Number(x.unit_price) || 0 })));
    if (s) setStock(s);
    if (r) setRetailers(r);
    if (al) setAliases(al);
    if (so) setOfficers(so);
    if (cc) setCommentCounts(new Map(cc.map(x => [x.distributor_id, Number(x.n)])));
    const setting = (k: string) => (settings.data as { key: string; value: any }[] | null)?.find(x => x.key === k)?.value;
    setTestingMode(setting("testing_mode") === true);
    const m = setting("margins");
    if (m) setMargins({ ss: Number(m.ss ?? 10), distributor: Number(m.distributor ?? 15) });
    if (sch) setSchemes(sch);
    setCanPrice(cp.data === true);
    if (failed.length) setMessage(`Could not load ${failed.join("; ")}. If this mentions a missing table or column, run the latest database step (supabase/migrations) in Supabase.`);
    clearInsightCache();
    setVersion(v => v + 1);
  }
  async function login() {
    if (!supabase) return;
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setLoading(false);
    setMessage(error ? (error.message === "Invalid login credentials" ? "Wrong email or password." : error.message) : "");
  }
  function pickAlert(a: Alert) {
    setMessage("");
    if (a.kind) { setPage("Dashboard"); setOpenKind(a.kind); }
    else if (a.page) setPage(a.page);
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
        <nav>{NAV.filter(n => n !== "Pricing" || canPrice).map(n => <button key={n} className={page === n ? "nav active" : "nav"} onClick={() => { setPage(n); setMessage(""); }}>{n}</button>)}</nav>
        <button className="secondary logout" onClick={() => supabase!.auth.signOut()}>Sign out</button>
      </aside>
      <main>
        <header><div><small>KOLOR ACTIV · HEVLON COSMETICS{testingMode ? " · TESTING MODE" : ""}</small><h1>{page}</h1></div>
          <div className="headright">
            <AlertsBell ctx={ctx} version={version} onPick={pickAlert} />
            <span className="who">{session.user.email}{role && <em className="tag">{ROLE_LABEL[role]}</em>}</span>
          </div></header>
        {message && <div className="notice" onClick={() => setMessage("")}>{message}<span className="x">✕</span></div>}
        {page === "Dashboard" && <Dashboard ctx={ctx} userId={session.user.id} version={version} openKind={openKind} onOpened={() => setOpenKind(null)} />}
        {page === "Inventory" && <Inventory locations={locations} products={products} aliases={aliases} stock={stock} officers={officers} retailers={retailers}
          canManage={canManage} onPosted={refreshAll} onListsChanged={refreshAll} notify={setMessage} />}
        {page === "Distributors" && <Distributors locations={locations} stock={stock} retailers={retailers} officers={officers} commentCounts={commentCounts} canManage={canManage}
          testingMode={testingMode} userId={session.user.id} onChanged={refreshAll} notify={setMessage} />}
        {page === "Retailers" && <Retailers retailers={retailers} locations={locations} stock={stock} officers={officers} canManage={canManage} onChanged={refreshAll} notify={setMessage} />}
        {page === "Collections" && <Collections locations={locations} stock={stock} officers={officers} canManage={canManage} onChanged={refreshAll} notify={setMessage} />}
        {page === "SO reports" && <SOReports officers={officers} locations={locations} stock={stock} canManage={canManage} onChanged={refreshAll} notify={setMessage} />}
        {page === "SO checks" && <SOChecks locations={locations} products={products} officers={officers} canManage={canManage} onChanged={refreshAll} notify={setMessage} />}
        {page === "Reports" && <Reports stock={stock} locations={locations} />}
        {page === "Pricing" && canPrice && <Pricing products={products} locations={locations} margins={margins} schemes={schemes} canManage={canManage} onChanged={refreshAll} notify={setMessage} />}
        {page === "History" && <History canManage={canManage} onChanged={refreshAll} notify={setMessage} />}
        {page === "Settings" && <Settings role={role} locations={locations} testingMode={testingMode} onTestingMode={setTestingMode} onChanged={refreshAll} notify={setMessage} />}
      </main>
      <ClearButton />
    </div>
  );
}
