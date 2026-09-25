import { useEffect, useMemo, useRef, useState } from "react";
import { supabase, errText, fetchAll, money, fmt, plural } from "../lib/supabase";
import { localDate } from "../lib/parse";
import { ChartConfig, ChartData, ChartKind, Ctx, KIND_SPECS, chartTitle, cleanCharts, defaultCharts, newChart } from "../lib/insights";
import { ChartView, ChartSize } from "../components/Charts";
import ChartEditor from "../components/ChartEditor";

interface Props { ctx: Ctx; userId: string; version: number; openKind: ChartKind | null; onOpened: () => void }

/** Loads a chart's data, keeping the last picture on screen while new numbers load. */
function useChartData(chart: ChartConfig, ctx: Ctx, version: number) {
  const [state, setState] = useState<{ data: ChartData | null; loading: boolean; error: string }>({ data: null, loading: true, error: "" });
  const { title: _t, focus: _f, labels: _l, ...shape } = chart;
  const key = JSON.stringify(shape);
  useEffect(() => {
    let live = true;
    setState(s => ({ ...s, loading: true }));
    KIND_SPECS[chart.kind].load(chart, ctx)
      .then(data => { if (live) setState({ data, loading: false, error: "" }); })
      .catch(e => { if (live) setState({ data: null, loading: false, error: errText(e) }); });
    return () => { live = false; };
  }, [key, version, ctx]);
  return state;
}

function hasData(d: ChartData | null) {
  if (!d) return false;
  return d.type === "bars" ? d.rows.length > 0 : d.values.some(s => s.some(Boolean));
}

function ChartBody({ chart, ctx, version, size }: { chart: ChartConfig; ctx: Ctx; version: number; size: ChartSize }) {
  const { data, loading, error } = useChartData(chart, ctx, version);
  const spec = KIND_SPECS[chart.kind];
  return <div className={`chartbody${loading && data ? " refreshing" : ""}`}>
    {data?.summary && <p className="summary">{data.summary}</p>}
    {error ? <p className="empty">Couldn't load this chart: {error}</p>
      : !data ? <p className="empty">Loading…</p>
      : hasData(data) ? <ChartView data={data} size={size} labels={chart.labels !== false} />
      : <p className="empty quiet">{spec.empty}</p>}
  </div>;
}

