import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { supabase, Distributor, Product, SalesOfficer, StockLine, fetchAll, matchSO, fmt, money, plural, errText } from "../lib/supabase";
import { localDate } from "../lib/parse";
import DateRange, { PRESETS, Range } from "../components/DateRange";
import { Select } from "../components/Select";
import { useColumnFilters, Col } from "../components/ColumnFilter";
import { ChartView } from "../components/Charts";
import { ChartData } from "../lib/insights";
import Staff, { rankOf } from "../components/Staff";
import SOReport from "../components/SOReport";
import DsrLinker, { SuspectLinks } from "../components/DsrLinker";
import DistributorReport, { Billing, collectionPct } from "../components/DistributorReport";
import { readDsr, mergeBooks, DsrBook, DsrDay, teamTotal as sheetTeamTotal } from "../lib/dsr";
import { exportPng } from "../lib/present";
import { startTask, breathe } from "../lib/tasks";

interface Day { id: string; so_id: string; day: string; state: string | null; manager: string | null; hq: string | null; db_name: string | null; distributor_id: string | null; town: string | null; beat: string | null; remark: string | null; attendance: string | null; total_calls: number; productive_calls: number; sale_value: number }
interface Prod { product: string; category: string | null; qty: number; value: number }
interface StockCheck { distributor_id: string; product: string; product_id: string | null; so_qty: number; so_value: number; opening: number; received: number; closing: number; counted: boolean; has_before: boolean }
interface StateDay { state: string; day: string; total_calls: number; productive_calls: number; sale_value: number; team?: string }
interface Props { officers: SalesOfficer[]; locations: Distributor[]; stock: StockLine[]; products?: Product[]; canManage: boolean; onChanged: () => Promise<void>; notify: (m: string) => void }
interface Checked { book: DsrBook; files: string; fresh: DsrDay[]; same: number; changed: { d: DsrDay; old: Day }[] }

const SHORT: Record<string, string> = { Present: "P", "Half Day": "½", Meeting: "M", Leave: "L", "Weekly Off": "WO", Holiday: "H", Absent: "A", "No Report": "–" };
const cls = (a?: string | null) => `att a-${(SHORT[a || ""] || "none").replace("½", "half").replace("–", "none")}`;
const WORKING = new Set(["Present", "Half Day", "Meeting"]);
const n = (x: unknown) => Number(x) || 0;
const wd = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short" });
const pct = (a: number, b: number) => (b ? (a / b) * 100 : 0);
const same = (a: DsrDay, b: Day) => n(a.total_calls) === n(b.total_calls) && n(a.productive_calls) === n(b.productive_calls) && Math.abs(n(a.sale_value) - n(b.sale_value)) < 1 && (a.attendance || "") === (b.attendance || "");

interface Sum { soId: string; so?: SalesOfficer; days: number; att: Record<string, number>; calls: number; pc: number; value: number; flag: string }

