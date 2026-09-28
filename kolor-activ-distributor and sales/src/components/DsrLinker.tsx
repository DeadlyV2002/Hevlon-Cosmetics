import { useEffect, useMemo, useState } from "react";
import { Distributor, money, plural, errText } from "../lib/supabase";
import { DbName, LinkedName, loadUnlinked, suggest, linkNames, sameState, suspectLinks, unlinkName } from "../lib/dsrLink";
import { runTask, startTask } from "../lib/tasks";
import { Select } from "./Select";

const PAGE = 40;
/** Suggestions this close are ticked already; weaker ones are offered but left for you to accept. */
export const SURE = 0.95;

/** DSR "DB Name" spellings that don't match a distributor: suggests the closest one to link. */
export default function DsrLinker({ locations, canManage, onLinked, notify }: { locations: Distributor[]; canManage: boolean; onLinked: () => void; notify: (m: string) => void }) {
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
  if (!names) return <section className="card"><p className="empty">Matching DSR DB names to your distributors…</p></section>;
  if (!names.length) return <p className="hint">Every DB name in the DSRs is linked to a distributor.</p>;
  const chosen = Object.values(pick).filter(Boolean).length;
  const t = q.trim().toLowerCase(), list = t ? names.filter(n => `${n.name} ${n.state} ${[...n.towns].join(" ")}`.toLowerCase().includes(t)) : names;
  return <section className="card">
    <div className="rowhead"><h2>Link DSR DB Names To Distributors</h2>
      {canManage && <button disabled={busy || !chosen} onClick={link}>{busy ? "Linking…" : `Link ${plural(chosen, "Name")}`}</button>}</div>
    <p className="hint">{plural(names.length, "DB name")} in the SO reports {names.length === 1 ? "isn't" : "aren't"} linked to your distributor list, so {names.length === 1 ? "its" : "their"} bookings can't be checked against stock. Close matches in the same state are already chosen ({names.filter(n => n.guess && n.score >= SURE).length}); {names.filter(n => n.guess && n.score < SURE).length} weaker suggestions are offered for you to accept. Check each choice, then link.</p>
    <input className="search" placeholder="Search a DB name, state or town…" value={q} onChange={e => { setQ(e.target.value); setShown(PAGE); }} />
    <div className="tablewrap scrolltable"><table className="nice"><thead><tr><th>Name In DSR</th><th>State</th><th>Towns</th><th>Days</th><th>Booked</th><th>Link To</th><th>Suggestion</th></tr></thead>
      <tbody>{list.slice(0, shown).map(n => <tr key={n.name} className={pick[n.name] ? "" : "muted"}><td><b>{n.name}</b></td><td>{n.state}</td><td className="wrap">{[...n.towns].slice(0, 3).join(", ")}</td><td>{n.days}</td><td>{money(n.value)}</td>
        <td><Select value={pick[n.name] || ""} disabled={!canManage} onChange={e => setPick(p => ({ ...p, [n.name]: e.target.value }))}>
          <option value="">Don't link</option>{optionsFor(n.state)}
        </Select></td>
        <td>{n.guess && pick[n.name] !== n.guess.id ? <button className="link" disabled={!canManage} onClick={() => setPick(p => ({ ...p, [n.name]: n.guess!.id }))}>Use {n.guess.name}?</button> : n.guess ? <span className="muted">{n.score >= SURE ? "close match" : "your pick"}</span> : <span className="muted">none</span>}</td></tr>)}</tbody></table></div>
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
