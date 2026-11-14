import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import Modal from "./Modal";
import LocationForm from "./LocationForm";
import { guessDetails } from "../lib/batch";
import { supabase, Distributor, SalesOfficer, StockLine, money, plural, errText, fmt, proper, nextCode } from "../lib/supabase";
import { buildLinkSheets, readLinkSheet, LinkPlan, SheetOut } from "../lib/linkSheet";
import { normName } from "../lib/parse";
import { similarity } from "../lib/fuzzy";
import { dmy } from "../lib/dates";
import { DbName, LinkedName, loadUnlinked, suggest, groupAlike, linkNames, sameState, suspectLinks, unlinkName, nameScore } from "../lib/dsrLink";
import { runTask, startTask } from "../lib/tasks";
import { Select } from "./Select";

const PAGE = 40;
/** Suggestions this close are ticked already; weaker ones are offered but left for you to accept. */
export const SURE = 0.95;

/** DSR "DB Name" spellings that don't match a distributor: suggests the closest one to link. */
export default function DsrLinker({ locations, officers = [], stock = [], canManage, onLinked, onListsChanged, notify, sheetsRef }: { locations: Distributor[]; officers?: SalesOfficer[]; stock?: StockLine[]; canManage: boolean; onLinked: () => void; onListsChanged?: () => void | Promise<void>; notify: (m: string) => void;
  /** Lets the page's own Export To Excel include this list (the names on screen, ready to fill in). */
  sheetsRef?: React.MutableRefObject<(() => SheetOut[]) | null> }) {
  const [plan, setPlan] = useState<(LinkPlan & { file: string }) | null>(null), [sheetErr, setSheetErr] = useState("");
  const [open, setOpen] = useState(""), [adding, setAdding] = useState(false), [withSame, setWithSame] = useState(true);
  useEffect(() => { setAdding(false); setWithSame(true); }, [open]);
  /** A name with the other spellings of the same distributor, when they are being handled together. */
  const family = (name: string) => { const n = names?.find(x => x.name === name); return [name, ...(withSame && n?.same ? n.same.filter(x => names!.some(y => y.name === x)) : [])]; };
  const choose = (name: string, id: string) => setPick(p => ({ ...p, ...Object.fromEntries(family(name).map(x => [x, id])) }));
  /** A new distributor made from a DSR name: saved, then the name is linked to it at once. */
  async function addedNew(name: string, d: Distributor) {
    try {
      const all = family(name);
      const r = await runTask("Linking DSR name to the new distributor", t => linkNames(all.map(db_name => ({ db_name, distributor_id: d.id })), t), all.length, r => `Linked ${plural(r.days, "SO day")}.`);
      notify(`Added ${d.name} (${d.code}) and linked ${all.length > 1 ? `${all.length} spellings (${all.join(", ")})` : `"${name}"`} to it (${plural(r.days, "SO day")}).`);
    } catch (e) { notify(`${d.name} was added, but the DSR name wasn't linked: ${errText(e)}. Link it from the list.`); }
    setAdding(false); setOpen("");
    await onListsChanged?.(); onLinked();
  }
  const [names, setNames] = useState<DbName[] | null>(null), [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [reload, setReload] = useState(0), [shown, setShown] = useState(PAGE), [q, setQ] = useState("");
  useEffect(() => {
    let live = true;
    const task = startTask("Matching DSR DB names to distributors", 0, true);
    loadUnlinked().then(list => suggest(list, locations, task)).then(groupAlike).then(list => {
      if (!live) return;
      // Close matches are chosen already. Another spelling of the same distributor is offered the same match, for you to accept.
      const picks = Object.fromEntries(list.filter(n => n.guess && n.score >= SURE).map(n => [n.name, n.guess!.id]));
      const byId = new Map(locations.map(l => [l.id, l]));
      list = list.map(n => { if (picks[n.name] || !n.same) return n; const ids = new Set(n.same.map(x => picks[x]).filter(Boolean)); const d = ids.size === 1 ? byId.get([...ids][0]) : undefined; return d ? { ...n, guess: d, score: Math.min(Math.max(n.score, 0.85), SURE - 0.01) } : n; });
      setNames(list); setPick(picks);
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
    const mine = only ? family(only) : null;
    const map = Object.entries(pick).filter(([name, id]) => id && (!mine || mine.includes(name))).map(([db_name, distributor_id]) => ({ db_name, distributor_id }));
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
        {canManage && (on ? <span className="chosen">✓ Chosen</span> : <button className="secondary" onClick={() => choose(n.name, d.id)}>Choose</button>)}
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
      {n.same && n.same.length > 0 && <div className="samebox">
        <div className="rowhead"><b>⚑ Most probably the same distributor under {plural(n.same.length, "other spelling")} ({n.sameWhy})</b>
          <label className="inline"><input type="checkbox" checked={withSame} onChange={e => setWithSame(e.target.checked)} /> Link {n.same.length === 1 ? "it" : "them"} together with this name</label></div>
        <ul>{n.same.map(x => { const o = names!.find(y => y.name === x); return o ? <li key={x}><b>{o.name}</b> <span className="muted">· {[...o.sos.keys()].map(id => soById.get(id)?.name).filter(Boolean).join(", ")} · {once(o.towns).slice(0, 3).join(", ") || "no town"} · {plural(o.days, "day")} · {money(o.value)}</span></li> : null; })}</ul>
      </div>}
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
  // ---------- the list as an Excel sheet: filled in offline, uploaded back ----------
  const shownNames = () => { const t = q.trim().toLowerCase(); return t ? (names || []).filter(n => `${n.name} ${n.state} ${[...n.towns].join(" ")}`.toLowerCase().includes(t)) : names || []; };
  const sheets = () => buildLinkSheets(shownNames(), pick, locations, officers);
  useEffect(() => { if (sheetsRef) sheetsRef.current = names?.length ? sheets : null; return () => { if (sheetsRef) sheetsRef.current = null; }; });
  function exportList() {
    const wb = XLSX.utils.book_new();
    sheets().forEach(x => XLSX.utils.book_append_sheet(wb, x.ws, x.name));
    XLSX.writeFile(wb, `dsr-names-to-correct-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }
  async function readSheet(file: File) {
    setSheetErr("");
    try {
      const p = readLinkSheet(XLSX.read(await file.arrayBuffer()), names || [], locations, officers);
      if (!p.links.length && !p.news.length && !p.fills.length && !p.problems.length) throw new Error(p.gone ? "Every row with a correct name is for a spelling that is linked already. Download the list again for the names still unlinked." : "No row has a Correct Distributor Name filled in yet.");
      setPlan({ ...p, file: file.name });
    } catch (e) { setSheetErr(`${file.name}: ${errText(e)}`); }
  }
  /** Adds the new distributors, then links every spelling in the sheet. A failure part-way keeps what was saved; uploading the sheet again finishes the rest. */
  async function applyPlan() {
    if (!plan || !supabase) return;
    setBusy(true);
    try {
      const made = new Map<string, Distributor>();
      if (plan.news.length) await runTask(`Adding ${plural(plan.news.length, "new distributor")}`, async t => {
        const taken: { code: string }[] = [...locations];
        for (let i = 0; i < plan.news.length; i += 50) {
          const part = plan.news.slice(i, i + 50), payload = part.map(x => { const code = nextCode("DISTRIBUTOR", taken); taken.push({ code }); return { ...x.payload, code }; });
          const { data, error } = await supabase!.from("distributors").insert(payload).select();
          if (error) throw new Error(error.code === "42501" ? "only HO admins and state managers can add distributors" : errText(error));
          (data as Distributor[]).forEach(d => { const src = part.find(x => x.key === normName(d.name)); if (src) made.set(src.key, d); });
          t.step(Math.min(i + 50, plan.news.length), plan.news.length);
        }
      }, plan.news.length, () => `${plural(plan.news.length, "distributor")} added.`);
      const map = [...plan.links.map(l => ({ db_name: l.db_name, distributor_id: l.d.id })),
        ...plan.news.flatMap(x => { const d = made.get(x.key); return d ? x.spellings.map(db_name => ({ db_name, distributor_id: d.id })) : []; })];
      const r = map.length ? await runTask("Linking DSR DB names from the sheet", t => linkNames(map, t), map.length, r => `Linked ${plural(r.names, "name")} (${plural(r.days, "SO day")}).`) : { names: 0, days: 0 };
      notify(`From ${plan.file}: linked ${plural(r.names, "DB name")} (${plural(r.days, "SO day")})${plan.news.length ? `, added ${plural(plan.news.length, "new distributor")}` : ""}.${plan.problems.length ? ` ${plural(plan.problems.length, "row")} had a problem and ${plan.problems.length === 1 ? "was" : "were"} left unlinked.` : ""}`);
      let filledIn = 0;
      for (const x of plan.fills) { const { error } = await supabase.from("distributors").update(x.patch).eq("id", x.d.id); if (!error) filledIn++; }
      if (filledIn) notify(`From ${plan.file}: linked ${plural(r.names, "DB name")} (${plural(r.days, "SO day")})${plan.news.length ? `, added ${plural(plan.news.length, "new distributor")}` : ""}, filled in details for ${plural(filledIn, "distributor")}.`);
      setPlan(null);
      if (plan.news.length || filledIn) await onListsChanged?.();
      onLinked();
    } catch (e) { notify(`Stopped: ${errText(e)}. What was saved before this stays saved; upload the sheet again to finish the rest.`); if (plan.news.length) await onListsChanged?.(); onLinked(); setPlan(null); }
    finally { setBusy(false); }
  }
  if (!names) return <section className="card"><p className="empty">Matching DSR DB names to your distributors…</p></section>;
  if (!names.length) return <p className="hint">Every DB name in the DSRs is linked to a distributor.</p>;
  const chosen = Object.values(pick).filter(Boolean).length;
  const t = q.trim().toLowerCase(), list = t ? names.filter(n => `${n.name} ${n.state} ${[...n.towns].join(" ")}`.toLowerCase().includes(t)) : names;
  return <section className="card">
    <div className="rowhead"><h2>Link DSR DB Names To Distributors</h2>
      <div className="actions">
        <button className="secondary" onClick={exportList} title="Every spelling the SOs typed, one per row, with an empty column for the correct name">Download List (Excel)</button>
        {canManage && <label className="button secondary" title="Upload the downloaded list after typing the correct names">Upload Filled List<input hidden type="file" accept=".xlsx,.xlsm,.xls,.ods,.csv" onChange={e => { const x = e.target.files?.[0]; if (x) readSheet(x); e.target.value = ""; }} /></label>}
        {canManage && <button disabled={busy || !chosen} onClick={() => link()}>{busy ? "Linking…" : `Link ${plural(chosen, "Name")}`}</button>}
      </div></div>
    {sheetErr && <div className="status err">{sheetErr}</div>}
    <p className="hint">{plural(names.length, "DB name")} in the SO reports {names.length === 1 ? "isn't" : "aren't"} linked to your distributor list, so {names.length === 1 ? "its" : "their"} bookings can't be checked against stock. Close matches in the same state are already chosen ({names.filter(n => n.guess && n.score >= SURE).length}); {names.filter(n => n.guess && n.score < SURE).length} weaker suggestions are offered for you to accept. Click a name to open who booked there, its towns and beats, and the distributors it could be with their SO and super stockist. {names.some(n => n.same) ? ` ${names.filter(n => n.same).length} names are flagged ⚑ as other spellings of the same distributor (a typo, an added "s", dots in initials) because the same SO books them or they are in the same town; they sit together in the list and are linked together from the pop-up. ` : " "}Check each choice, then link. With many names it is quicker in Excel. Download List gives every spelling the SOs typed, one per row, with similar spellings one under the other. Type the correct distributor name beside each, then Upload Filled List. A correct name that is in your distributor list gets the spelling attached to it; any other correct name is added as a new distributor. Rows left empty are skipped.</p>
    <input className="search" placeholder="Search a DB name, state or town…" value={q} onChange={e => { setQ(e.target.value); setShown(PAGE); }} />
    <div className="tablewrap scrolltable"><table className="nice"><thead><tr><th>Name In DSR</th><th>State</th><th>Towns</th><th>Days</th><th>Booked</th><th>Link To</th><th>Suggestion</th></tr></thead>
      <tbody>{list.slice(0, shown).map(n => <tr key={n.name} className={pick[n.name] ? "" : "muted"}>
        <td><button className="link strong" aria-haspopup="dialog" onClick={() => setOpen(n.name)}>{n.name}</button><br /><small className="muted">{[...n.sos.keys()].map(id => soById.get(id)?.name).filter(Boolean).slice(0, 2).join(", ")}</small>
          {n.same && n.same.length > 0 && <small className="sameflag" title={`${n.sameWhy}: ${n.same.join(", ")}`}>⚑ {n.sameWhy}: also written {n.same[0]}{n.same.length > 1 ? ` +${n.same.length - 1}` : ""}</small>}</td><td>{n.state}</td><td className="wrap">{[...n.towns].slice(0, 3).join(", ")}</td><td>{n.days}</td><td>{money(n.value)}</td>
        <td><Select value={pick[n.name] || ""} disabled={!canManage} onChange={e => setPick(p => ({ ...p, [n.name]: e.target.value }))}>
          <option value="">Don't link</option>{optionsFor(n.state)}
        </Select></td>
        <td>{n.guess && pick[n.name] !== n.guess.id ? <button className="link" disabled={!canManage} onClick={() => setPick(p => ({ ...p, [n.name]: n.guess!.id }))}>Use {n.guess.name}?</button> : n.guess ? <span className="muted">{n.score >= SURE ? "close match" : "your pick"}</span> : <span className="muted">none</span>}</td></tr>)}</tbody></table></div>
    {list.length > shown && <div className="actions"><span className="muted">Showing {shown} of {list.length}.</span><button className="secondary" onClick={() => setShown(s => s + PAGE)}>Show {Math.min(PAGE, list.length - shown)} More</button></div>}
    {plan && <Modal wide onClose={() => !busy && setPlan(null)} className="report linkpop"
      title="Check The Filled List" subtitle={`${plan.file} · nothing is saved until you press Save`}
      actions={<span className="actions"><button disabled={busy || (!plan.links.length && !plan.news.length && !plan.fills.length)} onClick={applyPlan}>{busy ? "Saving…" : `Save: Link ${plural(plan.links.length + plan.news.reduce((a, x) => a + x.spellings.length, 0), "Name")}${plan.news.length ? `, Add ${plural(plan.news.length, "Distributor")}` : ""}`}</button></span>}>
      <div className="kpis">
        <div className="kpi"><small>Link to distributors in your list</small><b>{fmt(plan.links.length)}</b><span>DB names</span></div>
        <div className="kpi"><small>New distributors to add</small><b>{fmt(plan.news.length)}</b><span>{plural(plan.news.reduce((a, x) => a + x.spellings.length, 0), "DB name")} linked to them</span></div>
        <div className="kpi"><small>Bookings covered</small><b>{money(plan.value)}</b><span>{plural(plan.days, "SO day")}</span></div>
        <div className={`kpi${plan.problems.length ? " bad" : ""}`}><small>Rows with a problem</small><b>{fmt(plan.problems.length)}</b><span>{plan.blank ? `${plural(plan.blank, "row")} with no correct name yet` : "every row filled"}{plan.gone ? ` · ${fmt(plan.gone)} already linked` : ""}</span></div>
      </div>
      <div className="reportgrid sheetcheck">
        {plan.problems.length > 0 && <section className="contact"><h3>Not Saved: Fix These In The Sheet</h3>
          <div className="tablewrap scrolltable short"><table className="nice"><thead><tr><th>Name</th><th>What's wrong</th></tr></thead>
            <tbody>{plan.problems.map((p, i) => <tr key={i}><td><b>{p.name}</b></td><td className="wrap">{p.text}</td></tr>)}</tbody></table></div></section>}
        {plan.news.length > 0 && <section className="contact"><h3>New Distributors</h3>
          <div className="tablewrap scrolltable short"><table className="nice"><thead><tr><th>Distributor</th><th>Super Stockist</th><th>City</th><th>State</th><th>DSR Names</th><th>Still To Fill</th></tr></thead>
            <tbody>{plan.news.map(x => <tr key={x.key}><td><b>{x.payload.name}</b></td><td>{String(x.payload.super_stockist || "")}</td><td>{String(x.payload.territory || "—")}</td><td>{String(x.payload.state || "—")}</td>
              <td className="wrap">{x.spellings.join(", ")}</td><td className="wrap">{x.missing.length ? <span className="muted">{x.missing.join(", ")}</span> : "complete"}</td></tr>)}</tbody></table></div>
          {plan.news.some(x => x.missing.length) && <p className="hint">Distributors with details still to fill are added anyway; complete them later on the Distributors page (tick Only Incomplete).</p>}</section>}
        {plan.links.length > 0 && <section className="contact"><h3>Links To Distributors Already In Your List</h3>
          <div className="tablewrap scrolltable short"><table className="nice"><thead><tr><th>Distributor</th><th>Code</th><th>City</th><th>DSR Names Linked To It</th></tr></thead>
            <tbody>{[...new Map(plan.links.map(l => [l.d.id, l.d])).values()].map(d => <tr key={d.id}><td><b>{d.name}</b></td><td>{d.code}</td><td>{d.territory || "—"}</td><td className="wrap">{plan.links.filter(l => l.d.id === d.id).map(l => l.db_name).join(", ")}</td></tr>)}</tbody></table></div></section>}
        {plan.fills.length > 0 && <section className="contact"><h3>Details Filled In From The Sheet</h3>
          <p className="hint">Only fields that are empty in the software are filled; nothing already there is changed.</p>
          <div className="tablewrap scrolltable short"><table className="nice"><thead><tr><th>Distributor</th><th>Code</th><th>Filled In</th></tr></thead>
            <tbody>{plan.fills.map(x => <tr key={x.d.id}><td><b>{x.d.name}</b></td><td>{x.d.code}</td><td>{x.what.join(", ")}</td></tr>)}</tbody></table></div></section>}
      </div>
    </Modal>}
    {(() => {
      const n = open ? names.find(x => x.name === open) : undefined;
      if (!n) return null;
      const chosenD = pick[n.name] ? byId.get(pick[n.name]) : undefined;
      return <Modal wide onClose={() => setOpen("")} className="report linkpop"
        title={n.name}
        subtitle={`DB name in the SO reports, not yet linked to your distributor list${n.state ? ` · ${n.state}` : ""}`}
        actions={canManage && <span className="actions">
          {chosenD && <button disabled={busy} onClick={() => link(n.name)}>{busy ? "Linking…" : `Link To ${chosenD.name}`}</button>}
          {pick[n.name] && <button className="secondary" onClick={() => choose(n.name, "")}>Don't Link</button>}
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
