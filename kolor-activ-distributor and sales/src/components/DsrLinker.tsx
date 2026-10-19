import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Distributor, SalesOfficer, StockLine, money, plural, errText, fmt } from "../lib/supabase";
import { normName } from "../lib/parse";
import { similarity } from "../lib/fuzzy";
import { dmy } from "../lib/dates";
import { DbName, LinkedName, loadUnlinked, suggest, linkNames, sameState, suspectLinks, unlinkName, nameScore } from "../lib/dsrLink";
import { runTask, startTask } from "../lib/tasks";
import { Select } from "./Select";

const PAGE = 40;
/** Suggestions this close are ticked already; weaker ones are offered but left for you to accept. */
export const SURE = 0.95;

/** DSR "DB Name" spellings that don't match a distributor: suggests the closest one to link. */
export default function DsrLinker({ locations, officers = [], stock = [], canManage, onLinked, notify }: { locations: Distributor[]; officers?: SalesOfficer[]; stock?: StockLine[]; canManage: boolean; onLinked: () => void; notify: (m: string) => void }) {
  const [open, setOpen] = useState(""), wrap = useRef<HTMLDivElement>(null);
  const [names, setNames] = useState<DbName[] | null>(null), [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [reload, setReload] = useState(0), [shown, setShown] = useState(PAGE), [q, setQ] = useState("");
  useEffect(() => {
    let live = true;
    const task = startTask("Matching DSR DB names to distributors", 0, true);
    loadUnlinked().then(list => suggest(list, locations, task)).then(list => {
      if (!live) return;
      setNames(list); setPick(Object.fromEntries(list.filter(n => n.guess && n.score >= SURE).map(n => [n.name, n.guess!.id])));
      task.ok(list.length ? `${plural(list.length, "name")} to link, ${list.filter(n => n.guess).length} with a suggestion.` : "Every DB name is linked.");
    }).catch(e => { if (!live) return; task.fail(errText(e)); setNames([]); });
    return () => { live = false; task.cancel(); };
  }, [reload, locations]);
  const dists = useMemo(() => locations.filter(l => l.kind !== "GODOWN"), [locations]);
  // Options per state, built once rather than for every row.
  const optionsFor = useMemo(() => {
    const cache = new Map<string, JSX.Element[]>();
    return (state: string) => {
      if (!cache.has(state)) cache.set(state, dists.filter(d => sameState(state, d.state)).map(d => <option key={d.id} value={d.id}>{d.name}{d.territory ? ` · ${d.territory}` : ""}</option>));
      return cache.get(state)!;
    };
  }, [dists]);

  async function link() {
    const map = Object.entries(pick).filter(([, id]) => id).map(([db_name, distributor_id]) => ({ db_name, distributor_id }));
    if (!map.length) return;
    setBusy(true);
    try {
      const r = await runTask("Linking DSR DB names", t => linkNames(map, t), map.length, r => `Linked ${plural(r.names, "name")} (${plural(r.days, "SO day")}).`);
      notify(`Linked ${plural(r.names, "DB name")} (${plural(r.days, "SO day")}). Their spellings are saved, so future DSRs match by themselves.`);
      onLinked();
    } catch (e) { notify(`Not linked: ${errText(e)}`); }
    finally { setBusy(false); }
  }
  const byId = useMemo(() => new Map(locations.map(l => [l.id, l])), [locations]);
  const soById = useMemo(() => new Map(officers.map(o => [o.id, o])), [officers]);
  const stockOf = useMemo(() => { const m = new Map<string, number>(); stock.forEach(x => m.set(x.distributor_id, (m.get(x.distributor_id) || 0) + Number(x.stock_value || 0))); return m; }, [stock]);
  /** A distributor's details: town, its super stockist (who sends it stock), its SO, stock now. */
  const card = (d: Distributor, why: string, n: DbName) => {
    const ss = d.parent_id ? byId.get(d.parent_id) : undefined, via = d.via_id ? byId.get(d.via_id) : undefined, so = d.so_id ? soById.get(d.so_id) : undefined;
    const sameSo = !!so && n.sos.has(so.id), sameTown = !!d.territory && [...n.towns].some(t => similarity(t, d.territory!) >= 0.8);
    return <div key={d.id} className={`linkcand${pick[n.name] === d.id ? " on" : ""}`}>
      <div className="rowhead"><b>{d.name} <small className="muted">{d.code}</small></b>
        {canManage && (pick[n.name] === d.id ? <span className="ok">Chosen</span> : <button className="secondary small" onClick={() => setPick(p => ({ ...p, [n.name]: d.id }))}>Link To This</button>)}</div>
      <small className="muted">{why}</small>
      <dl className="facts">
        <dt>Kind</dt><dd>{d.kind === "SUPER_STOCKIST" ? "Super stockist" : "Distributor"}{d.status === "DORMANT" ? " (dormant)" : ""}</dd>
        <dt>Town</dt><dd className={sameTown ? "ok" : ""}>{[d.territory, d.region, d.state].filter(Boolean).join(", ") || "—"}{sameTown ? " ✓ same town" : ""}</dd>
        <dt>Stock from</dt><dd>{d.direct ? "The company directly" : ss ? `${ss.name}${ss.territory ? `, ${ss.territory}` : ""}` : "—"}{via ? ` (goods via ${via.name})` : ""}</dd>
        <dt>SO</dt><dd className={sameSo ? "ok" : ""}>{so ? `${so.name}${so.designation ? ` (${so.designation})` : ""}` : "Not set"}{sameSo ? " ✓ books this DSR name" : ""}</dd>
        <dt>Owner</dt><dd>{[d.owner_name, d.phone].filter(Boolean).join(" · ") || "—"}</dd>
        <dt>Stock now</dt><dd>{stockOf.has(d.id) ? money(stockOf.get(d.id)) : "No stock recorded"}</dd>
        {(d.aliases || []).length > 0 && <><dt>Other names</dt><dd>{d.aliases.slice(0, 6).join(", ")}{d.aliases.length > 6 ? "…" : ""}</dd></>}
      </dl>
    </div>;
  };
  /** Who a DSR name could be: the suggestion, the pick, distributors of the SOs who book there, and ones in its towns. */
  const candidates = (n: DbName) => {
    const out = new Map<string, { d: Distributor; why: string[] }>();
    const add = (d: Distributor | undefined, why: string) => { if (!d || d.kind === "GODOWN") return; const e = out.get(d.id) || { d, why: [] }; if (!e.why.includes(why)) e.why.push(why); out.set(d.id, e); };
    if (pick[n.name]) add(byId.get(pick[n.name]), "your choice");
    if (n.guess) add(n.guess, n.score >= SURE ? "close name match" : "similar name");
    const towns = [...n.towns];
    dists.filter(d => sameState(n.state, d.state)).forEach(d => {
      if (d.so_id && n.sos.has(d.so_id)) add(d, `${soById.get(d.so_id)?.name || "the SO"}'s distributor`);
      if (d.territory && towns.some(t => similarity(t, d.territory!) >= 0.8)) add(d, "in the same town");
      // Only the distinctive words count: "Sai Sradha Enterprise" isn't like every "… Enterprises".
      if (nameScore(n.name, d) >= 0.6) add(d, "similar name");
    });
    // Strongest first: the more reasons, and a closer name, the higher.
    return [...out.values()].map(e => ({ ...e, rank: e.why.length + nameScore(n.name, e.d) + (e.why.includes("your choice") ? 5 : 0) })).sort((a, b) => b.rank - a.rank).slice(0, 6);
  };
  const once = (list: Iterable<string>) => { const seen = new Map<string, string>(); for (const x of list) { const k = normName(x); if (k && !seen.has(k)) seen.set(k, x.trim()); } return [...seen.values()]; };
  const details = (n: DbName) => {
    const people = [...n.sos].sort((a, b) => b[1] - a[1]).map(([id, days]) => { const o = soById.get(id); return `${o?.name || "Unknown"}${o?.designation ? ` (${o.designation})` : ""}: ${plural(days, "day")}`; });
    const cands = candidates(n);
    return <div className="linkinfo" style={{ width: wrap.current ? wrap.current.clientWidth - 24 : undefined }}>
      <div className="linkfacts"><h4>What the DSRs say about "{n.name}"</h4>
        <dl className="facts">
          <dt>Booked by</dt><dd>{people.join("; ") || "—"}</dd>
          <dt>State</dt><dd>{n.state || "—"}</dd>
          <dt>Towns</dt><dd>{once(n.towns).join(", ") || "—"}</dd>
          <dt>Beats</dt><dd>{once(n.beats).slice(0, 12).join(", ") || "—"}{once(n.beats).length > 12 ? "…" : ""}</dd>
          <dt>HQ</dt><dd>{once(n.hqs).join(", ") || "—"}</dd>
          <dt>Days</dt><dd>{fmt(n.days)}, {dmy(n.first)} to {dmy(n.last)}</dd>
          <dt>Booked</dt><dd>{money(n.value)}</dd>
        </dl></div>
      <div className="linkcands"><h4>{cands.length ? "Could be" : "No likely distributor in this state"}</h4>
        {cands.map(c => card(c.d, c.why.join(" · "), n))}
        {!cands.length && <p className="muted">Nobody with a similar name, in the same town, or served by the same SO. It may be a new distributor: add it on the Distributors page, then link it here.</p>}</div>
    </div>;
  };
  if (!names) return <section className="card"><p className="empty">Matching DSR DB names to your distributors…</p></section>;
  if (!names.length) return <p className="hint">Every DB name in the DSRs is linked to a distributor.</p>;
  const chosen = Object.values(pick).filter(Boolean).length;
  const t = q.trim().toLowerCase(), list = t ? names.filter(n => `${n.name} ${n.state} ${[...n.towns].join(" ")}`.toLowerCase().includes(t)) : names;
  return <section className="card">
    <div className="rowhead"><h2>Link DSR DB Names To Distributors</h2>
      {canManage && <button disabled={busy || !chosen} onClick={link}>{busy ? "Linking…" : `Link ${plural(chosen, "Name")}`}</button>}</div>
    <p className="hint">{plural(names.length, "DB name")} in the SO reports {names.length === 1 ? "isn't" : "aren't"} linked to your distributor list, so {names.length === 1 ? "its" : "their"} bookings can't be checked against stock. Close matches in the same state are already chosen ({names.filter(n => n.guess && n.score >= SURE).length}); {names.filter(n => n.guess && n.score < SURE).length} weaker suggestions are offered for you to accept. Click a name to see who booked there, its towns and beats, and the distributors it could be with their SO and super stockist. Check each choice, then link.</p>
    <input className="search" placeholder="Search a DB name, state or town…" value={q} onChange={e => { setQ(e.target.value); setShown(PAGE); }} />
    <div className="tablewrap scrolltable" ref={wrap}><table className="nice"><thead><tr><th>Name In DSR</th><th>State</th><th>Towns</th><th>Days</th><th>Booked</th><th>Link To</th><th>Suggestion</th></tr></thead>
      <tbody>{list.slice(0, shown).map(n => <Fragment key={n.name}><tr className={`${pick[n.name] ? "" : "muted"}${open === n.name ? " openrow" : ""}`}>
        <td><button className="link strong" aria-expanded={open === n.name} onClick={() => setOpen(open === n.name ? "" : n.name)}>{open === n.name ? "▾" : "▸"} {n.name}</button><br /><small className="muted">{[...n.sos.keys()].map(id => soById.get(id)?.name).filter(Boolean).slice(0, 2).join(", ")}</small></td><td>{n.state}</td><td className="wrap">{[...n.towns].slice(0, 3).join(", ")}</td><td>{n.days}</td><td>{money(n.value)}</td>
        <td><Select value={pick[n.name] || ""} disabled={!canManage} onChange={e => setPick(p => ({ ...p, [n.name]: e.target.value }))}>
          <option value="">Don't link</option>{optionsFor(n.state)}
        </Select></td>
        <td>{n.guess && pick[n.name] !== n.guess.id ? <button className="link" disabled={!canManage} onClick={() => setPick(p => ({ ...p, [n.name]: n.guess!.id }))}>Use {n.guess.name}?</button> : n.guess ? <span className="muted">{n.score >= SURE ? "close match" : "your pick"}</span> : <span className="muted">none</span>}</td></tr>
        {open === n.name && <tr className="inforow"><td colSpan={7}>{details(n)}</td></tr>}</Fragment>)}</tbody></table></div>
    {list.length > shown && <div className="actions"><span className="muted">Showing {shown} of {list.length}.</span><button className="secondary" onClick={() => setShown(s => s + PAGE)}>Show {Math.min(PAGE, list.length - shown)} More</button></div>}
  </section>;
}

/** DSR spellings linked to a distributor whose name looks different, with a button to undo each link. */
export function SuspectLinks({ locations, canManage, onChanged, notify }: { locations: Distributor[]; canManage: boolean; onChanged: () => void; notify: (m: string) => void }) {
  const [list, setList] = useState<LinkedName[] | null>(null), [busy, setBusy] = useState(false), [reload, setReload] = useState(0), [shown, setShown] = useState(PAGE);
  useEffect(() => { let live = true; suspectLinks(locations).then(l => { if (live) setList(l); }).catch(() => { if (live) setList([]); }); return () => { live = false; }; }, [locations, reload]);
  async function unlink(rows: LinkedName[]) {
    setBusy(true);
    try {
      const days = await runTask(`Unlinking ${plural(rows.length, "DSR name")}`, async t => { let n = 0; for (let i = 0; i < rows.length; i++) { n += await unlinkName(rows[i].distributor.id, rows[i].db_name); t.step(i + 1, rows.length); } return n; }, rows.length, n => `${plural(n, "SO day")} unlinked.`);
      notify(`Unlinked ${plural(rows.length, "name")} (${plural(days, "SO day")}). They are back in the list above to link to the right distributor.`);
      setReload(x => x + 1); onChanged();
    } catch (e) { notify(`Not unlinked: ${errText(e)}`); }
    finally { setBusy(false); }
  }
  if (!list?.length) return null;
  return <section className="card">
    <div className="rowhead"><h2>Linked Names To Double-Check</h2>
      {canManage && <button className="secondary" disabled={busy} onClick={() => unlink(list)}>{busy ? "Unlinking…" : `Unlink All ${list.length}`}</button>}</div>
    <p className="hint">These DSR names are linked to a distributor whose name looks different, so the link may be wrong (for example every "… Traders" linked to A K Traders). Unlink the wrong ones; they go back to the list above to link again.</p>
    <div className="tablewrap scrolltable short"><table className="nice"><thead><tr><th>Name In DSR</th><th>Linked To</th><th>Days</th><th>Booked</th>{canManage && <th />}</tr></thead>
      <tbody>{list.slice(0, shown).map(l => <tr key={`${l.distributor.id}|${l.db_name}`}><td><b>{l.db_name}</b></td><td>{l.distributor.name}{l.distributor.territory ? <small className="muted"> · {l.distributor.territory}</small> : null}</td>
        <td>{l.days}</td><td>{money(l.value)}</td>{canManage && <td><button className="secondary small" disabled={busy} onClick={() => unlink([l])}>Unlink</button></td>}</tr>)}</tbody></table></div>
    {list.length > shown && <div className="actions"><span className="muted">Showing {shown} of {list.length}.</span><button className="secondary" onClick={() => setShown(s => s + PAGE)}>Show More</button></div>}
  </section>;
}
