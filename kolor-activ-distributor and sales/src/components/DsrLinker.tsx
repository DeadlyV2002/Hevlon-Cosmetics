import { useEffect, useMemo, useState } from "react";
import Modal from "./Modal";
import LocationForm from "./LocationForm";
import { guessDetails } from "../lib/batch";
import { Distributor, SalesOfficer, StockLine, money, plural, errText, fmt, proper } from "../lib/supabase";
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
export default function DsrLinker({ locations, officers = [], stock = [], canManage, onLinked, onListsChanged, notify }: { locations: Distributor[]; officers?: SalesOfficer[]; stock?: StockLine[]; canManage: boolean; onLinked: () => void; onListsChanged?: () => void | Promise<void>; notify: (m: string) => void }) {
  const [open, setOpen] = useState(""), [adding, setAdding] = useState(false);
  useEffect(() => setAdding(false), [open]);
  /** A new distributor made from a DSR name: saved, then the name is linked to it at once. */
  async function addedNew(name: string, d: Distributor) {
    try {
      const r = await runTask("Linking DSR name to the new distributor", t => linkNames([{ db_name: name, distributor_id: d.id }], t), 1, r => `Linked ${plural(r.days, "SO day")}.`);
      notify(`Added ${d.name} (${d.code}) and linked "${name}" to it (${plural(r.days, "SO day")}).`);
    } catch (e) { notify(`${d.name} was added, but the DSR name wasn't linked: ${errText(e)}. Link it from the list.`); }
    setAdding(false); setOpen("");
    await onListsChanged?.(); onLinked();
  }
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

  async function link(only?: string) {
    const map = Object.entries(pick).filter(([name, id]) => id && (!only || name === only)).map(([db_name, distributor_id]) => ({ db_name, distributor_id }));
    if (!map.length) return;
    setBusy(true);
    try {
      const r = await runTask("Linking DSR DB names", t => linkNames(map, t), map.length, r => `Linked ${plural(r.names, "name")} (${plural(r.days, "SO day")}).`);
      notify(`Linked ${plural(r.names, "DB name")} (${plural(r.days, "SO day")}). Their spellings are saved, so future DSRs match by themselves.`);
      setOpen(""); onLinked();
    } catch (e) { notify(`Not linked: ${errText(e)}`); }
    finally { setBusy(false); }
  }
  const byId = useMemo(() => new Map(locations.map(l => [l.id, l])), [locations]);
  const soById = useMemo(() => new Map(officers.map(o => [o.id, o])), [officers]);
  const stockOf = useMemo(() => { const m = new Map<string, number>(); stock.forEach(x => m.set(x.distributor_id, (m.get(x.distributor_id) || 0) + Number(x.stock_value || 0))); return m; }, [stock]);
  /** A distributor's details: town, its super stockist (who sends it stock), its SO, stock now. */
  const card = (d: Distributor, why: string[], n: DbName) => {
    const ss = d.parent_id ? byId.get(d.parent_id) : undefined, via = d.via_id ? byId.get(d.via_id) : undefined, so = d.so_id ? soById.get(d.so_id) : undefined;
    const sameSo = !!so && n.sos.has(so.id), sameTown = !!d.territory && [...n.towns].some(t => similarity(t, d.territory!) >= 0.8), on = pick[n.name] === d.id;
    return <div key={d.id} className={`matchrow${on ? " on" : ""}`}>
      <div className="matchhead">
        <div><b>{d.name}</b> <small className="muted">{d.code} · {d.kind === "SUPER_STOCKIST" ? "Super stockist" : "Distributor"}{d.status === "DORMANT" ? " · dormant" : ""}</small>
          <div className="whys">{why.map(w => <span key={w} className="why">{w}</span>)}</div></div>
        {canManage && (on ? <span className="chosen">✓ Chosen</span> : <button className="secondary" onClick={() => setPick(p => ({ ...p, [n.name]: d.id }))}>Choose</button>)}
      </div>
      <dl>
        <dt>Town</dt><dd className={sameTown ? "good" : ""}>{[d.territory, d.region, d.state].filter(Boolean).join(", ") || "—"}{sameTown ? " ✓" : ""}</dd>
        <dt>Stock from</dt><dd>{d.direct ? "The company directly" : ss ? `${ss.name}${ss.territory ? `, ${ss.territory}` : ""}` : "—"}{via ? ` (goods via ${via.name})` : ""}</dd>
        <dt>SO</dt><dd className={sameSo ? "good" : ""}>{so ? `${so.name}${so.designation ? ` (${so.designation})` : ""}` : "Not set"}{sameSo ? " ✓ books this name" : ""}</dd>
        <dt>Owner</dt><dd>{[d.owner_name, d.phone].filter(Boolean).join(" · ") || "—"}</dd>
        <dt>Stock now</dt><dd>{stockOf.has(d.id) ? money(stockOf.get(d.id)) : "None recorded"}</dd>
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
    const people = [...n.sos].sort((a, b) => b[1] - a[1]).map(([id, days]) => ({ o: soById.get(id), days }));
    const cands = candidates(n), towns = once(n.towns), beats = once(n.beats), hqs = once(n.hqs), top = people[0];
    const chosenD = pick[n.name] ? byId.get(pick[n.name]) : undefined;
    return <>
      <div className="kpis">
        <div className="kpi"><small>Booked</small><b>{money(n.value)}</b><span>{plural(n.days, "day")}, {dmy(n.first)} to {dmy(n.last)}</span></div>
        <div className="kpi"><small>Booked by</small><b className="kpitext">{top?.o?.name || "Unknown"}</b><span>{top ? `${top.o?.designation || "SO"} · ${plural(top.days, "day")}` : ""}{people.length > 1 ? ` · ${people.length - 1} more` : ""}</span></div>
        <div className="kpi"><small>Where</small><b className="kpitext">{towns[0] || n.state || "—"}</b><span>{[n.state, hqs.length ? `HQ ${hqs.join(", ")}` : "", towns.length > 1 ? plural(towns.length, "town") : ""].filter(Boolean).join(" · ")}</span></div>
        <div className={`kpi${chosenD ? "" : " bad"}`}><small>Link</small><b className="kpitext">{chosenD ? chosenD.name : "Not chosen"}</b><span>{plural(cands.length, "possible distributor")}</span></div>
      </div>
      <div className="reportgrid">
        <section className="contact">
          <h3>From The DSRs</h3>
          <dl>
            <dt>Booked by</dt><dd className="lines">{people.map(p => <span key={p.o?.id || "x"}>{p.o?.name || "Unknown"}{p.o?.designation ? ` (${p.o.designation})` : ""}: {plural(p.days, "day")}</span>)}</dd>
            <dt>Towns</dt><dd>{towns.join(", ") || "—"}</dd>
            <dt>Beats</dt><dd>{beats.slice(0, 15).join(", ") || "—"}{beats.length > 15 ? ` and ${beats.length - 15} more` : ""}</dd>
            <dt>HQ</dt><dd>{hqs.join(", ") || "—"}</dd>
          </dl>
        </section>
        {adding && canManage ? (() => {
          const g = guessDetails(towns[0] || "", top?.o?.name || "", hqs[0] || "", locations, officers);
          return <section className="contact matches addnew">
            <h3>Add As A New Distributor</h3>
            <p className="hint">Filled in from the DSRs{g.parent_id && g.why ? ` (super stockist and region ${g.why})` : ""}. Check the details, add the owner and phone, and save: "{n.name}" is linked to it straight away.</p>
            <LocationForm key={n.name} kind="DISTRIBUTOR" prefillName={proper(n.name)} locations={locations} officers={officers}
              prefill={{ company_name: proper(n.name), state: g.state || n.state, region: g.region || hqs[0] || "", territory: proper(towns[0] || ""), so_id: top?.o?.id || g.so_id, parent_id: g.parent_id, aliases: n.name }}
              onCancel={() => setAdding(false)} onSaved={d => addedNew(n.name, d)} />
          </section>;
        })() : <section className="contact matches">
          <h3>Could Be</h3>
          {cands.length ? cands.map(c => card(c.d, c.why, n))
            : <p className="empty quiet">No distributor in {n.state || "this state"} has a similar name, is in the same town, or is served by the same SO.</p>}
          {canManage && <div className={`addnewbar${cands.length ? "" : " lone"}`}>
            <span>{cands.length ? "None of these?" : "It may be a new distributor."}</span>
            <button className={cands.length ? "secondary" : ""} onClick={() => setAdding(true)}>+ Add As New Distributor</button>
          </div>}
        </section>}
      </div>
    </>;
  };
  if (!names) return <section className="card"><p className="empty">Matching DSR DB names to your distributors…</p></section>;
  if (!names.length) return <p className="hint">Every DB name in the DSRs is linked to a distributor.</p>;
  const chosen = Object.values(pick).filter(Boolean).length;
  const t = q.trim().toLowerCase(), list = t ? names.filter(n => `${n.name} ${n.state} ${[...n.towns].join(" ")}`.toLowerCase().includes(t)) : names;
  return <section className="card">
    <div className="rowhead"><h2>Link DSR DB Names To Distributors</h2>
      {canManage && <button disabled={busy || !chosen} onClick={() => link()}>{busy ? "Linking…" : `Link ${plural(chosen, "Name")}`}</button>}</div>
    <p className="hint">{plural(names.length, "DB name")} in the SO reports {names.length === 1 ? "isn't" : "aren't"} linked to your distributor list, so {names.length === 1 ? "its" : "their"} bookings can't be checked against stock. Close matches in the same state are already chosen ({names.filter(n => n.guess && n.score >= SURE).length}); {names.filter(n => n.guess && n.score < SURE).length} weaker suggestions are offered for you to accept. Click a name to open who booked there, its towns and beats, and the distributors it could be with their SO and super stockist. Check each choice, then link.</p>
    <input className="search" placeholder="Search a DB name, state or town…" value={q} onChange={e => { setQ(e.target.value); setShown(PAGE); }} />
    <div className="tablewrap scrolltable"><table className="nice"><thead><tr><th>Name In DSR</th><th>State</th><th>Towns</th><th>Days</th><th>Booked</th><th>Link To</th><th>Suggestion</th></tr></thead>
      <tbody>{list.slice(0, shown).map(n => <tr key={n.name} className={pick[n.name] ? "" : "muted"}>
        <td><button className="link strong" aria-haspopup="dialog" onClick={() => setOpen(n.name)}>{n.name}</button><br /><small className="muted">{[...n.sos.keys()].map(id => soById.get(id)?.name).filter(Boolean).slice(0, 2).join(", ")}</small></td><td>{n.state}</td><td className="wrap">{[...n.towns].slice(0, 3).join(", ")}</td><td>{n.days}</td><td>{money(n.value)}</td>
        <td><Select value={pick[n.name] || ""} disabled={!canManage} onChange={e => setPick(p => ({ ...p, [n.name]: e.target.value }))}>
          <option value="">Don't link</option>{optionsFor(n.state)}
        </Select></td>
        <td>{n.guess && pick[n.name] !== n.guess.id ? <button className="link" disabled={!canManage} onClick={() => setPick(p => ({ ...p, [n.name]: n.guess!.id }))}>Use {n.guess.name}?</button> : n.guess ? <span className="muted">{n.score >= SURE ? "close match" : "your pick"}</span> : <span className="muted">none</span>}</td></tr>)}</tbody></table></div>
    {list.length > shown && <div className="actions"><span className="muted">Showing {shown} of {list.length}.</span><button className="secondary" onClick={() => setShown(s => s + PAGE)}>Show {Math.min(PAGE, list.length - shown)} More</button></div>}
    {(() => {
      const n = open ? names.find(x => x.name === open) : undefined;
      if (!n) return null;
      const chosenD = pick[n.name] ? byId.get(pick[n.name]) : undefined;
      return <Modal wide onClose={() => setOpen("")} className="report linkpop"
        title={n.name}
        subtitle={`DB name in the SO reports, not yet linked to your distributor list${n.state ? ` · ${n.state}` : ""}`}
        actions={canManage && <span className="actions">
          {chosenD && <button disabled={busy} onClick={() => link(n.name)}>{busy ? "Linking…" : `Link To ${chosenD.name}`}</button>}
          {pick[n.name] && <button className="secondary" onClick={() => setPick(p => ({ ...p, [n.name]: "" }))}>Don't Link</button>}
        </span>}>
        {details(n)}
      </Modal>;
    })()}
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
