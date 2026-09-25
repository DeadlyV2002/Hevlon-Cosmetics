import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { supabase, Distributor, SalesOfficer, fetchAll, fmt, money, plural, errText } from "../lib/supabase";
import DateRange, { PRESETS, Range } from "../components/DateRange";
import { Select } from "../components/Select";
import { useColumnFilters, Col } from "../components/ColumnFilter";
import { readDsr, DsrBook } from "../lib/dsr";

interface Day { id: string; so_id: string; day: string; state: string | null; manager: string | null; hq: string | null; db_name: string | null; distributor_id: string | null; town: string | null; beat: string | null; remark: string | null; attendance: string | null; total_calls: number; productive_calls: number; sale_value: number }
interface Prod { product: string; category: string | null; qty: number; value: number }
interface Props { officers: SalesOfficer[]; locations: Distributor[]; canManage: boolean; onChanged: () => Promise<void>; notify: (m: string) => void }

const SHORT: Record<string, string> = { Present: "P", "Half Day": "½", Meeting: "M", Leave: "L", "Weekly Off": "WO", Holiday: "H", Absent: "A", "No Report": "–" };
const WORKING = new Set(["Present", "Half Day", "Meeting"]);
const n = (x: unknown) => Number(x) || 0;
const wd = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short" });
const pct = (a: number, b: number) => (b ? (a / b) * 100 : 0);

interface Sum { so: SalesOfficer | undefined; soId: string; hq: string; days: number; att: Record<string, number>; calls: number; pc: number; value: number; flag: string }

