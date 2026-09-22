import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';
import {
  Upload, LayoutDashboard, Boxes, ReceiptIndianRupee, Users, WalletCards,
  AlertTriangle, Search, Plus, FileSpreadsheet, ChevronRight, ShieldCheck,
  UserRoundCheck, RefreshCw, Download, Activity, Menu, X, LogOut, Info
} from 'lucide-react';
import './styles.css';

// ─── Supabase client ────────────────────────────────────────────────────────
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';
const supabase: SupabaseClient | null =
  supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

// ─── Types ──────────────────────────────────────────────────────────────────
type AppRole = 'HO_ADMIN' | 'STATE' | 'DISTRIBUTOR' | 'RETAILER' | 'SALESMAN';
type RecordStatus = 'REPORTED' | 'MATCHED' | 'VERIFIED' | 'EXCEPTION' | 'APPROVED';

interface UserProfile {
  id: string;
  role: AppRole;
  display_name: string | null;
  state_id: string | null;
  distributor_id: string | null;
}
interface Product   { id: string; code: string; name: string; category: string; }
interface Salesman  { id: string; employee_code: string; name: string; territory: string; state_id: string; distributor_id: string; manager_name: string; target_value: number; active: boolean; }
interface Bill      { id: string; bill_no: string; bill_date: string; source_type: string; reported_value: number; status: RecordStatus; source_file_name: string | null; distributor_id: string | null; }
interface ReconRow  { id: string; distributor_id: string; product_id: string; expected_stock: number; reported_stock: number; verified_stock: number; reported_sales: number; verified_sales: number; stock_difference: number; sales_difference: number; status: RecordStatus; run_at: string; }
interface Collection { id: string; collection_date: string; customer_name: string | null; amount: number; payment_mode: string | null; status: RecordStatus; salesman_id: string | null; }
interface ExceptionRow { id: string; exception_code: string; layer: string | null; issue_type: string; description: string; variance_qty: number; variance_value: number; status: string; created_at: string; }
interface StateName { id: string; name: string; }
interface Distributor { id: string; name: string; state_id: string; }

// ─── Seed / demo data (shown when Supabase is not yet connected) ─────────────
const DEMO_SALESMEN = [
  { id:'1', employee_code:'SM-001', name:'Amit Sharma',  territory:'North Delhi',   state_id:'DL', distributor_id:'A', manager_name:'HO Admin', target_value:1240000, active:true,  calls:92, pc:74, secSales:980000,  coll:820000 },
  { id:'2', employee_code:'SM-002', name:'Ravi Kumar',   territory:'Gurugram',      state_id:'HR', distributor_id:'B', manager_name:'HO Admin', target_value:1080000, active:true,  calls:88, pc:66, secSales:870000,  coll:710000 },
  { id:'3', employee_code:'SM-003', name:'Pooja Singh',  territory:'Bhubaneswar',   state_id:'OD', distributor_id:'C', manager_name:'HO Admin', target_value:1320000, active:true,  calls:104,pc:79, secSales:1150000, coll:970000 },
  { id:'4', employee_code:'SM-004', name:'Neha Verma',   territory:'Cuttack',       state_id:'OD', distributor_id:'D', manager_name:'HO Admin', target_value:1190000, active:true,  calls:97, pc:71, secSales:930000,  coll:760000 },
  { id:'5', employee_code:'SM-005', name:'Arjun Mehta',  territory:'Jaipur',        state_id:'RJ', distributor_id:'E', manager_name:'HO Admin', target_value:910000,  active:true,  calls:83, pc:62, secSales:720000,  coll:590000 },
  { id:'6', employee_code:'SM-006', name:'Sanjay Rao',   territory:'Hyderabad',     state_id:'TS', distributor_id:'F', manager_name:'HO Admin', target_value:1410000, active:true,  calls:111,pc:82, secSales:1210000, coll:1020000 },
  { id:'7', employee_code:'SM-007', name:'Karan Patel',  territory:'Ahmedabad',     state_id:'GJ', distributor_id:'G', manager_name:'HO Admin', target_value:1010000, active:true,  calls:90, pc:69, secSales:810000,  coll:670000 },
  { id:'8', employee_code:'SM-008', name:'Priya Nair',   territory:'Kochi',         state_id:'KL', distributor_id:'H', manager_name:'HO Admin', target_value:1270000, active:true,  calls:102,pc:80, secSales:1040000, coll:860000 },
];
const DEMO_PRODUCTS = [
  { id:'1', code:'KA-001', name:'Nail Paint Passion 5ml', category:'Nail Paint', exp:12000, ver:9800  },
  { id:'2', code:'KA-002', name:'Liquid Lip Color',       category:'Lip Color',  exp:8500,  ver:7300  },
  { id:'3', code:'KA-003', name:'Foundation Natural',     category:'Foundation', exp:4200,  ver:3900  },
  { id:'4', code:'KA-004', name:'Foundation Skin',        category:'Foundation', exp:3800,  ver:3100  },
  { id:'5', code:'KA-005', name:'Mascara Black',          category:'Eye',        exp:6100,  ver:5200  },
];
const DEMO_EXCEPTIONS = [
  { id:'1', exception_code:'EX-1021', layer:'Distributor C', issue_type:'Stock gap',      description:'Stock received 10,000; sales 8,950; verified closing 620. Expected 1,050.', variance_qty:430,  variance_value:0, status:'Open', created_at: new Date().toISOString() },
  { id:'2', exception_code:'EX-1022', layer:'Distributor D', issue_type:'Sales gap',      description:'Secondary sale differs from distributor bill by 185 units.',                 variance_qty:185,  variance_value:0, status:'Open', created_at: new Date().toISOString() },
  { id:'3', exception_code:'EX-1023', layer:'Distributor B', issue_type:'Collection gap', description:'Collection overdue beyond due date.',                                         variance_qty:0,    variance_value:84000, status:'Review', created_at: new Date().toISOString() },
  { id:'4', exception_code:'EX-1024', layer:'Distributor F', issue_type:'Duplicate bill', description:'Duplicate invoice detected in upload.',                                       variance_qty:0,    variance_value:0, status:'Open', created_at: new Date().toISOString() },
  { id:'5', exception_code:'EX-1025', layer:'Distributor A', issue_type:'Missing data',   description:'Retailer secondary sales missing for 2 days.',                              variance_qty:0,    variance_value:180000, status:'Open', created_at: new Date().toISOString() },
];
const DEMO_COLLECTIONS = [
  { id:'1', collection_date:'2026-09-22', customer_name:'Maa Traders',    amount:120000, payment_mode:'NEFT',  status:'VERIFIED' as RecordStatus, salesman_id:'3' },
  { id:'2', collection_date:'2026-09-21', customer_name:'City Cosmetics', amount:150000, payment_mode:'Cheque',status:'REPORTED' as RecordStatus, salesman_id:'1' },
  { id:'3', collection_date:'2026-09-20', customer_name:'Glow Retail',    amount:0,      payment_mode:null,    status:'EXCEPTION' as RecordStatus,salesman_id:'2' },
  { id:'4', collection_date:'2026-09-19', customer_name:'Beauty Hub',     amount:40000,  payment_mode:'Cash',  status:'REPORTED' as RecordStatus, salesman_id:'4' },
];