export default function SOReports({ officers, locations, stock, products, canManage, onChanged, notify }: Props) {
  const [range, setRange] = useState<Range>(() => PRESETS.find(p => p.id === "month")!.range());
  const [tab, setTab] = useState<string>("overview"), [showIdle, setShowIdle] = useState(false);
  const [zone, setZone] = useState(""), [q, setQ] = useState(""), [focus, setFocus] = useState("");
  const [days, setDays] = useState<Day[]>([]), [prods, setProds] = useState<Prod[]>([]), [states, setStates] = useState<StateDay[]>([]), [bills, setBills] = useState<Billing[]>([]);
  const [latest, setLatest] = useState<Day[]>([]);
  const [err, setErr] = useState(""), [reload, setReload] = useState(0);
  const [check, setCheck] = useState<Checked | null>(null), [replaceChanged, setReplaceChanged] = useState(false);
  const [busy, setBusy] = useState(""), [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [report, setReport] = useState<Distributor | null>(null);
  const [person, setPerson] = useState<SalesOfficer | null>(null);
  const charts = useRef<HTMLDivElement>(null);
  const byId = useMemo(() => new Map(officers.map(o => [o.id, o])), [officers]);
  const locById = useMemo(() => new Map(locations.map(l => [l.id, l])), [locations]);
  const zoneOf = (o?: SalesOfficer) => o?.zone || o?.state || "No zone";

  // ---------- who is in view: zone, search (people, HQ, areas, towns) with their seniors, or one person and everyone under them ----------
  const kids = useMemo(() => { const m = new Map<string, string[]>(); officers.forEach(o => { if (o.manager_id) m.set(o.manager_id, [...(m.get(o.manager_id) || []), o.id]); }); return m; }, [officers]);
  const below = (id: string, acc = new Set<string>()) => { acc.add(id); (kids.get(id) || []).forEach(k => !acc.has(k) && below(k, acc)); return acc; };
  const above = (id: string, acc = new Set<string>()) => { const m = byId.get(id)?.manager_id; if (m && !acc.has(m)) { acc.add(m); above(m, acc); } return acc; };
  const towns = useMemo(() => { const m = new Map<string, string>(); days.forEach(d => m.set(d.so_id, `${m.get(d.so_id) || ""} ${d.town || ""} ${d.beat || ""} ${d.db_name || ""}`)); return m; }, [days]);
  const inView = useMemo(() => {
    let ids = new Set(officers.filter(o => !zone || zoneOf(o) === zone).map(o => o.id));
    if (focus) ids = below(focus);
    const t = q.trim().toLowerCase();
    if (t) {
      const hit = officers.filter(o => ids.has(o.id) && `${o.name} ${o.hq || ""} ${o.region || ""} ${o.areas || ""} ${zoneOf(o)} ${towns.get(o.id) || ""}`.toLowerCase().includes(t));
      const out = new Set<string>();
      hit.forEach(o => { below(o.id).forEach(x => out.add(x)); above(o.id).forEach(x => out.add(x)); });
      ids = out;
    }
    return ids;
  }, [officers, zone, focus, q, towns, kids]);
  const filtered = !!(zone || focus || q.trim());
  const sos = filtered ? [...inView] : null;

  useEffect(() => {
    if (!supabase) return;
    let live = true;
    const last = localDate(new Date(Date.now() - 864e5)), task = startTask("Loading SO reports", 0, true);
    Promise.all([
      fetchAll<Day>((a, b) => supabase!.from("dsr_days").select("*").gte("day", range.from).lte("day", range.to).order("day").order("id").range(a, b)),
      fetchAll<StateDay>((a, b) => supabase!.from("dsr_state_days").select("*").gte("day", range.from).lte("day", range.to).order("day").range(a, b)).catch(() => []),
      supabase.rpc("billing_summary", { p_from: range.from, p_to: range.to }),
      supabase.from("dsr_days").select("day").lte("day", last).order("day", { ascending: false }).limit(1),
    ]).then(async ([d, s, b, l]) => {
      if (!live) return;
      setDays(d); setStates(s as StateDay[]); setBills((b.data || []) as Billing[]); setErr("");
      const lastDay = (l.data as { day: string }[] | null)?.[0]?.day;
      if (lastDay) { const { data } = await supabase!.from("dsr_days").select("*").eq("day", lastDay); if (live) setLatest((data || []) as Day[]); } else setLatest([]);
      task.ok(`${plural(d.length, "SO day")} from ${range.from} to ${range.to}.`);
    }).catch(e => { if (!live) return; task.fail(errText(e)); setErr(`Couldn't load SO reports: ${errText(e)}. Run the latest database steps (009 and 010) in Supabase.`); })
    return () => { live = false; task.cancel(); };
  }, [range.from, range.to, reload]);
  // Product totals follow the people in view; waits until typing in the search box pauses.
  const sosKey = sos?.join(",") || "";
  useEffect(() => {
    if (!supabase) return;
    const t = window.setTimeout(() => {
      supabase!.rpc("dsr_product_totals", { p_from: range.from, p_to: range.to, p_sos: sos, p_state: null })
        .then(({ data }) => setProds(((data || []) as Prod[]).sort((x, y) => n(y.value) - n(x.value))));
    }, 400);
    return () => window.clearTimeout(t);
  }, [range.from, range.to, reload, sosKey]);

  const view = days.filter(d => inView.has(d.so_id) || (!filtered && !byId.has(d.so_id)));

  // ---------- upload: several workbooks, every sheet accounted for, nobody logged twice ----------
  async function read(files: File[]) {
    setMsg(null); setCheck(null); setReplaceChanged(false); setBusy("read");
    const task = startTask(`Reading ${plural(files.length, "DSR workbook")}`, files.length);
    try {
      const books: DsrBook[] = [];
      for (let i = 0; i < files.length; i++) { task.step(i, files.length, files[i].name); await breathe(); books.push(readDsr(XLSX.read(await files[i].arrayBuffer(), { cellDates: false }), files[i].name)); }
      const book = mergeBooks(books);
      if (!book.days.length && !book.stateDays.length) throw new Error("No daily rows found. SO sheets need headings such as Name SO, Month/Date and Total Call.");
      const ds = book.days.map(d => d.day).sort();
      const existing = ds.length ? await fetchAll<Day>((a, b) => supabase!.from("dsr_days").select("*").gte("day", ds[0]).lte("day", ds[ds.length - 1]).order("id").range(a, b)) : [];
      const have = new Map(existing.map(e => [`${e.so_id}|${e.day}`, e]));
      const fresh: DsrDay[] = [], changed: Checked["changed"] = []; let sameN = 0;
      book.days.forEach(d => {
        const o = matchSO(d.so, officers), old = o ? have.get(`${o.id}|${d.day}`) : undefined;
        if (!old) fresh.push(d); else if (same(d, old)) sameN++; else changed.push({ d, old });
      });
      setCheck({ book, files: files.map(f => f.name).join(", "), fresh, same: sameN, changed });
      task.ok(`${plural(fresh.length, "new day")} to add. Press Add on the Upload DSR tab to save them.`);
    } catch (e) { task.fail(errText(e)); setMsg({ kind: "err", text: `Couldn't read the file: ${errText(e)}` }); }
    finally { setBusy(""); }
  }
  async function post() {
    if (!supabase || !check) return;
    setBusy("post");
    const strip = (list: DsrDay[]) => list.map(({ sheet: _s, file: _f, ...d }) => d);
    let added = 0, replaced = 0, newSos = 0, first = true;
    const total = check.fresh.length + (replaceChanged ? check.changed.length : 0), task = startTask("Saving DSR days", total);
    try {
      const send = async (list: DsrDay[], replace: boolean) => {
        for (let i = 0; i < list.length || (first && i === 0); i += 300) {
          const { data, error } = await supabase!.rpc("post_dsr", { p_days: strip(list.slice(i, i + 300)), p_products: first ? check.book.products : [], p_source: check.files,
            p_state_days: first ? check.book.stateDays : [], p_replace: replace });
          if (error) throw error;
          first = false;
          const r = data as { added: number; replaced: number; new_sos: number };
          added += r.added; replaced += r.replaced; newSos += r.new_sos;
          setMsg({ kind: "ok", text: `Saving… ${fmt(added + replaced)} days` }); task.step(added + replaced, total);
        }
      };
      await send(check.fresh, false);
      if (replaceChanged && check.changed.length) await send(check.changed.map(c => c.d), true);
      const text = `Added ${plural(added, "new day")}${replaced ? `, replaced ${plural(replaced, "day")}` : ""}${check.same ? `; ${plural(check.same, "day")} already logged were left as they were` : ""}${!replaceChanged && check.changed.length ? `; ${plural(check.changed.length, "day")} with different figures were kept as first logged` : ""}${newSos ? `; added ${plural(newSos, "new person", "new people")} to the sales team` : ""}.`;
      setMsg({ kind: "ok", text }); notify(text); task.ok(text); setCheck(null); setReload(x => x + 1);
      if (newSos) await onChanged();
    } catch (e) { const t = `Stopped after ${plural(added + replaced, "day")}: ${errText(e)}`; task.fail(t); setMsg({ kind: "err", text: t }); }
    finally { setBusy(""); }
  }

  // ---------- per person ----------
  const sums = useMemo<Sum[]>(() => {
    const m = new Map<string, Sum>();
    view.forEach(d => {
      const s = m.get(d.so_id) || { soId: d.so_id, so: byId.get(d.so_id), days: 0, att: {}, calls: 0, pc: 0, value: 0, flag: "" };
      s.days++; const a = d.attendance || "No Report"; s.att[a] = (s.att[a] || 0) + 1;
      s.calls += n(d.total_calls); s.pc += n(d.productive_calls); s.value += n(d.sale_value);
      m.set(d.so_id, s);
    });
    const all = [...m.values()], team = pct(all.reduce((x, s) => x + s.pc, 0), all.reduce((x, s) => x + s.calls, 0));
    const idle = new Map<string, number>(); view.forEach(d => { if (d.attendance === "Present" && !n(d.total_calls) && !n(d.sale_value)) idle.set(d.so_id, (idle.get(d.so_id) || 0) + 1); });
    return all.map(s => {
      const f: string[] = [], strike = pct(s.pc, s.calls);
      if (s.calls >= 20 && strike < team * 0.8) f.push(`Strike rate ${fmt(strike)}% vs team ${fmt(team)}%`);
      if (idle.get(s.soId)) f.push(`${plural(idle.get(s.soId)!, "working day")} with no calls`);
      if (s.att["No Report"]) f.push(`${plural(s.att["No Report"], "day")} not reported`);
      if (s.att.Absent) f.push(`${plural(s.att.Absent, "day")} absent`);
      return { ...s, flag: f.join("; ") };
    });
  }, [view, byId]);
  const dbCount = useMemo(() => { const m = new Map<string, Set<string>>(); view.forEach(d => { const k = d.distributor_id || d.db_name; if (k && WORKING.has(d.attendance || "")) m.set(d.so_id, (m.get(d.so_id) || new Set()).add(k)); }); return m; }, [view]);
  const working = (s: Sum) => ["Present", "Half Day", "Meeting"].reduce((a, k) => a + (s.att[k] || 0), 0);
  const scols: Col<Sum>[] = [
    { key: "so", label: "Name", value: s => s.so?.name || "Unknown" }, { key: "post", label: "Post", value: s => s.so?.designation },
    { key: "boss", label: "Reports To", value: s => byId.get(s.so?.manager_id || "")?.name }, { key: "zone", label: "Zone", value: s => zoneOf(s.so) }, { key: "hq", label: "HQ", value: s => s.so?.hq || s.so?.region },
    { key: "dbs", label: "DBs Worked", value: s => dbCount.get(s.soId)?.size || 0, num: true },
    { key: "present", label: "Present", value: s => (s.att.Present || 0) + (s.att["Half Day"] || 0) / 2, num: true }, { key: "leave", label: "Leave", value: s => s.att.Leave || 0, num: true },
    { key: "off", label: "Off / Holiday", value: s => (s.att["Weekly Off"] || 0) + (s.att.Holiday || 0), num: true },
    { key: "calls", label: "Total Calls", value: s => s.calls, num: true }, { key: "pc", label: "Productive Calls", value: s => s.pc, num: true },
    { key: "strike", label: "PC %", value: s => Math.round(pct(s.pc, s.calls)), num: true }, { key: "value", label: "Secondary ₹", value: s => Math.round(s.value), num: true },
    { key: "perday", label: "₹ Per Working Day", value: s => (working(s) ? Math.round(s.value / working(s)) : 0), num: true }, { key: "flag", label: "Flag", value: s => s.flag },
  ];
  const st = useColumnFilters(sums, scols);

  // ---------- tree: zone → ASM → ASE → SO ----------
  const sumOf = useMemo(() => new Map(sums.map(s => [s.soId, s])), [sums]);
  // Team totals worked out once per change, not on every comparison while sorting the tree.
  const teamTotals = useMemo(() => new Map(officers.map(o => { let v = 0, c = 0, p = 0; below(o.id).forEach(x => { const s = sumOf.get(x); if (s) { v += s.value; c += s.calls; p += s.pc; } }); return [o.id, { v, c, p }]; })), [officers, sumOf, kids]);
  const teamTotal = (id: string) => teamTotals.get(id) || { v: 0, c: 0, p: 0 };
  const hasData = (id: string) => [...below(id)].some(x => sumOf.has(x));
  const roots = officers.filter(o => inView.has(o.id) && (!o.manager_id || !inView.has(o.manager_id)) && (showIdle || hasData(o.id)))
    .sort((a, b) => zoneOf(a).localeCompare(zoneOf(b)) || rankOf(a.designation) - rankOf(b.designation) || a.name.localeCompare(b.name));
  const zonesInTree = [...new Set(roots.map(zoneOf))];
  const node = (o: SalesOfficer, depth: number): JSX.Element => {
    const t = teamTotal(o.id), s = sumOf.get(o.id), sub = (kids.get(o.id) || []).map(id => byId.get(id)!).filter(x => x && inView.has(x.id) && (showIdle || hasData(x.id))).sort((a, b) => rankOf(a.designation) - rankOf(b.designation) || teamTotal(b.id).v - teamTotal(a.id).v);
    return <div key={o.id} className={`st-node d${depth}${focus === o.id ? " on" : ""}`}>
      <button className="st-head" onClick={() => setPerson(o)} title="Open their report">
        <span className={`st-post p-${o.designation || "SO"}`}>{o.designation || "SO"}</span><b>{o.name}</b><small>{o.hq || o.region || ""}</small>
        <span className="st-num">{money(t.v)}<small>{t.c ? `${fmt(pct(t.p, t.c))}% PC` : "no calls"}{s ? ` · ${working(s)} days · ${plural(dbCount.get(o.id)?.size || 0, "DB")}` : ""}</small></span>
      </button>
      {sub.length > 0 && <div className="st-kids">{sub.map(k => node(k, depth + 1))}</div>}
    </div>;
  };

  // ---------- charts ----------
  const dates = useMemo(() => {
    const out: string[] = [], d = new Date(`${range.from}T00:00:00`), end = new Date(`${range.to}T00:00:00`);
    while (d <= end && out.length < 400) { out.push(localDate(d)); d.setDate(d.getDate() + 1); }
    return out;
  }, [range.from, range.to]);
  const byDay = useMemo(() => { const m = new Map<string, number>(); view.forEach(d => m.set(d.day, (m.get(d.day) || 0) + n(d.sale_value))); return m; }, [view]);
  const trend: ChartData = { type: "lines", unit: "money", summary: "", x: dates.map(d => `${Number(d.slice(8))} ${new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { month: "short" })}`),
    series: [{ key: "sec", name: "Secondary", slot: 1 }], values: [dates.map(d => byDay.get(d) || 0)] };
  const topPeople: ChartData = { type: "bars", unit: "money", summary: "", more: Math.max(0, sums.length - 12), series: [{ key: "v", name: "Secondary", slot: 1 }],
    rows: [...sums].sort((a, b) => b.value - a.value).slice(0, 12).map(s => ({ key: s.soId, label: s.so?.name || "Unknown", sub: s.so?.hq || "", values: [s.value] })) };
  const topProducts: ChartData = { type: "bars", unit: "money", summary: "", more: Math.max(0, prods.length - 12), series: [{ key: "v", name: "Sold", slot: 2 }],
    rows: prods.slice(0, 12).map(p => ({ key: p.product, label: p.product, sub: p.category || "", values: [n(p.value)] })) };
  const cats = new Map<string, number>(); prods.forEach(p => cats.set(p.category || "Other", (cats.get(p.category || "Other") || 0) + n(p.value)));
  const byCategory: ChartData = { type: "bars", unit: "money", summary: "", more: 0, series: [{ key: "v", name: "Sold", slot: 3 }],
    rows: [...cats].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, label: k, values: [v] })) };

  // ---------- checks: state totals, and SO secondary against distributor billing, stock and collection ----------
  const stateGaps = useMemo(() => {
    const m = new Map<string, number>(); days.forEach(d => { const k = `${d.state}|${d.day}`; m.set(k, (m.get(k) || 0) + n(d.sale_value)); });
    return states.map(s => ({ ...s, sos: s.team ? sheetTeamTotal(s.team, s.day, days, officers) : m.get(`${s.state}|${s.day}`) || 0 })).filter(s => Math.abs(n(s.sale_value) - s.sos) > Math.max(100, n(s.sale_value) * 0.01));
  }, [days, states, officers]);
  const billOf = (id: string) => bills.find(b => b.party_type === "LOCATION" && b.party_id === id);
  const stockOf = (id: string) => stock.filter(s => s.distributor_id === id).reduce((a, s) => a + n(s.stock_value), 0);
  const dbRows = useMemo(() => {
    const m = new Map<string, { id: string; value: number; sos: Set<string>; days: number }>();
    view.forEach(d => { if (!d.distributor_id) return; const e = m.get(d.distributor_id) || { id: d.distributor_id, value: 0, sos: new Set<string>(), days: 0 }; e.value += n(d.sale_value); e.sos.add(byId.get(d.so_id)?.name || ""); e.days++; m.set(d.distributor_id, e); });
    return [...m.values()].map(e => {
      const b = billOf(e.id), billed = n(b?.billed), stockV = stockOf(e.id), cp = collectionPct(b), f: string[] = [];
      if (e.value > billed + stockV && (billed || stockV)) f.push("SOs booked more than the distributor bought and holds");
      if (!billed && !stockV) f.push("No stock or bills recorded for this distributor yet");
      if (cp !== null && cp < 50) f.push(`Collection only ${fmt(cp)}%`);
      return { ...e, loc: locById.get(e.id), billed, stockV, cp, flag: f.join("; ") };
    }).sort((a, b) => b.value - a.value);
  }, [view, bills, stock]);
  const unmatched = useMemo(() => { const m = new Map<string, number>(); view.forEach(d => { if (!d.distributor_id && d.db_name && WORKING.has(d.attendance || "") && n(d.sale_value)) m.set(d.db_name, (m.get(d.db_name) || 0) + n(d.sale_value)); }); return [...m].sort((a, b) => b[1] - a[1]); }, [view]);

  // ---------- latest day ----------
  const latestDay = latest[0]?.day;
  const latestRows = latest.filter(d => inView.has(d.so_id) || !filtered);
  const notReported = latestDay ? officers.filter(o => o.active && inView.has(o.id) && rankOf(o.designation) === 2 && !latest.some(d => d.so_id === o.id)) : [];

  const dcols: Col<Day>[] = [
    { key: "day", label: "Date", value: d => d.day }, { key: "so", label: "Name", value: d => byId.get(d.so_id)?.name }, { key: "att", label: "Attendance", value: d => d.attendance },
    { key: "db", label: "DB Name", value: d => (d.distributor_id ? locById.get(d.distributor_id)?.name : d.db_name) }, { key: "town", label: "Town", value: d => d.town },
    { key: "beat", label: "Beat", value: d => d.beat }, { key: "remark", label: "Remark", value: d => d.remark },
    { key: "calls", label: "Total Calls", value: d => n(d.total_calls), num: true }, { key: "pc", label: "Productive Calls", value: d => n(d.productive_calls), num: true },
    { key: "value", label: "Secondary ₹", value: d => Math.round(n(d.sale_value)), num: true },
  ];
  const dt = useColumnFilters(view, dcols);
  const pcols: Col<Prod>[] = [{ key: "product", label: "Product", value: p => p.product }, { key: "category", label: "Category", value: p => p.category },
    { key: "qty", label: "Dozens", value: p => Math.round(n(p.qty) * 10) / 10, num: true }, { key: "value", label: "Value ₹", value: p => Math.round(n(p.value)), num: true }];
  const pt = useColumnFilters(prods, pcols);
  const grid = useMemo(() => { const m = new Map<string, string>(); view.forEach(d => m.set(`${d.so_id}|${d.day}`, d.attendance || "No Report")); return m; }, [view]);
  const gridDates = dates.slice(-62);
  const allZones = [...new Set([...officers.map(zoneOf), ...days.map(d => d.state || "")].filter(Boolean))].sort();
  const tot = sums.reduce((a, s) => ({ calls: a.calls + s.calls, pc: a.pc + s.pc, value: a.value + s.value }), { calls: 0, pc: 0, value: 0 });

  function exportAll() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(st.rows.map(s => Object.fromEntries(scols.map(c => [c.label, c.value(s) ?? ""])))), "Team summary");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dt.rows.map(d => Object.fromEntries(dcols.map(c => [c.label, c.value(d) ?? ""])))), "Daily log");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sums.map(s => ({ Name: s.so?.name || "", ...Object.fromEntries(gridDates.map(d => [d.slice(5), SHORT[grid.get(`${s.soId}|${d}`) || ""] || ""])) }))), "Attendance");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pt.rows.map(p => ({ Product: p.product, Category: p.category, Dozens: n(p.qty), "Value ₹": Math.round(n(p.value)) }))), "Products");
    XLSX.writeFile(wb, `so-reports-${range.from}-to-${range.to}.xlsx`);
  }

  // ---------- SO bookings against distributor stock, product by product ----------
  const [checkRange, setCheckRange] = useState<Range>(() => PRESETS.find(p => p.id === "lastmonth")!.range());
  const [stockRaw, setStockRaw] = useState<StockCheck[] | null>(null), [onlyFlagged, setOnlyFlagged] = useState(false), [checkReload, setCheckReload] = useState(0), [scShown, setScShown] = useState(200);
  useEffect(() => {
    if (!supabase || tab !== "checks") return;
    let live = true;
    const task = startTask("Checking SO bookings against distributor stock", 0, true);
    setStockRaw(null); setScShown(200);
    fetchAll<StockCheck>((a, b) => supabase!.rpc("dsr_stock_check", { p_from: checkRange.from, p_to: checkRange.to }).range(a, b))
      .then(r => { if (live) setStockRaw(r); task.ok(`${plural(r.length, "product line")} compared.`); })
      .catch(e => { task.fail(errText(e)); if (live) setStockRaw([]); });
    return () => { live = false; task.cancel(); };
  }, [checkRange.from, checkRange.to, reload, checkReload, tab]);
  const dbsInView = useMemo(() => new Set(view.map(d => d.distributor_id).filter(Boolean)), [view]);
  const stockRows = useMemo(() => (stockRaw || []).map(r => {
    const so = n(r.so_qty), avail = n(r.opening) + n(r.received), drop = avail - n(r.closing);
    let kind = "ok", flag = "";
    if (!r.product_id) { kind = "noproduct"; flag = "product not in the product list: add the DSR products on the Pricing page"; }
    else if (!r.has_before && !n(r.received)) { kind = "nodata"; flag = r.counted ? "first stock statement is at the end of this period, so what they had before is unknown" : "no stock or bills for this distributor before this period"; }
    else if (so > avail + 0.05) { kind = "over"; flag = `booked ${fmt(so, 1)} doz, had ${fmt(avail, 1)}`; }
    else if (r.counted && so > drop + 0.5) { kind = "drop"; flag = `booked ${fmt(so, 1)} doz, stock went down only ${fmt(drop, 1)}`; }
    return { ...r, loc: locById.get(r.distributor_id), kind, flag };
  }).sort((a, b) => Number(!["over", "drop"].includes(a.kind)) - Number(!["over", "drop"].includes(b.kind)) || n(b.so_value) - n(a.so_value)).filter(r => !filtered || dbsInView.has(r.distributor_id)), [stockRaw, locById, dbsInView, filtered]);
  type SC = (typeof stockRows)[number];
  const sccols: Col<SC>[] = [
    { key: "db", label: "Distributor", value: r => r.loc?.name }, { key: "product", label: "Product", value: r => r.product },
    { key: "qty", label: "Booked (Doz)", value: r => Math.round(n(r.so_qty) * 10) / 10, num: true }, { key: "value", label: "Booked ₹", value: r => Math.round(n(r.so_value)), num: true },
    { key: "open", label: "Had Before", value: r => (r.has_before ? Math.round(n(r.opening) * 10) / 10 : null), num: true },
    { key: "recv", label: "Received", value: r => Math.round(n(r.received) * 10) / 10, num: true },
    { key: "close", label: "Stock At End", value: r => (r.counted ? Math.round(n(r.closing) * 10) / 10 : null), num: true }, { key: "flag", label: "Check", value: r => r.flag },
  ];
  const sct = useColumnFilters(onlyFlagged ? stockRows.filter(r => r.kind === "over" || r.kind === "drop") : stockRows, sccols);

  const TABS = [["overview", "Overview"], ["team", "Team"], ["checks", "Stock Checks"], ["attendance", "Attendance"], ["log", "Daily Log"], ["products", "Products"], ["upload", "Upload DSR"], ["staff", "Sales Team"]] as const;
  const flagged = stockRows.filter(r => r.kind === "over" || r.kind === "drop");
  return <>
    <section className="card sohead">
      <div className="sofilters">
        <DateRange value={range} onChange={setRange} />
        <Select value={zone} onChange={e => { setZone(e.target.value); setFocus(""); }} aria-label="Zone"><option value="">All zones</option>{allZones.map(z => <option key={z} value={z}>{z}</option>)}</Select>
        <input className="search" placeholder="Search a person, HQ, area or town…" value={q} onChange={e => setQ(e.target.value)} />
        <button className="secondary" onClick={exportAll} disabled={!days.length}>Export To Excel</button>
      </div>
      {focus && <p className="hint">Showing {byId.get(focus)?.name} and their team. <button className="link" onClick={() => setFocus("")}>Show Everyone</button></p>}
      <div className="sotabs" role="tablist">{TABS.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
        {label}{id === "checks" && flagged.length ? <em className="bellcount">{flagged.length}</em> : null}</button>)}</div>
      {err && <div className="status err">{err}</div>}
    </section>

    {tab === "overview" && <>
      <div className="cards">
        <div className="metric"><small>Secondary sales</small><b>{money(tot.value)}</b></div>
        <div className="metric"><small>Total calls</small><b>{fmt(tot.calls)}</b></div>
        <div className="metric"><small>Productive calls</small><b>{fmt(tot.pc)}</b></div>
        <div className="metric"><small>Strike rate (PC %)</small><b>{tot.calls ? `${fmt(pct(tot.pc, tot.calls))}%` : "—"}</b></div>
        <div className="metric"><small>Distributors worked</small><b>{fmt(new Set(view.map(d => d.distributor_id || d.db_name).filter(Boolean)).size)}</b></div>
      </div>
      {latestDay && <section className="card">
        <div className="rowhead"><h2>Latest Day: {new Date(`${latestDay}T00:00:00`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}</h2>
          <span className="muted">{money(latestRows.reduce((a, d) => a + n(d.sale_value), 0))} secondary · {plural(latestRows.filter(d => WORKING.has(d.attendance || "")).length, "person", "people")} working</span></div>
        <div className="tablewrap scrolltable short"><table className="nice"><thead><tr><th>Name</th><th>Attendance</th><th>DB</th><th>Town / Beat</th><th>Calls</th><th>PC</th><th>Secondary</th><th>Remark</th></tr></thead>
          <tbody>{[...latestRows].sort((a, b) => n(b.sale_value) - n(a.sale_value)).map(d => <tr key={d.id}><td>{byId.get(d.so_id)?.name}</td><td><i className={cls(d.attendance)}>{d.attendance}</i></td>
            <td>{d.db_name}</td><td className="wrap">{[d.town, d.beat].filter(Boolean).join(" · ")}</td><td>{d.total_calls}</td><td>{d.productive_calls}</td><td>{money(d.sale_value)}</td><td className="wrap">{d.remark}</td></tr>)}
            {notReported.map(o => <tr key={o.id} className="flagged"><td>{o.name}</td><td><i className="att a-none">No report</i></td><td colSpan={6} className="muted">Nothing logged for this day</td></tr>)}</tbody></table></div>
      </section>}
      {view.length > 0 ? <section className="card" ref={charts}>
        <div className="rowhead"><h2>Charts</h2><button className="secondary" onClick={() => charts.current && exportPng(charts.current, "SO charts", `Sales team, ${range.from} to ${range.to}`).catch(e => notify(errText(e)))}>Export Charts</button></div>
        <div className="reportcharts">
          <section><h3>Secondary sales by day</h3><ChartView data={trend} size="focus" labels={false} /></section>
          <section><h3>Top people by secondary</h3><ChartView data={topPeople} size="card" /></section>
          <section><h3>Top products sold</h3>{prods.length ? <ChartView data={topProducts} size="card" /> : <p className="empty">No product lines.</p>}</section>
          <section><h3>Sales by category</h3>{prods.length ? <ChartView data={byCategory} size="card" /> : <p className="empty">No product lines.</p>}</section>
        </div>
      </section> : <p className="empty">No daily reports in this period for this selection. Upload DSRs on the Upload DSR tab.</p>}
    </>}

    {tab === "team" && <section className="card">
      <div className="rowhead"><h2>Team Tree</h2><label className="inline"><input type="checkbox" checked={showIdle} onChange={e => setShowIdle(e.target.checked)} /> Show people with no reports in this period</label></div>
      <p className="hint">Open a zone to see its ASMs, ASEs and SOs with their sales. Click a person to see them and everyone under them.</p>
      {roots.length > 0 ? <div className="st-tree">{zonesInTree.map(z => <details key={z} className="rt-state">
        <summary><h3>{z}</h3><span className="rt-badge">{plural(officers.filter(o => zoneOf(o) === z && inView.has(o.id) && (showIdle || sumOf.has(o.id))).length, "person", "people")}</span>
          <span className="rt-badge">{money(sums.filter(s => zoneOf(s.so) === z).reduce((a, s) => a + s.value, 0))}</span></summary>
        <div className="rt-branch">{roots.filter(o => zoneOf(o) === z).map(o => node(o, 0))}</div></details>)}</div> : <p className="empty">Nobody matches.</p>}
      <div className="rowhead"><h2>Performance</h2>{st.active > 0 && <button className="link" onClick={st.clear}>Clear Filters</button>}</div>
      {sums.length > 0 && st.sortBar}
      {sums.length ? <div className="tablewrap scrolltable"><table className="nice"><thead><tr>{scols.map(c => st.head(c.key))}</tr></thead>
        <tbody>{st.rows.map(s => <tr key={s.soId} className={s.flag ? "flagged" : ""}>{scols.map(c => <td key={c.key} className={c.key === "flag" ? "wrap" : ""}>
          {c.key === "so" ? <button className="link strong" onClick={() => s.so && setPerson(s.so)}>{s.so?.name || "Unknown"}</button> : c.key === "flag" ? s.flag && <span className="err">{s.flag}</span>
            : c.key === "value" || c.key === "perday" ? money(c.value(s)) : c.key === "strike" ? `${c.value(s)}%` : c.value(s)}</td>)}</tr>)}</tbody></table></div>
        : <p className="empty">No daily reports in this period for this selection.</p>}
    </section>}

    {tab === "checks" && <>
      <DsrLinker locations={locations} canManage={canManage} notify={notify} onLinked={() => setCheckReload(x => x + 1)} key={checkReload} />
      <SuspectLinks locations={locations} canManage={canManage} notify={notify} onChanged={() => setCheckReload(x => x + 1)} key={`s${checkReload}`} />
      <section className="card">
        <div className="rowhead"><h2>SO Bookings Against Distributor Stock</h2><DateRange value={checkRange} onChange={setCheckRange} /></div>
        <p className="hint">For each distributor, what SOs booked product by product in this period against what the distributor had: stock before the period plus stock received during it. Upload each distributor's month-end stock and bills, then check the month. Quantities are in dozens.</p>
        <div className="cards">
          <div className="metric"><small>Product lines booked</small><b>{fmt(stockRows.length)}</b></div>
          <div className="metric"><small>Booked with no stock behind them</small><b>{fmt(stockRows.filter(r => r.kind === "over").length)}</b></div>
          <div className="metric"><small>More than stock went down</small><b>{fmt(stockRows.filter(r => r.kind === "drop").length)}</b></div>
          <div className="metric"><small>Can't check yet</small><b>{fmt(stockRows.filter(r => r.kind === "nodata" || r.kind === "noproduct").length)}</b></div>
        </div>
        <div className="actions"><label className="inline"><input type="checkbox" checked={onlyFlagged} onChange={e => setOnlyFlagged(e.target.checked)} /> Only problems</label>{sct.active > 0 && <button className="link" onClick={sct.clear}>Clear Filters</button>}</div>
        {stockRows.length > 0 && sct.sortBar}
        {!stockRaw ? <p className="empty">Comparing bookings with stock…</p> : stockRows.length ? <div className="tablewrap scrolltable"><table className="nice"><thead><tr>{sccols.map(c => sct.head(c.key))}</tr></thead>
          <tbody>{sct.rows.slice(0, scShown).map((r, i) => <tr key={i} className={r.kind === "over" || r.kind === "drop" ? "flagged" : ""}>
            <td>{r.loc ? <button className="link strong" onClick={() => setReport(r.loc!)}>{r.loc.name}</button> : "Deleted"}</td><td>{r.product}</td><td>{fmt(r.so_qty, 1)}</td><td>{money(r.so_value)}</td>
            <td>{r.has_before ? fmt(r.opening, 1) : "—"}</td><td>{fmt(r.received, 1)}</td><td>{r.counted ? fmt(r.closing, 1) : "—"}</td><td className="wrap">{r.flag && <span className={r.kind === "over" || r.kind === "drop" ? "err" : "muted"}>{r.flag}</span>}</td></tr>)}</tbody></table></div>
          : <p className="empty">No SO bookings with a matched distributor in this period.</p>}
        {sct.rows.length > scShown && <div className="actions"><span className="muted">Showing {fmt(scShown)} of {fmt(sct.rows.length)} lines.</span><button className="secondary" onClick={() => setScShown(x => x + 200)}>Show 200 More</button></div>}
      </section>
      <section className="card">
        <h2>Bookings, Billing And Collection By Distributor</h2>
        {stateGaps.length > 0 && <div className="warn">The state total sheet doesn't match the SO sheets on {plural(stateGaps.length, "day")}: {stateGaps.slice(0, 5).map(s => `${s.state} ${s.day} (state total ${money(s.sale_value)}, SOs add up to ${money(s.sos)})`).join("; ")}{stateGaps.length > 5 ? "…" : ""}.</div>}
        {dbRows.length > 0 ? <div className="tablewrap scrolltable"><table className="nice"><thead><tr><th>Distributor</th><th>SOs</th><th>SO Bookings</th><th>Billed To Them</th><th>Stock Now</th><th>Collection %</th><th>Flag</th></tr></thead>
          <tbody>{dbRows.slice(0, 300).map(r => <tr key={r.id} className={r.flag ? "flagged" : ""}><td>{r.loc ? <button className="link strong" onClick={() => setReport(r.loc!)}>{r.loc.name}</button> : "Deleted"}</td>
            <td className="wrap">{[...r.sos].join(", ")}</td><td>{money(r.value)}</td><td>{money(r.billed)}</td><td>{money(r.stockV)}</td><td>{r.cp === null ? "—" : `${fmt(r.cp)}%`}</td><td className="wrap">{r.flag && <span className="err">{r.flag}</span>}</td></tr>)}</tbody></table></div>
          : <p className="empty">No bookings at listed distributors in this period.</p>}
        {unmatched.length > 0 && <p className="hint">{plural(unmatched.length, "DB name")} in the DSRs {unmatched.length === 1 ? "isn't" : "aren't"} in your distributor list, so {unmatched.length === 1 ? "it" : "they"} can't be checked: {unmatched.slice(0, 12).map(([k, v]) => `${k} (${money(v)})`).join(", ")}{unmatched.length > 12 ? "…" : ""}. Add them, or add these spellings as other names on the Distributors page.</p>}
      </section>
    </>}

    {tab === "attendance" && (sums.length ? <section className="card">
      <h2>Attendance</h2>
      <div className="legend attlegend">{Object.entries(SHORT).map(([k, v]) => <span key={k}><i className={cls(k)}>{v}</i>{k}</span>)}</div>
      <div className="tablewrap scrolltable"><table className="attgrid"><thead><tr><th>Name</th>{gridDates.map(d => <th key={d} title={d}>{Number(d.slice(8))}<small>{wd(d).slice(0, 2)}</small></th>)}<th>Working days</th></tr></thead>
        <tbody>{sums.map(s => <tr key={s.soId}><td>{s.so?.name}</td>{gridDates.map(d => { const a = grid.get(`${s.soId}|${d}`); return <td key={d} title={`${d}: ${a || "no row"}`}>{a && <i className={cls(a)}>{SHORT[a] || "?"}</i>}</td>; })}<td><b>{working(s)}</b></td></tr>)}</tbody></table></div>
    </section> : <p className="empty">No daily reports in this period.</p>)}

    {tab === "log" && (view.length ? <section className="card">
      <div className="rowhead"><h2>Daily Log ({dt.rows.length})</h2>{dt.active > 0 && <button className="link" onClick={dt.clear}>Clear Filters</button>}</div>
      {dt.sortBar}
      <div className="tablewrap scrolltable"><table className="nice"><thead><tr>{dcols.map(c => dt.head(c.key))}</tr></thead>
        <tbody>{dt.rows.slice(0, 2000).map(d => <tr key={d.id} className={WORKING.has(d.attendance || "") ? "" : "muted"}>{dcols.map(c => <td key={c.key} className={c.key === "remark" || c.key === "beat" ? "wrap" : ""}>
          {c.key === "att" ? <i className={cls(d.attendance)}>{d.attendance}</i> : c.key === "value" ? money(c.value(d)) : c.value(d)}</td>)}</tr>)}</tbody></table></div>
      {dt.rows.length > 2000 && <p className="hint">Showing 2,000 of {dt.rows.length}. Export to Excel for all of them.</p>}
    </section> : <p className="empty">No daily reports in this period.</p>)}

    {tab === "products" && (prods.length ? <section className="card">
      <div className="rowhead"><h2>Products Sold</h2>{pt.active > 0 && <button className="link" onClick={pt.clear}>Clear Filters</button>}</div>
      <div className="tablewrap scrolltable"><table className="nice"><thead><tr>{pcols.map(c => pt.head(c.key))}</tr></thead>
        <tbody>{pt.rows.map(p => <tr key={p.product}><td>{p.product}</td><td>{p.category}</td><td>{fmt(p.qty, 1)}</td><td>{money(p.value)}</td></tr>)}</tbody></table></div>
    </section> : <p className="empty">No product lines in this period.</p>)}

    {tab === "upload" && <section className="card upload">
      <div className="rowhead"><h2>Upload Daily Sales Reports</h2>
        <label className="button secondary">{busy === "read" ? "Reading…" : "Choose DSR Workbooks"}<input hidden type="file" multiple accept=".xlsx,.xlsm,.xls,.ods,.csv" onChange={e => { const x = [...(e.target.files || [])]; if (x.length) read(x); e.target.value = ""; }} /></label></div>
      <p className="hint">Upload the DSR workbooks for any states, one or several at a time, every day. Every sheet is read: SO sheets give each person's days, the state total is used to check them, and summary sheets are noted. New days are added; a day already logged for a person stays unless you choose to replace it.</p>
      {check && <div className="fixbox">
        <b>{check.files}</b>: {plural(check.fresh.length, "new day")} to add, {plural(check.same, "day")} already logged with the same figures{check.book.stateDays.length ? `, ${plural(check.book.stateDays.length, "state-total day")}` : ""}, {plural(check.book.products.length, "product")} with SS rates.
        {check.changed.length > 0 && <div className="warn">{plural(check.changed.length, "day")} {check.changed.length === 1 ? "is" : "are"} already logged for the same person with different figures, which is a discrepancy: {check.changed.slice(0, 6).map(c => `${c.d.so} on ${c.d.day} (logged ${money(c.old.sale_value)}, ${c.old.total_calls} calls; now ${money(c.d.sale_value)}, ${c.d.total_calls} calls)`).join("; ")}{check.changed.length > 6 ? "…" : ""}.
          <label className="inline"><input type="checkbox" checked={replaceChanged} onChange={e => setReplaceChanged(e.target.checked)} /> Replace them with this upload</label></div>}
        {check.book.dupes.length > 0 && <div className="warn">The same person appears twice on the same day in this upload ({plural(check.book.dupes.length, "time")}); only the first is used: {check.book.dupes.slice(0, 5).join("; ")}{check.book.dupes.length > 5 ? "…" : ""}.</div>}
        <div className="tablewrap scrolltable short"><table className="nice"><thead><tr><th>File</th><th>Sheet</th><th>Read As</th><th>Rows</th><th>Note</th></tr></thead>
          <tbody>{check.book.sheets.map((s, i) => <tr key={i}><td>{s.file}</td><td>{s.name}</td><td>{s.kind}</td><td>{s.rows}</td><td className="wrap">{s.note}</td></tr>)}</tbody></table></div>
        <div className="actions"><button className="secondary" onClick={() => setCheck(null)}>Cancel</button>
          <button disabled={busy === "post" || (!check.fresh.length && !(replaceChanged && check.changed.length) && !check.book.stateDays.length)} onClick={post}>{busy === "post" ? "Saving…" : check.fresh.length + (replaceChanged ? check.changed.length : 0) ? `Add ${plural(check.fresh.length + (replaceChanged ? check.changed.length : 0), "Day")}` : "Save State Totals"}</button></div>
      </div>}
      <div className="reserve">{msg && <div className={`status ${msg.kind}`}>{msg.text}</div>}</div>
    </section>}

    {tab === "staff" && <Staff officers={officers} canManage={canManage} onChanged={onChanged} notify={notify} />}
    {person && <SOReport so={person} officers={officers} locations={locations} stock={stock} onClose={() => setPerson(null)} onTeam={id => { setFocus(id); setTab("team"); }} />}
    {report && <DistributorReport location={report} locations={locations} stock={stock} officers={officers} products={products} onClose={() => setReport(null)} />}
  </>;
}