export default function SOReports({ officers, locations, canManage, onChanged, notify }: Props) {
  const [range, setRange] = useState<Range>(() => PRESETS.find(p => p.id === "month")!.range());
  const [soFilter, setSoFilter] = useState("");
  const [days, setDays] = useState<Day[]>([]), [prods, setProds] = useState<Prod[]>([]);
  const [err, setErr] = useState(""), [reload, setReload] = useState(0);
  const [book, setBook] = useState<(DsrBook & { file: string }) | null>(null), [busy, setBusy] = useState(""), [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const soName = useMemo(() => new Map(officers.map(o => [o.id, o])), [officers]);
  const locName = useMemo(() => new Map(locations.map(l => [l.id, l.name])), [locations]);

  useEffect(() => {
    if (!supabase) return;
    Promise.all([
      fetchAll<Day>((a, b) => { let q = supabase!.from("dsr_days").select("*").gte("day", range.from).lte("day", range.to); if (soFilter) q = q.eq("so_id", soFilter); return q.order("day").order("id").range(a, b); }),
      supabase.rpc("dsr_product_totals", { p_from: range.from, p_to: range.to, p_so: soFilter || null }),
    ]).then(([d, p]) => { setDays(d); setProds(((p.data || []) as Prod[]).sort((a, b) => n(b.value) - n(a.value))); setErr(""); })
      .catch(e => setErr(`Couldn't load SO reports: ${errText(e)}. Run the latest database step (009) in Supabase.`));
  }, [range.from, range.to, soFilter, reload]);

  // ---------- upload ----------
  async function read(file: File) {
    setMsg(null);
    try {
      const b = readDsr(XLSX.read(await file.arrayBuffer(), { cellDates: false }));
      if (!b.days.length) throw new Error("No SO sheets with daily rows were found. Each SO sheet needs headings such as Name SO, Total Call and Month/Date.");
      setBook({ ...b, file: file.name });
    } catch (e) { setMsg({ kind: "err", text: `Couldn't read ${file.name}: ${errText(e)}` }); }
  }
  async function post() {
    if (!supabase || !book) return;
    setBusy("post");
    let done = 0, lines = 0, newSos = 0;
    try {
      for (let i = 0; i < book.days.length; i += 300) {
        const chunk = book.days.slice(i, i + 300).map(({ sheet: _s, ...d }) => d);
        const { data, error } = await supabase.rpc("post_dsr", { p_days: chunk, p_products: i === 0 ? book.products : [], p_source: book.file });
        if (error) throw error;
        const r = data as { days: number; lines: number; new_sos: number };
        done += r.days; lines += r.lines; newSos += r.new_sos;
        setMsg({ kind: "ok", text: `Saving… ${fmt(done)} of ${fmt(book.days.length)} SO-days` });
      }
      const text = `Saved ${plural(done, "SO-day")} and ${plural(lines, "product line")} from ${book.file}${newSos ? `, and added ${plural(newSos, "new SO")}` : ""}. Days already uploaded were replaced with this sheet's figures.`;
      setMsg({ kind: "ok", text }); notify(text); setBook(null); setReload(x => x + 1);
      if (newSos) await onChanged();
    } catch (e) { setMsg({ kind: "err", text: `Stopped after ${plural(done, "SO-day")}: ${errText(e)}` }); }
    finally { setBusy(""); }
  }

  // ---------- summary per SO ----------
  const sums = useMemo<Sum[]>(() => {
    const m = new Map<string, Sum>();
    days.forEach(d => {
      const s = m.get(d.so_id) || { so: soName.get(d.so_id), soId: d.so_id, hq: d.hq || "", days: 0, att: {}, calls: 0, pc: 0, value: 0, flag: "" };
      s.days++; const a = d.attendance || "No Report"; s.att[a] = (s.att[a] || 0) + 1;
      s.calls += n(d.total_calls); s.pc += n(d.productive_calls); s.value += n(d.sale_value); if (d.hq) s.hq = d.hq;
      m.set(d.so_id, s);
    });
    const noCalls = new Map<string, number>();
    days.forEach(d => { if (d.attendance === "Present" && !n(d.total_calls) && !n(d.sale_value)) noCalls.set(d.so_id, (noCalls.get(d.so_id) || 0) + 1); });
    const all = [...m.values()], team = pct(all.reduce((x, s) => x + s.pc, 0), all.reduce((x, s) => x + s.calls, 0));
    return all.map(s => {
      const f: string[] = [], strike = pct(s.pc, s.calls);
      // Strike rate is judged against the team: well under the team average is flagged.
      if (s.calls >= 20 && strike < team * 0.8) f.push(`Strike rate ${fmt(strike)}% vs team ${fmt(team)}%`);
      if (noCalls.get(s.soId)) f.push(`${plural(noCalls.get(s.soId)!, "working day")} with no calls`);
      if (s.att["No Report"]) f.push(`${plural(s.att["No Report"], "day")} not reported`);
      if (s.att.Absent) f.push(`${plural(s.att.Absent, "day")} absent`);
      return { ...s, flag: f.join("; ") };
    });
  }, [days, soName]);
  const working = (s: Sum) => ["Present", "Half Day", "Meeting"].reduce((a, k) => a + (s.att[k] || 0), 0);
  const scols: Col<Sum>[] = [
    { key: "so", label: "SO", value: s => s.so?.name || "Unknown SO" }, { key: "hq", label: "HQ", value: s => s.hq },
    { key: "present", label: "Present", value: s => (s.att.Present || 0) + (s.att["Half Day"] || 0) / 2, num: true },
    { key: "meet", label: "Meetings", value: s => s.att.Meeting || 0, num: true }, { key: "leave", label: "Leave", value: s => s.att.Leave || 0, num: true },
    { key: "off", label: "Off / Holiday", value: s => (s.att["Weekly Off"] || 0) + (s.att.Holiday || 0), num: true },
    { key: "nr", label: "Absent / No Report", value: s => (s.att.Absent || 0) + (s.att["No Report"] || 0), num: true },
    { key: "calls", label: "Total Calls", value: s => s.calls, num: true }, { key: "pc", label: "Productive Calls", value: s => s.pc, num: true },
    { key: "strike", label: "PC %", value: s => Math.round(pct(s.pc, s.calls)), num: true }, { key: "value", label: "Secondary ₹", value: s => Math.round(s.value), num: true },
    { key: "perpc", label: "₹ Per Productive Call", value: s => (s.pc ? Math.round(s.value / s.pc) : 0), num: true },
    { key: "perday", label: "₹ Per Working Day", value: s => (working(s) ? Math.round(s.value / working(s)) : 0), num: true }, { key: "flag", label: "Flag", value: s => s.flag },
  ];
  const st = useColumnFilters(sums, scols);

  // ---------- daily log ----------
  const dcols: Col<Day>[] = [
    { key: "day", label: "Date", value: d => d.day }, { key: "wd", label: "Day", value: d => wd(d.day) }, { key: "so", label: "SO", value: d => soName.get(d.so_id)?.name },
    { key: "att", label: "Attendance", value: d => d.attendance }, { key: "db", label: "DB Name", value: d => (d.distributor_id ? locName.get(d.distributor_id) : d.db_name) },
    { key: "town", label: "Town", value: d => d.town }, { key: "beat", label: "Beat", value: d => d.beat }, { key: "remark", label: "Remark", value: d => d.remark },
    { key: "calls", label: "Total Calls", value: d => n(d.total_calls), num: true }, { key: "pc", label: "Productive Calls", value: d => n(d.productive_calls), num: true },
    { key: "strike", label: "PC %", value: d => Math.round(pct(n(d.productive_calls), n(d.total_calls))), num: true }, { key: "value", label: "Secondary ₹", value: d => Math.round(n(d.sale_value)), num: true },
  ];
  const dt = useColumnFilters(days, dcols);
  const pcols: Col<Prod>[] = [{ key: "product", label: "Product", value: p => p.product }, { key: "category", label: "Category", value: p => p.category },
    { key: "qty", label: "Dozens", value: p => Math.round(n(p.qty) * 10) / 10, num: true }, { key: "value", label: "Value ₹", value: p => Math.round(n(p.value)), num: true }];
  const pt = useColumnFilters(prods, pcols);

  // Attendance grid: one row per SO, one column per day (up to 62 days).
  const dates = useMemo(() => {
    const out: string[] = [], d = new Date(`${range.from}T00:00:00`), end = new Date(`${range.to}T00:00:00`);
    while (d <= end && out.length < 62) { out.push(new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)); d.setDate(d.getDate() + 1); }
    return out;
  }, [range.from, range.to]);
  const grid = useMemo(() => { const m = new Map<string, string>(); days.forEach(d => m.set(`${d.so_id}|${d.day}`, d.attendance || "No Report")); return m; }, [days]);

  function exportAll() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(st.rows.map(s => Object.fromEntries(scols.map(c => [c.label, c.value(s) ?? ""])))), "SO summary");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dt.rows.map(d => Object.fromEntries(dcols.map(c => [c.label, c.value(d) ?? ""])))), "Daily log");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(soFilterRows()), "Attendance");
    XLSX.writeFile(wb, `so-reports-${range.from}-to-${range.to}.xlsx`);
  }
  function soFilterRows() { return sums.map(s => ({ SO: s.so?.name || "", ...Object.fromEntries(dates.map(d => [d.slice(5), SHORT[grid.get(`${s.soId}|${d}`) || ""] || ""])) })); }
  const tot = st.rows.reduce((a, s) => ({ calls: a.calls + s.calls, pc: a.pc + s.pc, value: a.value + s.value }), { calls: 0, pc: 0, value: 0 });

  return <>
    <section className="card upload">
      <div className="rowhead"><h2>Upload Daily Sales Report</h2>
        <label className="button secondary">Choose DSR Workbook<input hidden type="file" accept=".xlsx,.xlsm,.xls" onChange={e => { const x = e.target.files?.[0]; if (x) read(x); e.target.value = ""; }} /></label></div>
      <p className="hint">Upload the whole DSR workbook each day. Every SO sheet is read (the state total, analysis and chart sheets are skipped); days already uploaded are replaced with the new figures. Attendance comes from an Attendance column if the sheet has one, otherwise from the remark (Leave, Weekly Off, Holiday, Meeting) and the calls made.</p>
      {book && <div className="fixbox">
        <b>{book.file}</b>: {plural(book.days.length, "SO-day")} from {plural(book.sheets.length, "SO sheet")} ({book.days[0]?.day} to {book.days.map(d => d.day).sort().pop()}), {plural(book.products.length, "product")} with SS rates per dozen, secondary sales {money(book.days.reduce((a, d) => a + d.sale_value, 0))}.
        {book.skipped.length > 0 && <small className="muted"> Skipped sheets: {book.skipped.join(", ")}.</small>}
        <div className="actions"><button className="secondary" onClick={() => setBook(null)}>Cancel</button><button disabled={busy === "post"} onClick={post}>{busy === "post" ? "Saving…" : "Save To App"}</button></div>
      </div>}
      <div className="reserve">{msg && <div className={`status ${msg.kind}`}>{msg.text}</div>}</div>
    </section>

    <section className="card">
      <div className="rowhead"><h2>SO Performance</h2>
        <div className="actions"><DateRange value={range} onChange={setRange} />
          <Select value={soFilter} onChange={e => setSoFilter(e.target.value)} aria-label="Sales officer"><option value="">All SOs</option>{officers.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</Select>
          <button className="secondary" onClick={exportAll} disabled={!days.length}>Export To Excel</button></div></div>
      {err && <div className="status err">{err}</div>}
      <div className="cards">
        <div className="metric"><small>Secondary sales</small><b>{money(tot.value)}</b></div>
        <div className="metric"><small>Total calls</small><b>{fmt(tot.calls)}</b></div>
        <div className="metric"><small>Productive calls</small><b>{fmt(tot.pc)}</b></div>
        <div className="metric"><small>Strike rate (PC %)</small><b>{tot.calls ? `${fmt(pct(tot.pc, tot.calls))}%` : "—"}</b></div>
      </div>
      {sums.length ? <div className="tablewrap"><table><thead><tr>{scols.map(c => st.head(c.key))}</tr></thead>
        <tbody>{st.rows.map(s => <tr key={s.soId} className={s.flag ? "flagged" : ""}>{scols.map(c => <td key={c.key} className={c.key === "flag" ? "wrap" : ""}>
          {c.key === "flag" ? s.flag && <span className="err">{s.flag}</span> : c.key === "value" || c.key === "perpc" || c.key === "perday" ? money(c.value(s)) : c.key === "strike" ? `${c.value(s)}%` : c.value(s)}</td>)}</tr>)}</tbody></table></div>
        : <p className="empty">No SO reports in this period. Upload the DSR workbook above.</p>}
    </section>

    {sums.length > 0 && <section className="card">
      <h2>Attendance</h2>
      <div className="legend attlegend">{Object.entries(SHORT).map(([k, v]) => <span key={k}><i className={`att a-${v === "½" ? "half" : v === "–" ? "none" : v}`}>{v}</i>{k}</span>)}</div>
      <div className="tablewrap"><table className="attgrid"><thead><tr><th>SO</th>{dates.map(d => <th key={d} title={d}>{Number(d.slice(8))}<small>{wd(d).slice(0, 2)}</small></th>)}<th>Working days</th></tr></thead>
        <tbody>{sums.map(s => <tr key={s.soId}><td>{s.so?.name}</td>{dates.map(d => { const a = grid.get(`${s.soId}|${d}`); const v = a ? SHORT[a] || "?" : "";
          return <td key={d} title={`${d}: ${a || "no row"}`}>{v && <i className={`att a-${v === "½" ? "half" : v === "–" ? "none" : v}`}>{v}</i>}</td>; })}<td><b>{working(s)}</b></td></tr>)}</tbody></table></div>
    </section>}

    {days.length > 0 && <section className="card">
      <div className="rowhead"><h2>Daily Log ({dt.rows.length})</h2>{dt.active > 0 && <button className="link" onClick={dt.clear}>Clear Filters</button>}</div>
      <div className="tablewrap"><table><thead><tr>{dcols.map(c => dt.head(c.key))}</tr></thead>
        <tbody>{dt.rows.slice(0, 1500).map(d => <tr key={d.id} className={WORKING.has(d.attendance || "") ? "" : "muted"}>{dcols.map(c => <td key={c.key} className={c.key === "remark" || c.key === "beat" ? "wrap" : ""}>
          {c.key === "att" ? <i className={`att a-${(SHORT[d.attendance || ""] || "none").replace("½", "half").replace("–", "none")}`}>{d.attendance}</i> : c.key === "value" ? money(c.value(d)) : c.key === "strike" ? (n(d.total_calls) ? `${c.value(d)}%` : "") : c.value(d)}</td>)}</tr>)}</tbody></table>
        {dt.rows.length > 1500 && <p className="hint">Showing 1,500 of {dt.rows.length}. Export to Excel for all of them.</p>}</div>
    </section>}

    {prods.length > 0 && <section className="card">
      <h2>Products Sold By SOs</h2>
      <div className="tablewrap"><table><thead><tr>{pcols.map(c => pt.head(c.key))}</tr></thead>
        <tbody>{pt.rows.map(p => <tr key={p.product}><td>{p.product}</td><td>{p.category}</td><td>{fmt(p.qty, 1)}</td><td>{money(p.value)}</td></tr>)}</tbody></table></div>
    </section>}
    {!canManage && null}
  </>;
}