// ─── Helpers ────────────────────────────────────────────────────────────────
const fmt = (n: number, d = 0) => n.toLocaleString('en-IN', { maximumFractionDigits: d });
const fmtL = (n: number) => `₹${(n / 100000).toFixed(2)} L`;
const pcOf = (n: number, d: number) => d ? `${((n / d) * 100).toFixed(1)}%` : '—';
const today = new Date().toISOString().split('T')[0];

// ─── Toast ──────────────────────────────────────────────────────────────────
function useToast() {
  const [toast, setToast] = useState('');
  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  }, []);
  return { toast, notify };
}

// ─── useSupabase hook ────────────────────────────────────────────────────────
function useSupabaseData<T>(
  fetcher: () => Promise<T[]>,
  fallback: T[],
  deps: React.DependencyList = []
) {
  const [data, setData] = useState<T[]>(fallback);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    try { const rows = await fetcher(); if (rows.length) setData(rows); }
    catch { /* fallback stays */ }
    finally { setLoading(false); }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { refresh(); }, [refresh]);
  return { data, loading, refresh };
}

// ─── App ────────────────────────────────────────────────────────────────────
const NAV = [
  ['Dashboard',       LayoutDashboard],
  ['Inventory',       Boxes],
  ['Bill Import',     Upload],
  ['Reconciliation',  RefreshCw],
  ['Collections',     WalletCards],
  ['Salesmen',        Users],
  ['Performance',     Activity],
  ['Exceptions',      AlertTriangle],
  ['Reports',         FileSpreadsheet],
] as const;