export default function Dashboard({ ctx, userId, version, openKind, onOpened }: Props) {
  const [charts, setCharts] = useState<ChartConfig[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [gallery, setGallery] = useState(false);
  const [saveError, setSaveError] = useState("");
  const saveTimer = useRef<number>();

  useEffect(() => {
    let live = true;
    (async () => {
      const { data } = await supabase!.from("user_settings").select("dashboard").eq("user_id", userId).maybeSingle();
      const saved = cleanCharts((data?.dashboard as { charts?: unknown } | null)?.charts);
      // Layouts saved before pinning existed move once to the new starting set: key charts pinned, the rest rotating.
      if (live) setCharts(saved.length && saved.some(c => c.pinned !== undefined) ? saved : defaultCharts());
    })();
    return () => { live = false; };
  }, [userId]);

  function save(next: ChartConfig[]) {
    setCharts(next);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const { error } = await supabase!.from("user_settings").upsert({ user_id: userId, dashboard: { version: 1, charts: next }, updated_at: new Date().toISOString() });
      setSaveError(error ? `Your dashboard changes couldn't be saved: ${error.message}` : "");
    }, 600);
  }

  // An alert asked for a chart: open it, adding it first if it isn't on the dashboard.
  useEffect(() => {
    if (!openKind || !charts) return;
    const found = charts.find(c => c.kind === openKind);
    if (found) setOpenId(found.id);
    else { const c = newChart(openKind); save([...charts, c]); setOpenId(c.id); }
    setEditing(false);
    onOpened();
  }, [openKind, charts]);

  function open(id: string) { setEditing(false); setOpenId(id); }
  function close() { setOpenId(null); setEditing(false); }

  // Pinned charts stay where they are; everything else takes turns in the rotating area.
  // Layouts saved before pinning existed keep all their charts pinned.
  const pinMode = !!charts?.some(c => c.pinned !== undefined);
  const pinned = !charts ? [] : pinMode ? charts.filter(c => c.pinned) : charts;
  const pool = useMemo(() => !charts ? [] : [...(pinMode ? charts.filter(c => !c.pinned) : []),
    ...(Object.keys(KIND_SPECS) as ChartKind[]).filter(k => !charts.some(c => c.kind === k)).map(k => ({ ...newChart(k), id: `rot-${k}` }))], [charts, pinMode]);
  const [turn, setTurn] = useState(0), [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused || openId || pool.length <= ROTATE) return;
    const t = window.setInterval(() => setTurn(x => x + 1), 20000);
    return () => window.clearInterval(t);
  }, [paused, openId, pool.length]);
  const rotating = pool.length <= ROTATE ? pool : [...Array(ROTATE)].map((_, i) => pool[(turn * ROTATE + i) % pool.length]);
  function togglePin(c: ChartConfig) {
    if (!charts) return;
    const base = pinMode ? charts : charts.map(x => ({ ...x, pinned: true }));
    if (base.some(x => x.id === c.id)) save(base.map(x => (x.id === c.id ? { ...x, pinned: !x.pinned } : x)));
    else save([...base, { ...c, id: newChart(c.kind).id, pinned: true }]);
  }

  if (!charts) return <p className="empty">Loading your dashboard…</p>;
  const focus = pinned.filter(c => c.focus), rest = pinned.filter(c => !c.focus);
  const openChart = charts.find(c => c.id === openId) || pool.find(c => c.id === openId) || null;
  const idx = openChart ? charts.indexOf(openChart) : -1;
  const update = (c: ChartConfig) => (charts.some(x => x.id === c.id) ? save(charts.map(x => (x.id === c.id ? c : x))) : (() => { const id = newChart(c.kind).id; save([...charts, { ...c, id, pinned: false }]); setOpenId(id); })());
  const move = (dir: -1 | 1) => {
    if (idx < 0) return;
    const next = [...charts], j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    save(next);
  };

  const card = (c: ChartConfig, size: ChartSize, wide = false) => <section key={c.id} className={`chartcard sz-${size}${wide ? " wide" : ""}`} tabIndex={0}
    aria-label={`${chartTitle(c)}. Press Enter to enlarge.`}
    onClick={() => open(c.id)}
    onKeyDown={e => { if (e.key === "Enter") open(c.id); }}>
    <header><h3>{chartTitle(c)}</h3><span className="cardtools">
      <button className={`pin${pinned.some(x => x.id === c.id) ? " on" : ""}`} title={pinned.some(x => x.id === c.id) ? "Unpin: let it rotate" : "Pin: keep it here"} aria-label={pinned.some(x => x.id === c.id) ? "Unpin chart" : "Pin chart"}
        onClick={e => { e.stopPropagation(); togglePin(c); }}>📌</button><span className="enlarge" aria-hidden>⤢</span></span></header>
    <p className="subtitle">{KIND_SPECS[c.kind].subtitle(c)}</p>
    <ChartBody chart={c} ctx={ctx} version={version} size={size} />
  </section>;

  return <>
    <div className="dashbar">
      <p className="hint">Click a chart to enlarge it and customise it. 📌 pins a chart so it stays in place; unpinned charts take turns below. Values update whenever new data is entered.</p>
      <div className="actions">
        <button className="secondary" onClick={() => setGallery(true)}>+ Add a chart</button>
        <button className="secondary" onClick={() => { if (confirm("Put back the ten starting charts? Your changes to charts are lost.")) save(defaultCharts()); }}>Reset charts</button>
      </div>
    </div>
    <Kpis ctx={ctx} version={version} />
    {saveError && <div className="status err">{saveError}</div>}
    {focus.length > 0 && <div className="focusgrid">{focus.map((c, i) => card(c, "focus", focus.length === 3 ? i === 0 : focus.length === 1))}</div>}
    {rest.length > 0 && <div className="chartgrid">{rest.map(c => card(c, "card"))}</div>}
    {rotating.length > 0 && <section className="rotating" onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)}>
      <div className="rowhead"><h2>More To Look At</h2><span className="muted">{paused ? "Paused while the mouse is here" : pool.length > ROTATE ? "Changes every 20 seconds" : ""}{pool.length > ROTATE && <> · <button className="link" onClick={() => setTurn(x => x + 1)}>Next Charts</button></>}</span></div>
      <div className="chartgrid">{rotating.map(c => card(c, "card"))}</div>
    </section>}
    {charts.length > 0 && <div className="dashend"><button className="secondary" onClick={() => setGallery(true)}>+ Add a chart</button></div>}
    {!charts.length && <p className="empty">No charts on your dashboard. <button className="link" onClick={() => setGallery(true)}>Add one</button>.</p>}

    {openChart && <Overlay chart={openChart} ctx={ctx} version={version} editing={editing} setEditing={setEditing} onClose={close}
      first={idx === 0} last={idx === charts.length - 1} onChange={update} onMove={move}
      onRemove={() => { if (confirm(`Remove "${chartTitle(openChart)}" from your dashboard?`)) { save(charts.filter(c => c.id !== openChart.id)); close(); } }} />}
    {gallery && <Gallery charts={charts} onClose={() => setGallery(false)}
      onAdd={kind => { const c = newChart(kind); save([...charts, c]); setGallery(false); setOpenId(c.id); setEditing(true); }} />}
  </>;
}

