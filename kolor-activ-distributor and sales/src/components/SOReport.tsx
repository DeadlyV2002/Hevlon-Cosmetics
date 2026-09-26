import { useEffect, useMemo, useRef, useState } from "react";
import { supabase, Distributor, SalesOfficer, StockLine, fetchAll, fmt, money, plural, errText } from "../lib/supabase";
import { localDate } from "../lib/parse";
import { ChartData } from "../lib/insights";
import { ChartView } from "./Charts";
import Modal from "./Modal";
import { exportPng, printOnly, togglePresent } from "../lib/present";

interface Day { day: string; attendance: string | null; total_calls: number; productive_calls: number; sale_value: number; distributor_id: string | null; db_name: string | null; town: string | null; beat: string | null; remark: string | null }
interface Prod { product: string; category: string | null; qty: number; value: number }
const n = (x: unknown) => Number(x) || 0;
const WORK = new Set(["Present", "Half Day", "Meeting"]);
const mon = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
const dayLabel = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
const change = (a: number, b: number) => (!b ? (a ? "new" : "—") : `${a >= b ? "+" : "−"}${fmt(Math.abs(((a - b) / b) * 100))}%`);

/** One salesperson's report: a short summary, with the detail in sections that open on click. */
export default function SOReport({ so, officers, locations, stock, onClose, onTeam }: {
  so: SalesOfficer; officers: SalesOfficer[]; locations: Distributor[]; stock: StockLine[]; onClose: () => void; onTeam?: (id: string) => void;
}) {
  const [days, setDays] = useState<Day[] | null>(null), [prods, setProds] = useState<Prod[]>([]), [err, setErr] = useState("");
  const panel = useRef<HTMLDivElement>(null), charts = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!supabase) return;
    const now = new Date(), from = localDate(new Date(now.getFullYear(), now.getMonth() - 12, 1)), p90 = localDate(new Date(Date.now() - 89 * 864e5));
    Promise.all([
      fetchAll<Day>((a, b) => supabase!.from("dsr_days").select("day,attendance,total_calls,productive_calls,sale_value,distributor_id,db_name,town,beat,remark").eq("so_id", so.id).gte("day", from).order("day").range(a, b)),
      supabase.rpc("dsr_product_totals", { p_from: p90, p_to: localDate(now), p_sos: [so.id], p_state: null }),
    ]).then(([d, p]) => { setDays(d); setProds(((p.data || []) as Prod[]).sort((a, b) => n(b.value) - n(a.value))); }).catch(e => setErr(errText(e)));
  }, [so.id]);

  const boss = officers.find(o => o.id === so.manager_id), team = officers.filter(o => o.manager_id === so.id);
  const locName = (d: Day) => (d.distributor_id ? locations.find(l => l.id === d.distributor_id)?.name : d.db_name) || "—";
  const byMonth = useMemo(() => {
    const m = new Map<string, { value: number; calls: number; pc: number; worked: number; dbs: Set<string>; att: Record<string, number> }>();
    (days || []).forEach(d => {
      const k = d.day.slice(0, 7), e = m.get(k) || { value: 0, calls: 0, pc: 0, worked: 0, dbs: new Set<string>(), att: {} };
      e.value += n(d.sale_value); e.calls += n(d.total_calls); e.pc += n(d.productive_calls);
      if (WORK.has(d.attendance || "")) { e.worked += d.attendance === "Half Day" ? 0.5 : 1; const k2 = d.distributor_id || d.db_name; if (k2) e.dbs.add(k2); }
      e.att[d.attendance || "No Report"] = (e.att[d.attendance || "No Report"] || 0) + 1;
      m.set(k, e);
    });
    return m;
  }, [days]);
  const now = new Date(), thisM = localDate(now).slice(0, 7), lastM = localDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)).slice(0, 7);
  const yearAgo = localDate(new Date(now.getFullYear() - 1, now.getMonth(), 1)).slice(0, 7);
  const cur = byMonth.get(thisM), prev = byMonth.get(lastM), ya = byMonth.get(yearAgo);
  const months = [...Array(13)].map((_, i) => localDate(new Date(now.getFullYear(), now.getMonth() - 12 + i, 1)).slice(0, 7));
  const chart: ChartData = { type: "columns", unit: "money", summary: "", x: months.map(mon), series: [{ key: "v", name: "Secondary", slot: 1 }], values: [months.map(m => byMonth.get(m)?.value || 0)] };
  const dbs = useMemo(() => {
    const cut = localDate(new Date(Date.now() - 89 * 864e5)), m = new Map<string, { name: string; id: string | null; days: number; value: number; last: string }>();
    (days || []).filter(d => d.day >= cut && (d.distributor_id || d.db_name)).forEach(d => {
      const k = d.distributor_id || d.db_name!, e = m.get(k) || { name: locName(d), id: d.distributor_id, days: 0, value: 0, last: "" };
      e.days++; e.value += n(d.sale_value); if (d.day > e.last) e.last = d.day; m.set(k, e);
    });
    return [...m.values()].sort((a, b) => b.value - a.value);
  }, [days, locations]);
  const stockOf = (id: string | null) => (id ? stock.filter(s => s.distributor_id === id).reduce((a, s) => a + n(s.stock_value), 0) : 0);
  const last = days?.length ? days[days.length - 1] : undefined;
  const strike = (e?: { calls: number; pc: number }) => (e && e.calls ? `${fmt((e.pc / e.calls) * 100)}%` : "—");

  return <Modal wide panelRef={panel} onClose={onClose} className="report"
    title={<>{so.name} <small className="muted">{so.designation || "SO"}</small></>}
    subtitle={[so.zone || so.state, so.hq || so.region, boss && `reports to ${boss.name}`, so.phone].filter(Boolean).join(" · ")}
    actions={<span className="noprint actions">
      {onTeam && team.length > 0 && <button className="secondary" onClick={() => { onTeam(so.id); onClose(); }}>Show Their Team</button>}
      <button className="secondary" onClick={() => panel.current && togglePresent(panel.current)}>Present</button>
      <button className="secondary" onClick={() => panel.current && printOnly(panel.current)}>Print</button>
      <button className="secondary" disabled={!days} onClick={() => charts.current && exportPng(charts.current, `${so.name} report`, so.name).catch(e => setErr(errText(e)))}>Export Chart</button>
    </span>}>
    {err && <div className="status err">{err}</div>}
    {!days ? <p className="empty">Loading…</p> : <>
      <div className="kpis">
        <div className="kpi"><small>This month</small><b>{money(cur?.value)}</b><span>{change(cur?.value || 0, prev?.value || 0)} on last month · {change(cur?.value || 0, ya?.value || 0)} on a year ago</span></div>
        <div className="kpi"><small>Last month</small><b>{money(prev?.value)}</b><span>{prev ? `${fmt(prev.worked)} days worked` : "no reports"}</span></div>
        <div className="kpi"><small>Strike rate this month</small><b>{strike(cur)}</b><span>{cur ? `${fmt(cur.pc)} of ${plural(cur.calls, "call")}` : "no calls"}; last month {strike(prev)}</span></div>
        <div className="kpi"><small>Days worked this month</small><b>{fmt(cur?.worked || 0)}</b><span>{cur?.att.Leave ? `${plural(cur.att.Leave, "leave day")} · ` : ""}{cur?.att["No Report"] ? `${cur.att["No Report"]} not reported` : "all days reported"}</span></div>
        <div className="kpi"><small>Distributors this month</small><b>{cur?.dbs.size || 0}</b><span>{dbs.length} in the last 90 days</span></div>
        <div className="kpi"><small>Last report</small><b>{last ? dayLabel(last.day) : "—"}</b><span>{last ? `${last.attendance || ""}${last.distributor_id || last.db_name ? ` · ${locName(last)}` : ""}` : "none yet"}</span></div>
      </div>

      <details className="rsec"><summary>Month By Month</summary>
        <div ref={charts} className="rsecbody"><ChartView data={chart} size="card" />
          <div className="tablewrap"><table className="nice"><thead><tr><th>Month</th><th>Days Worked</th><th>Calls</th><th>Productive</th><th>PC %</th><th>Secondary</th><th>DBs</th></tr></thead>
            <tbody>{[...months].reverse().filter(m => byMonth.has(m)).map(m => { const e = byMonth.get(m)!; return <tr key={m}><td>{mon(m)}</td><td>{fmt(e.worked)}</td><td>{fmt(e.calls)}</td><td>{fmt(e.pc)}</td><td>{strike(e)}</td><td>{money(e.value)}</td><td>{e.dbs.size}</td></tr>; })}</tbody></table></div></div>
      </details>
      <details className="rsec"><summary>Attendance <small>{cur ? Object.entries(cur.att).map(([k, v]) => `${k} ${v}`).join(" · ") : ""}</small></summary>
        <div className="rsecbody tablewrap"><table className="nice"><thead><tr><th>Month</th>{["Present", "Half Day", "Meeting", "Leave", "Weekly Off", "Holiday", "Absent", "No Report"].map(k => <th key={k}>{k}</th>)}</tr></thead>
          <tbody>{[thisM, lastM].map(m => <tr key={m}><td>{mon(m)}</td>{["Present", "Half Day", "Meeting", "Leave", "Weekly Off", "Holiday", "Absent", "No Report"].map(k => <td key={k}>{byMonth.get(m)?.att[k] || ""}</td>)}</tr>)}</tbody></table></div>
      </details>
      <details className="rsec"><summary>Distributors Worked <small>{plural(dbs.length, "distributor")}, last 90 days</small></summary>
        <div className="rsecbody tablewrap scrolltable short"><table className="nice"><thead><tr><th>Distributor</th><th>Days</th><th>Secondary</th><th>Last Visit</th><th>Their Stock Now</th></tr></thead>
          <tbody>{dbs.map(d => <tr key={d.id || d.name}><td>{d.name}{!d.id && <small className="missing">not in distributor list</small>}</td><td>{d.days}</td><td>{money(d.value)}</td><td>{dayLabel(d.last)}</td><td>{d.id ? money(stockOf(d.id)) : "—"}</td></tr>)}</tbody></table></div>
      </details>
      <details className="rsec"><summary>Products Sold <small>{plural(prods.length, "product")}, last 90 days</small></summary>
        <div className="rsecbody tablewrap scrolltable short"><table className="nice"><thead><tr><th>Product</th><th>Category</th><th>Dozens</th><th>Value</th></tr></thead>
          <tbody>{prods.map(p => <tr key={p.product}><td>{p.product}</td><td>{p.category}</td><td>{fmt(p.qty, 1)}</td><td>{money(p.value)}</td></tr>)}</tbody></table></div>
      </details>
      <details className="rsec"><summary>Recent Days</summary>
        <div className="rsecbody tablewrap scrolltable short"><table className="nice"><thead><tr><th>Date</th><th>Attendance</th><th>DB</th><th>Town / Beat</th><th>Calls</th><th>PC</th><th>Secondary</th><th>Remark</th></tr></thead>
          <tbody>{[...days].reverse().slice(0, 31).map(d => <tr key={d.day}><td>{dayLabel(d.day)}</td><td>{d.attendance}</td><td>{locName(d)}</td><td className="wrap">{[d.town, d.beat].filter(Boolean).join(" · ")}</td>
            <td>{d.total_calls}</td><td>{d.productive_calls}</td><td>{money(d.sale_value)}</td><td className="wrap">{d.remark}</td></tr>)}</tbody></table></div>
      </details>
      {team.length > 0 && <details className="rsec"><summary>Their Team <small>{plural(team.length, "person", "people")}</small></summary>
        <div className="rsecbody"><p className="hint">{team.map(t => `${t.name} (${t.designation || "SO"}${t.hq ? `, ${t.hq}` : ""})`).join(", ")}</p></div></details>}
    </>}
  </Modal>;
}