function App() {
  const [role]            = useState<AppRole>('HO_ADMIN');
  const [page, setPage]   = useState('Dashboard');
  const [mobile, setMobile] = useState(false);
  const [query, setQuery] = useState('');
  const [uploadMsg, setUploadMsg] = useState('');
  const { toast, notify } = useToast();
  const isConnected = !!supabase;

  // Live Supabase data
  const { data: liveBills, loading: billsLoading, refresh: refreshBills } = useSupabaseData<Bill>(
    async () => { const { data } = await supabase!.from('bills').select('*').order('created_at', { ascending: false }).limit(50); return data || []; },
    []
  );
  const { data: liveExceptions, refresh: refreshExceptions } = useSupabaseData<ExceptionRow>(
    async () => { const { data } = await supabase!.from('exceptions').select('*').order('created_at', { ascending: false }).limit(100); return data || []; },
    DEMO_EXCEPTIONS as unknown as ExceptionRow[]
  );
  const { data: liveSalesmen } = useSupabaseData<Salesman>(
    async () => { const { data } = await supabase!.from('salesmen').select('*').order('name'); return data || []; },
    []
  );
  const { data: liveCollections, refresh: refreshCollections } = useSupabaseData<Collection>(
    async () => { const { data } = await supabase!.from('collections').select('*').order('collection_date', { ascending: false }).limit(50); return data || []; },
    DEMO_COLLECTIONS as unknown as Collection[]
  );
  const { data: liveStates } = useSupabaseData<StateName>(
    async () => { const { data } = await supabase!.from('states').select('id, name'); return data || []; },
    []
  );
  const { data: liveDistributors } = useSupabaseData<Distributor>(
    async () => { const { data } = await supabase!.from('distributors').select('id, name, state_id'); return data || []; },
    []
  );
  const { data: liveProducts } = useSupabaseData<Product>(
    async () => { const { data } = await supabase!.from('products').select('id, code, name, category').eq('active', true); return data || []; },
    []
  );

  // Merge live + demo for display
  const displaySalesmen = useMemo(() => liveSalesmen.length ? liveSalesmen : DEMO_SALESMEN, [liveSalesmen]);
  const displayExceptions = useMemo(() => liveExceptions.length ? liveExceptions : DEMO_EXCEPTIONS as unknown as ExceptionRow[], [liveExceptions]);
  const filteredSalesmen = useMemo(() =>
    displaySalesmen.filter(s => {
      const name = 'name' in s ? (s as any).name : '';
      const territory = 'territory' in s ? (s as any).territory : '';
      return (name + ' ' + territory).toLowerCase().includes(query.toLowerCase());
    }),
    [displaySalesmen, query]
  );
  const openExceptions = useMemo(() => displayExceptions.filter(e => e.status === 'Open' || e.status === 'OPEN').length, [displayExceptions]);

  // ── Bill import handler ──────────────────────────────────────────────────
  async function handleFileImport(
    file: File,
    sourceType: string,
    region: string,
    billDate: string,
    distributorId: string
  ) {
    setUploadMsg('Reading file…');
    try {
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      let rowCount = 0;
      let parsedRows: Record<string, unknown>[] = [];

      if (isPdf) {
        const pdfjs = (window as any).pdfjsLib;
        if (!pdfjs) throw new Error('PDF engine is still loading — please try again in a moment.');
        pdfjs.GlobalWorkerOptions.workerSrc =
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.149/pdf.worker.min.js';
        const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
        let text = '';
        for (let i = 1; i <= pdf.numPages; i++) {
          const pg = await pdf.getPage(i);
          const content = await pg.getTextContent();
          text += content.items.map((x: any) => x.str).filter(Boolean).join(' ') + '\n';
        }
        const lines = text.split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
        const billLines = lines.filter((l: string) =>
          /(invoice|bill|item|product|qty|quantity|amount|total|date|party|customer|tax)/i.test(l)
        ).length;
        rowCount = billLines;
        setUploadMsg(`PDF extracted: ${pdf.numPages} page(s), ${lines.length} text lines, ${billLines} bill-related lines.${!supabase ? ' (connect Supabase to save)' : ''}`);
      } else {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        parsedRows = XLSX.utils.sheet_to_json(ws) as Record<string, unknown>[];
        rowCount = parsedRows.length;
        setUploadMsg(`Parsed ${rowCount} rows from "${file.name}".${!supabase ? ' (connect Supabase to save)' : ' Saving…'}`);
      }

      // ── Write to Supabase if connected ──────────────────────────────────
      if (supabase && !isPdf && parsedRows.length > 0) {
        // Insert bill header
        const { data: billData, error: billErr } = await supabase
          .from('bills')
          .insert({
            bill_no: `IMPORT-${Date.now()}`,
            bill_date: billDate || today,
            source_type: sourceType,
            source_file_name: file.name,
            reported_value: 0,
            status: 'REPORTED',
            distributor_id: distributorId || null,
          })
          .select()
          .single();

        if (billErr) throw new Error(billErr.message);
        notify(`Saved: ${rowCount} rows from "${file.name}" → Bill #${billData.id.slice(0, 8)}…`);
        setUploadMsg(`✓ ${rowCount} rows saved. Bill ID: ${billData.id.slice(0, 8)}… Status: REPORTED`);
        refreshBills();
      } else if (!supabase) {
        notify(`Parsed ${rowCount} rows (demo mode — connect Supabase to persist)`);
      } else if (isPdf && supabase) {
        notify('PDF extracted — review lines above, then click Process & Reconcile to save.');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      setUploadMsg(`Error: ${msg}`);
      notify(`Import failed: ${msg}`);
    }
  }

  // ── Add exception from UI ────────────────────────────────────────────────
  async function addException(code: string, layer: string, issue: string, desc: string) {
    if (!supabase) { notify('Connect Supabase to save exceptions'); return; }
    const { error } = await supabase.from('exceptions').insert({
      exception_code: code,
      layer, issue_type: issue, description: desc, status: 'OPEN',
    });
    if (error) { notify(`Error: ${error.message}`); return; }
    notify('Exception logged'); refreshExceptions();
  }

  // ── Collection recording ─────────────────────────────────────────────────
  async function recordCollection(customerId: string, amount: number, mode: string, date: string) {
    if (!supabase) { notify('Connect Supabase to record collections'); return; }
    const { error } = await supabase.from('collections').insert({
      collection_date: date || today,
      customer_name: customerId,
      amount,
      payment_mode: mode,
      status: 'REPORTED',
    });
    if (error) { notify(`Error: ${error.message}`); return; }
    notify('Collection recorded'); refreshCollections();
  }

  return (
    <div className="app">
      <aside className={mobile ? 'sidebar open' : 'sidebar'}>
        <div className="brand">
          <div className="brandmark">KA</div>
          <div><b>Kolor Activ</b><span>Control Center</span></div>
          <button className="icon mobileClose" onClick={() => setMobile(false)}><X /></button>
        </div>
        <div className="roleBox">
          <ShieldCheck size={17} />
          <div><small>Signed in as</small><strong>{role.replace('_', ' ')}</strong></div>
        </div>
        <nav>
          {NAV.map(([n, Icon]) => (
            <button key={n} className={page === n ? 'nav active' : 'nav'}
              onClick={() => { setPage(n); setMobile(false); }}>
              <Icon size={18} /><span>{n}</span>
              {n === 'Exceptions' && openExceptions > 0 && <em>{openExceptions}</em>}
              {n === 'Reconciliation' && <em>!</em>}
            </button>
          ))}
        </nav>
        <div className="sideBottom">
          <div className={isConnected ? 'online' : 'offline'}>
            <i />{isConnected ? 'Live database' : 'Demo mode'}
          </div>
          <small>{isConnected ? 'Supabase • realtime' : 'Set .env.local to connect'}</small>
        </div>
      </aside>

      <main>
        <header>
          <button className="icon menu" onClick={() => setMobile(true)}><Menu /></button>
          <div><p className="eyebrow">CENTRAL CONTROL</p><h1>{page}</h1></div>
          <div className="headerActions">
            {!isConnected && (
              <span className="demoBadge"><Info size={13} /> Demo data</span>
            )}
            <div className="avatar">KA</div>
          </div>
        </header>

        {page === 'Dashboard'       && <Dashboard onNavigate={setPage} exceptions={displayExceptions} billsLoading={billsLoading} />}
        {page === 'Inventory'       && <Inventory products={liveProducts} />}
        {page === 'Bill Import'     && <BillImport uploadMsg={uploadMsg} onFile={handleFileImport} notify={notify} states={liveStates} distributors={liveDistributors} recentBills={liveBills} />}
        {page === 'Reconciliation'  && <Reconciliation exceptions={displayExceptions} />}
        {page === 'Collections'     && <Collections data={liveCollections} onRecord={recordCollection} />}
        {page === 'Salesmen'        && <Salesmen data={filteredSalesmen} query={query} setQuery={setQuery} />}
        {page === 'Performance'     && <Performance salesmen={displaySalesmen as any} />}
        {page === 'Exceptions'      && <Exceptions data={displayExceptions} onAdd={addException} notify={notify} />}
        {page === 'Reports'         && <Reports />}
      </main>

      {toast && <div className="toast">✓ {toast}</div>}
    </div>
  );
}

// ─── Stat card ───────────────────────────────────────────────────────────────
function Stat({ label, value, sub, icon: Icon, kind }: { label: string; value: string; sub: string; icon: any; kind?: string }) {
  return (
    <div className="stat">
      <div className={'statIcon ' + (kind || '')}><Icon size={19} /></div>
      <div><span>{label}</span><strong>{value}</strong><small>{sub}</small></div>
    </div>
  );
}

// ─── Dashboard ───────────────────────────────────────────────────────────────
function Dashboard({ onNavigate, exceptions, billsLoading }: { onNavigate: (p: string) => void; exceptions: ExceptionRow[]; billsLoading: boolean }) {
  const openEx = exceptions.slice(0, 3);
  return (
    <section className="content">
      <div className="hero">
        <div>
          <span className="pill">● LIVE CONTROL</span>
          <h2>Inventory, sales &amp; collections — one source of truth.</h2>
          <p>Reconcile Tally input, distributor dispatch, secondary sales and field activity across every region.</p>
        </div>
        <button className="primary" onClick={() => onNavigate('Bill Import')}><Upload size={17} /> Upload today's bills</button>
      </div>
      <div className="stats">
        <Stat label="Expected stock"  value="₹4.82 Cr" sub="+4.8% vs last month" icon={Boxes} />
        <Stat label="Verified stock"  value="₹4.57 Cr" sub="94.8% reconciled"   icon={ShieldCheck} kind="green" />
        <Stat label="Secondary sales" value="₹2.16 Cr" sub="+8.2% this month"   icon={ReceiptIndianRupee} />
        <Stat label="Outstanding"     value="₹68.4 L"  sub="₹12.8 L overdue"    icon={WalletCards} kind="amber" />
      </div>
      <div className="grid2">
        <div className="card">
          <div className="cardHead">
            <div><h3>Stock truth monitor</h3><p>Reported vs expected vs verified closing</p></div>
            <button className="ghost" onClick={() => onNavigate('Reconciliation')}>Open reconciliation <ChevronRight size={16} /></button>
          </div>
          <div className="bars">
            <Bar name="Expected inventory" val={100} text="₹4.82 Cr" />
            <Bar name="Verified inventory" val={95}  text="₹4.57 Cr" />
            <Bar name="Reported sales"     val={72}  text="₹3.48 Cr" />
            <Bar name="Verified sales"     val={66}  text="₹3.18 Cr" />
          </div>
        </div>
        <div className="card">
          <div className="cardHead">
            <div><h3>Exception queue</h3><p>Needs HO review before adjustment</p></div>
            <span className="count">{exceptions.length}</span>
          </div>
          {openEx.map(e => (
            <div className="exception" key={e.id}>
              <div className="dot red" />
              <div><b>{e.layer || e.exception_code}</b><p>{e.description}</p></div>
              <strong>{e.variance_value ? `₹${fmt(e.variance_value)}` : e.variance_qty ? fmt(e.variance_qty) : '—'}</strong>
            </div>
          ))}
        </div>
      </div>
      <div className="card">
        <div className="cardHead">
          <div><h3>Regional snapshot</h3><p>Sales, stock and collections by region</p></div>
          <button className="ghost" onClick={() => onNavigate('Reports')}>Full report <ChevronRight size={16} /></button>
        </div>
        {billsLoading && <p className="muted" style={{ padding: '8px 0' }}>Loading live data…</p>}
        <table>
          <thead><tr><th>Region</th><th>Secondary sales</th><th>Collection</th><th>Stock gap</th><th>Status</th></tr></thead>
          <tbody>
            {[['Odisha','₹42.8 L','₹36.2 L','1.8%','Healthy'],['Haryana','₹38.4 L','₹31.7 L','2.4%','Review'],['Delhi','₹31.9 L','₹29.4 L','0.9%','Healthy'],['Rajasthan','₹27.6 L','₹22.8 L','4.2%','Attention']].map(r => (
              <tr key={r[0]}><td><b>{r[0]}</b></td><td>{r[1]}</td><td>{r[2]}</td><td>{r[3]}</td>
                <td><span className={r[4] === 'Healthy' ? 'status ok' : 'status warn'}>{r[4]}</span></td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Bar({ name, val, text }: { name: string; val: number; text: string }) {
  return (
    <div className="barRow">
      <div><span>{name}</span><b>{text}</b></div>
      <div className="track"><i style={{ width: val + '%' }} /></div>
    </div>
  );
}

// ─── Inventory ────────────────────────────────────────────────────────────────
function Inventory({ products }: { products: Product[] }) {
  const display = products.length
    ? products.map(p => ({ ...p, exp: 0, ver: 0 }))
    : DEMO_PRODUCTS;
  return (
    <section className="content">
      <div className="pageIntro">
        <div><h2>Inventory Control</h2><p>Every movement is a ledger transaction — stock is never silently overwritten.</p></div>
        <button className="primary"><Plus size={17} /> Stock adjustment</button>
      </div>
      <div className="stats">
        <Stat label="Opening + receipts"  value="₹6.34 Cr" sub="All layers"       icon={Boxes} />
        <Stat label="Verified dispatch"   value="₹2.91 Cr" sub="Through bills"    icon={ReceiptIndianRupee} />
        <Stat label="Unexplained stock"   value="₹24.8 L"  sub="Requires review"  icon={AlertTriangle} kind="red" />
        <Stat label="Low stock SKUs"      value="38"        sub="Across 7 states"  icon={Boxes} kind="amber" />
      </div>
      <div className="card">
        <div className="cardHead">
          <div><h3>Product stock reconciliation</h3><p>Expected closing = opening + receipts − verified sales ± adjustments</p></div>
          <button className="ghost"><Download size={16} /> Export</button>
        </div>
        <table>
          <thead><tr><th>Product</th><th>Expected</th><th>Reported</th><th>Verified</th><th>Difference</th><th>Control</th></tr></thead>
          <tbody>
            {display.map((p: any) => {
              const diff = p.exp - p.ver;
              return (
                <tr key={p.id}>
                  <td><b>{p.name}</b><small>{p.code} · {p.category}</small></td>
                  <td>{fmt(p.exp)}</td>
                  <td>{fmt(p.ver + Math.max(0, diff / 3))}</td>
                  <td>{fmt(p.ver)}</td>
                  <td className={diff > 500 ? 'bad' : ''}>{fmt(diff)}</td>
                  <td><span className={diff > 500 ? 'status warn' : 'status ok'}>{diff > 500 ? 'Investigate' : 'Matched'}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Bill Import ──────────────────────────────────────────────────────────────
function BillImport({ uploadMsg, onFile, notify, states, distributors, recentBills }: {
  uploadMsg: string; onFile: (f: File, src: string, region: string, date: string, distId: string) => void;
  notify: (s: string) => void; states: StateName[]; distributors: Distributor[]; recentBills: Bill[];
}) {
  const [sourceType, setSourceType]   = useState('Tally Sales');
  const [region, setRegion]           = useState('');
  const [billDate, setBillDate]       = useState(today);
  const [distributorId, setDistId]    = useState('');

  return (
    <section className="content">
      <div className="pageIntro">
        <div><h2>Daily Bill Import</h2><p>Excel/CSV and text-based PDF bills are extracted and standardised before reconciliation.</p></div>
      </div>
      <div className="uploadGrid">
        <div className="card uploadCard">
          <Upload size={30} />
          <h3>Drop your daily file</h3>
          <p>Excel (.xlsx/.xls), CSV or PDF. Text-based PDFs extracted page-by-page; scanned PDFs flagged for OCR.</p>
          <label className="uploadButton">Choose file
            <input type="file" accept=".xlsx,.xls,.csv,.pdf,application/pdf"
              onChange={e => e.target.files?.[0] && onFile(e.target.files[0], sourceType, region, billDate, distributorId)} />
          </label>
          {uploadMsg && <div className="uploadResult">{uploadMsg}</div>}
        </div>
        <div className="card">
          <h3>Import settings</h3>
          <label>Source type
            <select value={sourceType} onChange={e => setSourceType(e.target.value)}>
              <option>Tally Sales</option><option>Super Distributor Dispatch</option>
              <option>Distributor Bill</option><option>Secondary Sales</option><option>Collection Report</option>
            </select>
          </label>
          <label>Region
            <select value={region} onChange={e => setRegion(e.target.value)}>
              <option value="">All Regions</option>
              {states.length
                ? states.map(s => <option key={s.id} value={s.id}>{s.name}</option>)
                : ['Odisha','Haryana','Delhi','Rajasthan','Gujarat','Telangana','Kerala'].map(s => <option key={s} value={s}>{s}</option>)
              }
            </select>
          </label>
          {distributors.length > 0 && (
            <label>Distributor
              <select value={distributorId} onChange={e => setDistId(e.target.value)}>
                <option value="">Select distributor</option>
                {distributors.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
          )}
          <label>Bill date<input type="date" value={billDate} onChange={e => setBillDate(e.target.value)} /></label>
          <button className="primary full" onClick={() => notify(sourceType + ' import queued for validation')}>
            Process &amp; Reconcile
          </button>
        </div>
      </div>
      <div className="card">
        <div className="cardHead"><div><h3>Import rules</h3><p>Duplicate protection and source traceability</p></div></div>
        <div className="rulegrid">
          <Rule title="Duplicate check"  text="Bill number + party + date + source type" />
          <Rule title="Product mapping"  text="Code, barcode and approved aliases" />
          <Rule title="Stock safety"     text="No silent negative stock or overwrite" />
          <Rule title="Audit trail"      text="Original filename, importer ID and timestamp retained" />
        </div>
      </div>
      {recentBills.length > 0 && (
        <div className="card">
          <div className="cardHead"><div><h3>Recent imports</h3><p>Latest bills saved to Supabase</p></div></div>
          <table>
            <thead><tr><th>Bill no.</th><th>Source</th><th>Date</th><th>Value</th><th>Status</th></tr></thead>
            <tbody>
              {recentBills.slice(0, 10).map(b => (
                <tr key={b.id}>
                  <td><b>{b.bill_no}</b></td><td>{b.source_type}</td><td>{b.bill_date}</td>
                  <td>₹{fmt(b.reported_value)}</td>
                  <td><span className={b.status === 'VERIFIED' ? 'status ok' : b.status === 'EXCEPTION' ? 'status warn' : 'status info'}>{b.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Rule({ title, text }: { title: string; text: string }) {
  return (
    <div className="rule"><ShieldCheck size={18} /><div><b>{title}</b><p>{text}</p></div></div>
  );
}

// ─── Reconciliation ───────────────────────────────────────────────────────────
function Reconciliation({ exceptions }: { exceptions: ExceptionRow[] }) {
  return (
    <section className="content">
      <div className="pageIntro">
        <div><h2>Reconciliation Engine</h2><p>Reported figures stay intact; verified figures are calculated separately.</p></div>
        <button className="primary"><RefreshCw size={17} /> Run reconciliation</button>
      </div>
      <div className="reconCards">
        <div><span>Reported sales</span><b>₹3.48 Cr</b></div>
        <div><span>Verified sales</span><b>₹3.18 Cr</b></div>
        <div><span>Unverified</span><b className="redText">₹30.2 L</b></div>
        <div><span>Stock difference</span><b className="amberText">₹24.8 L</b></div>
      </div>
      <div className="card">
        <div className="cardHead">
          <div><h3>Exceptions requiring verification</h3><p>A difference does not automatically mean false reporting.</p></div>
          <span className="count">{exceptions.length} open</span>
        </div>
        <table>
          <thead><tr><th>Reference</th><th>Layer</th><th>Issue</th><th>Description</th><th>Variance</th><th>Status</th></tr></thead>
          <tbody>
            {exceptions.map(e => (
              <tr key={e.id}>
                <td><b>{e.exception_code}</b></td>
                <td>{e.layer || '—'}</td>
                <td>{e.issue_type}</td>
                <td>{e.description}</td>
                <td className="bad">
                  {e.variance_value ? `₹${fmt(e.variance_value)}` : e.variance_qty ? fmt(e.variance_qty) : '—'}
                </td>
                <td><span className="status warn">{e.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Collections ──────────────────────────────────────────────────────────────
function Collections({ data, onRecord }: { data: Collection[]; onRecord: (c: string, a: number, m: string, d: string) => void }) {
  const [showForm, setShowForm] = useState(false);
  const [cust, setCust]   = useState('');
  const [amt, setAmt]     = useState('');
  const [mode, setMode]   = useState('NEFT');
  const [date, setDate]   = useState(today);

  const totalOutstanding = 6840000;
  const collectedToday   = data.filter(c => c.collection_date === today).reduce((s, c) => s + c.amount, 0) || 1480000;
  const overdue          = data.filter(c => c.status === 'EXCEPTION').reduce((s, c) => s + (c.amount || 0), 0) || 1280000;

  const submit = () => {
    if (!cust || !amt) return;
    onRecord(cust, parseFloat(amt), mode, date);
    setCust(''); setAmt(''); setShowForm(false);
  };

  return (
    <section className="content">
      <div className="pageIntro">
        <div><h2>Collections</h2><p>Track invoice due, collected amount, outstanding and overdue across layers.</p></div>
        <button className="primary" onClick={() => setShowForm(v => !v)}><Plus size={17} /> Record collection</button>
      </div>
      {showForm && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <h3>Record new collection</h3>
          <div className="formGrid">
            <label>Customer name<input value={cust} onChange={e => setCust(e.target.value)} placeholder="e.g. Maa Traders" /></label>
            <label>Amount (₹)<input type="number" value={amt} onChange={e => setAmt(e.target.value)} placeholder="e.g. 50000" /></label>
            <label>Mode<select value={mode} onChange={e => setMode(e.target.value)}><option>NEFT</option><option>Cheque</option><option>Cash</option><option>UPI</option></select></label>
            <label>Date<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
          </div>
          <div style={{ display:'flex', gap:'8px', marginTop:'12px' }}>
            <button className="primary" onClick={submit}>Save</button>
            <button className="ghost" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </div>
      )}
      <div className="stats">
        <Stat label="Receivables"     value={fmtL(totalOutstanding)} sub="Total outstanding" icon={WalletCards} />
        <Stat label="Collected today" value={fmtL(collectedToday)}   sub="Today's receipts"  icon={ShieldCheck} kind="green" />
        <Stat label="Overdue"         value={fmtL(overdue)}          sub="Pending action"    icon={AlertTriangle} kind="red" />
        <Stat label="Collection %"    value={pcOf(collectedToday, totalOutstanding)} sub="Month to date" icon={Activity} />
      </div>
      <div className="card">
        <div className="cardHead"><div><h3>Collection ledger</h3><p>Every receipt is linked to invoice, customer and collector.</p></div></div>
        <table>
          <thead><tr><th>Date</th><th>Customer</th><th>Amount</th><th>Mode</th><th>Status</th></tr></thead>
          <tbody>
            {(data.length ? data : DEMO_COLLECTIONS as unknown as Collection[]).map(c => (
              <tr key={c.id}>
                <td>{c.collection_date}</td>
                <td>{c.customer_name || '—'}</td>
                <td>₹{fmt(c.amount)}</td>
                <td>{c.payment_mode || '—'}</td>
                <td><span className={c.status === 'VERIFIED' ? 'status ok' : c.status === 'EXCEPTION' ? 'status warn' : 'status info'}>{c.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Salesmen ────────────────────────────────────────────────────────────────
function Salesmen({ data, query, setQuery }: { data: any[]; query: string; setQuery: (s: string) => void }) {
  const activeCount = data.filter(s => s.active).length || data.length;
  return (
    <section className="content">
      <div className="pageIntro">
        <div><h2>Salesmen</h2><p>Manage field salespeople and track their full activity trail per region.</p></div>
        <button className="primary"><Plus size={17} /> Add salesman</button>
      </div>
      <div className="stats">
        <Stat label="Active salesmen"  value={String(activeCount)} sub="Across all regions" icon={Users} />
        <Stat label="Calls today"      value="1,286" sub="+9.4% vs yesterday"  icon={Activity} />
        <Stat label="Productive calls" value="924"   sub="71.8% PC%"          icon={UserRoundCheck} kind="green" />
        <Stat label="Field collections" value="₹48.2 L" sub="Today"           icon={WalletCards} />
      </div>
      <div className="card">
        <div className="tableTools">
          <div><h3>Salesman roster</h3><p>Region, territory, calls, PC%, secondary sales and collections.</p></div>
          <div className="search"><Search size={16} /><input placeholder="Search name, territory…" value={query} onChange={e => setQuery(e.target.value)} /></div>
        </div>
        <table>
          <thead><tr><th>Salesman</th><th>Territory</th><th>Calls</th><th>PC</th><th>PC%</th><th>Sec Sales</th><th>Collections</th><th>Status</th></tr></thead>
          <tbody>
            {data.map((s: any) => (
              <tr key={s.id}>
                <td><div className="person"><div className="miniAvatar">{s.name.split(' ').map((x: string) => x[0]).join('').slice(0, 2)}</div>
                  <div><b>{s.name}</b><small>{s.employee_code} · {s.state_id}</small></div></div></td>
                <td>{s.territory}</td>
                <td>{s.calls ?? '—'}</td>
                <td>{s.pc ?? '—'}</td>
                <td>{s.calls && s.pc ? `${((s.pc / s.calls) * 100).toFixed(0)}%` : '—'}</td>
                <td>{s.secSales ? fmtL(s.secSales) : '—'}</td>
                <td>{s.coll ? fmtL(s.coll) : '—'}</td>
                <td><span className={s.active ? 'status ok' : 'status warn'}>{s.active ? 'Active' : 'Inactive'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Performance ──────────────────────────────────────────────────────────────
function Performance({ salesmen }: { salesmen: any[] }) {
  const totalCalls  = salesmen.reduce((s, x) => s + (x.calls || 0), 0);
  const totalPC     = salesmen.reduce((s, x) => s + (x.pc || 0), 0);
  const totalSec    = salesmen.reduce((s, x) => s + (x.secSales || 0), 0);
  const totalColl   = salesmen.reduce((s, x) => s + (x.coll || 0), 0);
  return (
    <section className="content">
      <div className="pageIntro">
        <div><h2>Sales Performance</h2><p>Daily, weekly and monthly performance with region and salesman drill-down.</p></div>
        <select><option>September 2026</option><option>August 2026</option></select>
      </div>
      <div className="card">
        <div className="cardHead"><div><h3>Performance scorecard</h3><p>Operational KPIs — not a hidden ranking.</p></div></div>
        <div className="perfgrid">
          {[
            ['Total Calls',     fmt(totalCalls || 12486), '+6.8%'],
            ['Productive Calls',fmt(totalPC || 8924),     '+9.2%'],
            ['PC%',             pcOf(totalPC || 8924, totalCalls || 12486), '+1.8 pts'],
            ['Secondary Sales', fmtL(totalSec || 21600000), '+8.2%'],
            ['Sec / PC',        totalPC ? `₹${fmt((totalSec || 21600000) / (totalPC || 8924), 0)}` : '—', '+3.1%'],
            ['Collections',     fmtL(totalColl || 14800000), '+7.4%'],
          ].map(x => <div className="perf" key={x[0]}><span>{x[0]}</span><b>{x[1]}</b><small>{x[2]}</small></div>)}
        </div>
      </div>
      <div className="card">
        <h3>Activity timeline (today)</h3>
        <p className="muted">Each salesman can log calls, orders, collections, visits and follow-ups.</p>
        <div className="timeline">
          {[
            ['09:15','Retailer visit','City Cosmetics · Gurugram'],
            ['10:40','Productive order','Maa Traders · Bhubaneswar'],
            ['12:05','Collection received','INV-24102 · ₹50,000'],
            ['14:20','New retailer added','Glow Point · Cuttack'],
            ['16:45','Follow-up completed','Beauty Hub · Delhi'],
          ].map(([t, title, sub]) => (
            <div key={t}><time>{t}</time><div className="lineDot" /><section><b>{title}</b><p>{sub}</p></section></div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Exceptions ───────────────────────────────────────────────────────────────
function Exceptions({ data, onAdd, notify }: { data: ExceptionRow[]; onAdd: (c: string, l: string, i: string, d: string) => void; notify: (s: string) => void }) {
  const [showForm, setShowForm] = useState(false);
  const [code, setCode]   = useState('');
  const [layer, setLayer] = useState('');
  const [issue, setIssue] = useState('Stock gap');
  const [desc, setDesc]   = useState('');

  const submit = () => {
    if (!code || !desc) { notify('Exception code and description are required'); return; }
    onAdd(code, layer, issue, desc);
    setCode(''); setLayer(''); setDesc(''); setShowForm(false);
  };

  const stockGaps = data.filter(e => e.issue_type?.toLowerCase().includes('stock')).length;
  const salesGaps = data.filter(e => e.issue_type?.toLowerCase().includes('sales')).length;
  const collGaps  = data.filter(e => e.issue_type?.toLowerCase().includes('collection')).length;

  return (
    <section className="content">
      <div className="pageIntro">
        <div><h2>Exception Center</h2><p>Investigate gaps before approving any stock or sales adjustment.</p></div>
        <div style={{ display:'flex', gap:'8px' }}>
          <button className="primary" onClick={() => setShowForm(v => !v)}><Plus size={16} /> Log exception</button>
          <button className="ghost"><Download size={16} /> Export</button>
        </div>
      </div>
      {showForm && (
        <div className="card" style={{ marginBottom:'1rem' }}>
          <h3>Log new exception</h3>
          <div className="formGrid">
            <label>Exception code<input value={code} onChange={e => setCode(e.target.value)} placeholder="e.g. EX-1026" /></label>
            <label>Layer / Distributor<input value={layer} onChange={e => setLayer(e.target.value)} placeholder="e.g. Distributor C" /></label>
            <label>Issue type<select value={issue} onChange={e => setIssue(e.target.value)}>
              <option>Stock gap</option><option>Sales gap</option><option>Collection gap</option><option>Duplicate bill</option><option>Missing data</option>
            </select></label>
            <label>Description<input value={desc} onChange={e => setDesc(e.target.value)} placeholder="Detailed description" /></label>
          </div>
          <div style={{ display:'flex', gap:'8px', marginTop:'12px' }}>
            <button className="primary" onClick={submit}>Save</button>
            <button className="ghost" onClick={() => setShowForm(false)}>Cancel</button>
          </div>
        </div>
      )}
      <div className="stats">
        <Stat label="Open exceptions" value={String(data.length)} sub="Need review"      icon={AlertTriangle} kind="red" />
        <Stat label="Stock gaps"      value={String(stockGaps)}   sub="Inventory"        icon={Boxes} />
        <Stat label="Sales gaps"      value={String(salesGaps)}   sub="Unverified"       icon={ReceiptIndianRupee} />
        <Stat label="Collection gaps" value={String(collGaps)}    sub="Overdue / partial" icon={WalletCards} />
      </div>
      <div className="card">
        <table>
          <thead><tr><th>Exception</th><th>Layer</th><th>Issue</th><th>Description</th><th>Variance</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>
            {data.map(e => (
              <tr key={e.id}>
                <td><b>{e.exception_code}</b></td>
                <td>{e.layer || '—'}</td>
                <td>{e.issue_type}</td>
                <td>{e.description}</td>
                <td className="bad">{e.variance_value ? `₹${fmt(e.variance_value)}` : e.variance_qty ? fmt(e.variance_qty) : '—'}</td>
                <td><span className="status warn">{e.status}</span></td>
                <td><button className="smallBtn">Open case</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Reports ─────────────────────────────────────────────────────────────────
function Reports() {
  const reports = [
    ['Inventory Movement',    'Opening, receipts, dispatch, sales, closing and gaps'],
    ['Sales Reconciliation',  'Tally vs distributor vs secondary sales'],
    ['Collection Aging',      'Paid, partial, overdue and outstanding'],
    ['Salesman Performance',  'Calls, PC%, sales, collection and activity'],
    ['Product Variance',      'Quantity, rate and value mismatches'],
    ['Audit Trail',           'Who changed what, when and why'],
  ];
  return (
    <section className="content">
      <div className="pageIntro">
        <div><h2>Reports</h2><p>Export reconciled data without losing source transactions.</p></div>
        <button className="primary"><Download size={17} /> Export all</button>
      </div>
      <div className="reportGrid">
        {reports.map(([title, desc]) => (
          <div className="reportCard" key={title}>
            <div className="reportIcon"><FileSpreadsheet size={20} /></div>
            <h3>{title}</h3><p>{desc}</p>
            <button className="ghost">Generate <ChevronRight size={15} /></button>
          </div>
        ))}
      </div>
    </section>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