const ROTATE = 4;

// ---------- running totals ----------
interface Totals { dsrMonth: number; dsrDay: number; lastDay: string; working: number; reported: number; collected: number; billed: number; owed: number }
function Kpis({ ctx, version }: { ctx: Ctx; version: number }) {
  const [t, setT] = useState<Totals | null>(null);
  useEffect(() => {
    if (!supabase) return;
    const now = new Date(), month = localDate(new Date(now.getFullYear(), now.getMonth(), 1)), fy = localDate(new Date(now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1, 3, 1)), today = localDate(now);
    Promise.all([
      fetchAll<{ day: string; sale_value: number; attendance: string | null }>((a, b) => supabase!.from("dsr_days").select("day,sale_value,attendance").gte("day", month).lte("day", today).order("day").range(a, b)).catch(() => []),
      supabase.rpc("billing_summary", { p_from: fy, p_to: today }),
    ]).then(([d, b]) => {
      const lastDay = d.map(x => x.day).sort().pop() || "", onDay = d.filter(x => x.day === lastDay);
      const rows = ((b.data || []) as { party_type: string; billed: number; collected: number; billed_all: number; collected_all: number }[]).filter(r => r.party_type === "LOCATION");
      setT({ dsrMonth: d.reduce((a, x) => a + Number(x.sale_value), 0), dsrDay: onDay.reduce((a, x) => a + Number(x.sale_value), 0), lastDay,
        working: onDay.filter(x => ["Present", "Half Day", "Meeting"].includes(x.attendance || "")).length, reported: onDay.length,
        collected: rows.reduce((a, r) => a + Number(r.collected), 0), billed: rows.reduce((a, r) => a + Number(r.billed), 0), owed: rows.reduce((a, r) => a + Number(r.billed_all) - Number(r.collected_all), 0) });
    }).catch(() => setT(null));
  }, [version]);
  const stockValue = ctx.stock.reduce((a, s) => a + Number(s.stock_value || 0), 0);
  const day = t?.lastDay ? new Date(`${t.lastDay}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "";
  return <div className="kpis dashkpis">
    <div className="kpi"><small>Stock held (at SS rate)</small><b>{money(stockValue)}</b><span>{plural(new Set(ctx.stock.filter(s => Number(s.current_stock)).map(s => s.distributor_id)).size, "location")}</span></div>
    <div className="kpi"><small>Secondary this month</small><b>{money(t?.dsrMonth)}</b><span>from SO daily reports</span></div>
    <div className="kpi"><small>Latest day{day ? `, ${day}` : ""}</small><b>{money(t?.dsrDay)}</b><span>{t?.reported ? `${t.working} of ${plural(t.reported, "person", "people")} working` : "no reports yet"}</span></div>
    <div className="kpi"><small>Collected this year</small><b>{money(t?.collected)}</b><span>{t?.billed ? `${fmt((t.collected / t.billed) * 100)}% of ${money(t.billed)} billed` : "no bills yet"}</span></div>
    <div className={`kpi${t && t.owed > 0 && t.billed && t.collected / t.billed < 0.6 ? " bad" : ""}`}><small>Outstanding</small><b>{money(t?.owed)}</b><span>owed by super stockists and distributors</span></div>
  </div>;
}

// ---------- enlarged chart ----------
interface OverlayProps {
  chart: ChartConfig; ctx: Ctx; version: number; editing: boolean; setEditing: (v: boolean) => void; first: boolean; last: boolean;
  onClose: () => void; onChange: (c: ChartConfig) => void; onMove: (d: -1 | 1) => void; onRemove: () => void;
}
function Overlay({ chart, ctx, version, editing, setEditing, first, last, onClose, onChange, onMove, onRemove }: OverlayProps) {
  const closeBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeBtn.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", esc);
    document.body.classList.add("noscroll");
    return () => { document.removeEventListener("keydown", esc); document.body.classList.remove("noscroll"); };
  }, []);
  return <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={`overlaypanel${editing ? " editing" : ""}`} role="dialog" aria-modal="true" aria-label={chartTitle(chart)}>
      <header>
        <div><h2>{chartTitle(chart)}</h2><p className="subtitle">{KIND_SPECS[chart.kind].subtitle(chart)}</p></div>
        <div className="actions">
          <button className={editing ? "" : "secondary"} onClick={() => setEditing(!editing)}>{editing ? "Done" : "Customize"}</button>
          <button className="secondary" ref={closeBtn} aria-label="Close" onClick={onClose}>✕</button>
        </div>
      </header>
      <div className="overlaybody">
        <div className="overlaychart"><ChartBody chart={chart} ctx={ctx} version={version} size="large" /></div>
        {editing && <aside><ChartEditor chart={chart} ctx={ctx} first={first} last={last} onChange={onChange} onMove={onMove} onRemove={onRemove} /></aside>}
      </div>
    </div>
  </div>;
}

// ---------- choosing a chart to add ----------
function Gallery({ charts, onAdd, onClose }: { charts: ChartConfig[]; onAdd: (k: ChartKind) => void; onClose: () => void }) {
  const on = new Set(charts.map(c => c.kind));
  return <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="overlaypanel gallery" role="dialog" aria-modal="true" aria-label="Add a chart">
      <header><div><h2>Add a chart</h2><p className="subtitle">Pick what you want to keep an eye on. You can change its settings once it's added.</p></div>
        <div className="actions"><button className="secondary" aria-label="Close" onClick={onClose}>✕</button></div></header>
      <div className="gallerylist">{(Object.keys(KIND_SPECS) as ChartKind[]).map(k => <button key={k} className="galleryitem" onClick={() => onAdd(k)}>
        <b>{KIND_SPECS[k].name}</b><span>{KIND_SPECS[k].blurb}</span>{on.has(k) && <em className="tag">already on your dashboard</em>}</button>)}</div>
    </div>
  </div>;
}
