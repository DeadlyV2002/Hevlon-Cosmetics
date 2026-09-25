import { useEffect, useRef, useState } from "react";
import { supabase, errText } from "../lib/supabase";
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
  const hoverTimer = useRef<number>();
  const quietFrom = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const { data } = await supabase!.from("user_settings").select("dashboard").eq("user_id", userId).maybeSingle();
      const saved = cleanCharts((data?.dashboard as { charts?: unknown } | null)?.charts);
      if (live) setCharts(saved.length ? saved : defaultCharts());
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

  function open(id: string) { window.clearTimeout(hoverTimer.current); hoverTimer.current = undefined; setEditing(false); setOpenId(id); }
  function close(at: { x: number; y: number } | null) { quietFrom.current = at; setOpenId(null); setEditing(false); }
  /** Resting the mouse on a chart for half a second enlarges it. Just after one closes, the mouse has to move away first. */
  function hover(id: string, e: React.PointerEvent) {
    if (e.pointerType !== "mouse" || openId || hoverTimer.current) return;
    if (quietFrom.current) {
      if (Math.hypot(e.clientX - quietFrom.current.x, e.clientY - quietFrom.current.y) < 80) return;
      quietFrom.current = null;
    }
    hoverTimer.current = window.setTimeout(() => open(id), 500);
  }
  function unhover() { window.clearTimeout(hoverTimer.current); hoverTimer.current = undefined; }

  if (!charts) return <p className="empty">Loading your dashboard…</p>;
  const focus = charts.filter(c => c.focus), rest = charts.filter(c => !c.focus);
  const openChart = charts.find(c => c.id === openId) || null;
  const idx = openChart ? charts.indexOf(openChart) : -1;
  const update = (c: ChartConfig) => save(charts.map(x => (x.id === c.id ? c : x)));
  const move = (dir: -1 | 1) => {
    if (idx < 0) return;
    const next = [...charts], j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    save(next);
  };

  const card = (c: ChartConfig, size: ChartSize, wide = false) => <section key={c.id} className={`chartcard sz-${size}${wide ? " wide" : ""}`} tabIndex={0}
    aria-label={`${chartTitle(c)}. Press Enter to enlarge.`}
    onPointerMove={e => hover(c.id, e)} onPointerLeave={unhover} onClick={() => open(c.id)}
    onKeyDown={e => { if (e.key === "Enter") open(c.id); }}>
    <header><h3>{chartTitle(c)}</h3><span className="enlarge" aria-hidden>⤢</span></header>
    <p className="subtitle">{KIND_SPECS[c.kind].subtitle(c)}</p>
    <ChartBody chart={c} ctx={ctx} version={version} size={size} />
  </section>;

  return <>
    <div className="dashbar">
      <p className="hint">Rest the mouse on a chart to enlarge it; move it off into the space around to shrink it back. Enlarged charts have a <b>Customize</b> button.</p>
      <div className="actions">
        <button className="secondary" onClick={() => setGallery(true)}>+ Add a chart</button>
        <button className="secondary" onClick={() => { if (confirm("Put back the ten starting charts? Your changes to charts are lost.")) save(defaultCharts()); }}>Reset charts</button>
      </div>
    </div>
    {saveError && <div className="status err">{saveError}</div>}
    {focus.length > 0 && <div className="focusgrid">{focus.map((c, i) => card(c, "focus", focus.length === 3 ? i === 0 : focus.length === 1))}</div>}
    {rest.length > 0 && <div className="chartgrid">{rest.map(c => card(c, "card"))}</div>}
    {!charts.length && <p className="empty">No charts on your dashboard. <button className="link" onClick={() => setGallery(true)}>Add one</button>.</p>}

    {openChart && <Overlay chart={openChart} ctx={ctx} version={version} editing={editing} setEditing={setEditing} onClose={close}
      first={idx === 0} last={idx === charts.length - 1} onChange={update} onMove={move}
      onRemove={() => { if (confirm(`Remove "${chartTitle(openChart)}" from your dashboard?`)) { save(charts.filter(c => c.id !== openChart.id)); close(null); } }} />}
    {gallery && <Gallery charts={charts} onClose={() => setGallery(false)}
      onAdd={kind => { const c = newChart(kind); save([...charts, c]); setGallery(false); setOpenId(c.id); setEditing(true); }} />}
  </>;
}

// ---------- enlarged chart ----------
interface OverlayProps {
  chart: ChartConfig; ctx: Ctx; version: number; editing: boolean; setEditing: (v: boolean) => void; first: boolean; last: boolean;
  onClose: (at: { x: number; y: number } | null) => void; onChange: (c: ChartConfig) => void; onMove: (d: -1 | 1) => void; onRemove: () => void;
}
function Overlay({ chart, ctx, version, editing, setEditing, first, last, onClose, onChange, onMove, onRemove }: OverlayProps) {
  const panel = useRef<HTMLDivElement>(null);
  const armed = useRef(false);
  const closeTimer = useRef<number>();
  const closeBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeBtn.current?.focus();
    const t = window.setTimeout(() => (armed.current = true), 700);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(null); };
    document.addEventListener("keydown", esc);
    document.body.classList.add("noscroll");
    return () => { window.clearTimeout(t); window.clearTimeout(closeTimer.current); document.removeEventListener("keydown", esc); document.body.classList.remove("noscroll"); };
  }, []);
  function onMoveBackdrop(e: React.PointerEvent) {
    const inside = panel.current?.contains(e.target as Node);
    if (inside) { armed.current = true; window.clearTimeout(closeTimer.current); closeTimer.current = undefined; return; }
    if (e.pointerType !== "mouse" || editing || !armed.current || closeTimer.current) return;
    const at = { x: e.clientX, y: e.clientY };
    closeTimer.current = window.setTimeout(() => onClose(at), 160);
  }
  return <div className="overlay" onPointerMove={onMoveBackdrop} onClick={e => { if (!panel.current?.contains(e.target as Node)) onClose(null); }}>
    <div className={`overlaypanel${editing ? " editing" : ""}`} ref={panel} role="dialog" aria-modal="true" aria-label={chartTitle(chart)}>
      <header>
        <div><h2>{chartTitle(chart)}</h2><p className="subtitle">{KIND_SPECS[chart.kind].subtitle(chart)}</p></div>
        <div className="actions">
          <button className={editing ? "" : "secondary"} onClick={() => setEditing(!editing)}>{editing ? "Done" : "Customize"}</button>
          <button className="secondary" ref={closeBtn} aria-label="Close" onClick={() => onClose(null)}>✕</button>
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
