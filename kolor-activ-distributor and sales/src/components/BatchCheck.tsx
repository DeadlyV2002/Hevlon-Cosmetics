import { useMemo, useState } from "react";
import { supabase, Distributor, SalesOfficer, Kind, KIND_LABEL, nextCode, plural, errText } from "../lib/supabase";
import { Scan, guessDetails } from "../lib/batch";
import { STATES } from "../lib/india";
import { normName } from "../lib/parse";
import { dmy } from "../lib/dates";
import { Select } from "./Select";

const NEW = "__new", ASIDE = "__aside";
/** One new distributor, shared by every file that names it. */
interface NewLoc { key: string; name: string; kind: Kind; territory: string; state: string; region: string; parent_id: string; so_id: string; why: string }
export interface BatchPlan { plan: Map<string, { code: string; date: string }>; aside: { file: File; reason: string }[]; order: File[] }

const groupKey = (s: Scan) => `${normName(s.name)}|${normName(s.town)}`;

/** Every chosen file at a glance before anything is saved: whose stock each is, new distributors to add, doubtful matches to settle, and stock dates. */
export default function BatchCheck({ scans, locations, officers, canManage, defaultDate, onCancel, onOneByOne, onStart, onListsChanged }: {
  scans: Scan[]; locations: Distributor[]; officers: SalesOfficer[]; canManage: boolean; defaultDate: string;
  onCancel: () => void; onOneByOne: () => void; onStart: (p: BatchPlan) => void; onListsChanged: () => Promise<void>;
}) {
  const needsHolder = (s: Scan) => s.type !== "ERROR" && s.type !== "BILLING" && s.type !== "SO";
  // Whose stock each file is: a location code, NEW, ASIDE, or "" while undecided.
  const [pick, setPick] = useState<Record<string, string>>(() => Object.fromEntries(scans.map(s => [s.key,
    !needsHolder(s) ? "" : s.status === "matched" ? s.match!.code : s.status === "new" && canManage ? NEW : ""])));
  const [dates, setDates] = useState<Record<string, string>>(() => Object.fromEntries(scans.map(s => [s.key, s.date || defaultDate])));
  const [news, setNews] = useState<Record<string, NewLoc>>(() => {
    const out: Record<string, NewLoc> = {};
    scans.filter(needsHolder).forEach(s => {
      const k = groupKey(s);
      if (out[k] || !s.name) return;
      const g = guessDetails(s.town, s.person, s.hq, locations, officers);
      out[k] = { key: k, name: s.name, kind: "DISTRIBUTOR", territory: s.town, state: g.state, region: g.region, parent_id: g.parent_id, so_id: g.so_id, why: g.why };
    });
    return out;
  });
  const [busy, setBusy] = useState(false), [err, setErr] = useState("");

  const holders = scans.filter(needsHolder);
  const newGroups = [...new Set(holders.filter(s => pick[s.key] === NEW).map(groupKey))].map(k => news[k]).filter(Boolean);
  const undecided = holders.filter(s => !pick[s.key]);
  const badDates = scans.filter(s => s.type !== "ERROR" && s.type !== "BILLING" && pick[s.key] !== ASIDE && !/^\d{4}-\d{2}-\d{2}$/.test(dates[s.key] || ""));
  const incomplete = newGroups.filter(n => !n.name.trim() || !n.state || !n.territory.trim() || (n.kind === "DISTRIBUTOR" && !n.parent_id));
  const toSave = scans.filter(s => s.type !== "ERROR" && s.type !== "BILLING" && pick[s.key] !== ASIDE);
  const ready = !undecided.length && !badDates.length && !incomplete.length && toSave.length > 0;
  // Two files for the same distributor on the same date: the later one's count replaces the earlier one's.
  const twice = useMemo(() => {
    const m = new Map<string, number>();
    toSave.forEach(s => { const p = pick[s.key]; if (p && p !== NEW) { const k = `${p}|${dates[s.key]}`; m.set(k, (m.get(k) || 0) + 1); } });
    return new Set([...m].filter(([, n]) => n > 1).map(([k]) => k));
  }, [toSave, pick, dates]);
  const supers = locations.filter(l => l.kind === "SUPER_STOCKIST");
  const states = useMemo(() => [...new Set([...locations.map(l => l.state).filter(Boolean) as string[], ...STATES])].sort(), [locations]);
  const locOpts = (["SUPER_STOCKIST", "DISTRIBUTOR", "GODOWN"] as Kind[]).map(k => <optgroup key={k} label={KIND_LABEL[k]}>
    {locations.filter(l => l.kind === k).map(l => <option key={l.id} value={l.code}>{l.name}{l.territory ? ` · ${l.territory}` : ""} ({l.code})</option>)}</optgroup>);
  const setNew = (k: string, patch: Partial<NewLoc>) => setNews(n => ({ ...n, [k]: { ...n[k], ...patch } }));

  async function start() {
    if (!supabase || !ready) return;
    setBusy(true); setErr("");
    try {
      // 1. New distributors and super stockists.
      const codeOf = new Map<string, string>();
      if (newGroups.length) {
        const taken: { code: string }[] = [...locations];
        const payload = newGroups.map(n => {
          const code = nextCode(n.kind, taken); taken.push({ code }); codeOf.set(n.key, code);
          const ss = supers.find(s => s.id === n.parent_id);
          return { code, name: n.name.trim(), company_name: n.name.trim(), kind: n.kind, state: n.state, region: n.region || null, territory: n.territory.trim(),
            parent_id: n.kind === "DISTRIBUTOR" && n.parent_id !== "direct" ? n.parent_id || null : null, super_stockist: ss?.name || null,
            ...(n.kind === "DISTRIBUTOR" ? { direct: n.parent_id === "direct" } : {}), so_id: n.so_id || null, aliases: [] };
        });
        const { error } = await supabase.from("distributors").insert(payload);
        if (error) throw new Error(error.code === "42501" ? "only HO admins and state managers can add distributors" : error.message);
      }
      // 2. The sheet's spelling becomes another name of the distributor it was matched to, so next month's file matches by itself.
      const aliases = new Map<string, Set<string>>();
      holders.forEach(s => {
        const code = pick[s.key];
        if (!code || code === NEW || code === ASIDE || s.fromFileName || !s.name) return;
        const d = locations.find(l => l.code === code);
        if (!d || [d.name, d.company_name || "", ...(d.aliases || [])].some(x => normName(x) === normName(s.name))) return;
        if (!aliases.has(d.id)) aliases.set(d.id, new Set(d.aliases || []));
        aliases.get(d.id)!.add(s.name);
      });
      for (const [id, set] of aliases) await supabase.from("distributors").update({ aliases: [...set] }).eq("id", id);
      if (newGroups.length || aliases.size) await onListsChanged();
      // 3. Whose stock and which date for every file; billing and unreadable files wait in Set Aside.
      const plan = new Map<string, { code: string; date: string }>(), aside: BatchPlan["aside"] = [], order: File[] = [];
      scans.forEach(s => {
        if (s.type === "ERROR") return aside.push({ file: s.file, reason: `couldn't be read: ${s.error}` });
        if (s.type === "BILLING") return aside.push({ file: s.file, reason: `${s.note}. Open it to check the super stockist matches, then save` });
        const p = pick[s.key];
        if (p === ASIDE) return aside.push({ file: s.file, reason: "set aside in the file check" });
        plan.set(s.key, { code: p === NEW ? codeOf.get(groupKey(s)) || "" : p, date: dates[s.key] });
        order.push(s.file);
      });
      onStart({ plan, aside, order });
    } catch (e) { setErr(`Nothing was saved: ${errText(e)}`); }
    finally { setBusy(false); }
  }

  const counts = { matched: holders.filter(s => pick[s.key] && pick[s.key] !== NEW && pick[s.key] !== ASIDE).length, fresh: newGroups.length, other: scans.length - holders.length };
  return <section className="card batchcheck">
    <div className="rowhead"><div><h2>Check {plural(scans.length, "File")} Before Saving</h2>
      <p className="hint">Every file has been read; nothing is saved yet. Settle the yellow rows, check the new distributors and dates, then save them all in one go.
        Files that can't be saved without your eye (billing, unreadable, rows with problems) wait in Set Aside instead of stopping the rest.</p></div>
      <div className="actions"><button className="secondary" onClick={onOneByOne} disabled={busy}>Open One By One Instead</button><button className="secondary" onClick={onCancel} disabled={busy}>Cancel</button></div></div>
    <div className="chips"><span className="chip">{counts.matched} matched</span>{counts.fresh > 0 && <span className="chip hold">{counts.fresh} new to add</span>}
      {undecided.length > 0 && <span className="chip warnchip">{undecided.length} to confirm</span>}{badDates.length > 0 && <span className="chip warnchip">{badDates.length} without a date</span>}
      {counts.other > 0 && <span className="chip">{counts.other} other (SO reports, billing, unreadable)</span>}</div>

    <div className="tablewrap scrolltable"><table className="nice"><thead><tr><th>File</th><th>The sheet says</th><th>Whose stock</th><th>Stock date</th></tr></thead>
      <tbody>{scans.map(s => {
        const p = pick[s.key] || "", d = locations.find(l => l.code === p);
        const flag = needsHolder(s) && !p ? "flagged" : s.type === "ERROR" ? "flagged" : "";
        return <tr key={s.key} className={flag}>
          <td className="wrap"><b>{s.file.name}</b>{s.note && <small className="muted">{s.note}</small>}</td>
          <td className="wrap">{s.type === "ERROR" ? <span className="err">Can't read it: {s.error}</span>
            : s.type === "BILLING" ? "Company billing to super stockists"
            : s.type === "SO" ? "SO daily report"
            : <>{s.name || <span className="muted">no name</span>}{s.town && <small className="muted">{s.town}{s.person ? ` · ${s.person}` : ""}</small>}</>}</td>
          <td>{!needsHolder(s) ? <span className="muted">{s.type === "SO" ? "not needed" : "waits in Set Aside"}</span> : <>
            {s.status === "check" && !p && s.match && <div className="ask">Is it <b>{s.match.name}</b>{s.match.territory ? ` (${s.match.territory})` : ""}?
              <button className="small" onClick={() => setPick(x => ({ ...x, [s.key]: s.match!.code }))}>Yes</button>
              {canManage && <button className="secondary small" onClick={() => setPick(x => ({ ...x, [s.key]: NEW }))}>No, It's New</button>}</div>}
            <Select value={p} onChange={e => setPick(x => ({ ...x, [s.key]: e.target.value }))} aria-label={`Whose stock is ${s.file.name}`}>
              <option value="">{s.status === "check" ? "Confirm or choose…" : "Choose…"}</option>
              {canManage && s.name && <option value={NEW}>New: {news[groupKey(s)]?.name || s.name}</option>}
              <option value={ASIDE}>Set aside for later</option>
              {locOpts}</Select>
            {d && s.status === "matched" && p === s.match?.code && <small className="ok">matched</small>}
            {d && twice.has(`${p}|${dates[s.key]}`) && <small className="err">another file is for {d.name} on the same date; the later one replaces it</small>}</>}</td>
          <td>{s.type === "ERROR" || s.type === "BILLING" ? "—" : <>
            <input type="date" value={dates[s.key] || ""} onChange={e => setDates(x => ({ ...x, [s.key]: e.target.value }))} aria-label={`Stock date for ${s.file.name}`} />
            {!s.date && <small className="warntext">not in the file: check it</small>}</>}</td>
        </tr>;
      })}</tbody></table></div>

    {newGroups.length > 0 && <>
      <h3>New {newGroups.length === 1 ? "Distributor" : "Distributors"} To Add ({newGroups.length})</h3>
      <p className="hint">Filled in from each sheet and from the distributors already in the same town. Owner and phone can be added later on the Distributors page.</p>
      <div className="tablewrap"><table className="nice newlocs"><thead><tr><th>Name</th><th>Type</th><th>Town</th><th>State</th><th>Super stockist</th><th>SO</th></tr></thead>
        <tbody>{newGroups.map(n => <tr key={n.key} className={incomplete.includes(n) ? "flagged" : ""}>
          <td><input value={n.name} onChange={e => setNew(n.key, { name: e.target.value })} aria-label="Name" />{n.why && <small className="muted">details {n.why}</small>}</td>
          <td><Select value={n.kind} onChange={e => setNew(n.key, { kind: e.target.value as Kind })} aria-label="Type">
            <option value="DISTRIBUTOR">Distributor</option><option value="SUPER_STOCKIST">Super stockist</option></Select></td>
          <td><input value={n.territory} onChange={e => setNew(n.key, { territory: e.target.value })} aria-label="Town" placeholder="Town" /></td>
          <td><Select value={n.state} onChange={e => setNew(n.key, { state: e.target.value })} aria-label="State"><option value="">Choose…</option>{states.map(x => <option key={x} value={x}>{x}</option>)}</Select></td>
          <td>{n.kind === "DISTRIBUTOR" ? <Select value={n.parent_id} onChange={e => setNew(n.key, { parent_id: e.target.value })} aria-label="Super stockist">
            <option value="">Choose…</option><option value="direct">Direct (no super stockist)</option>
            {supers.filter(s => !n.state || !s.state || s.state === n.state).map(s => <option key={s.id} value={s.id}>{s.name}{s.territory ? ` · ${s.territory}` : ""}</option>)}</Select> : <span className="muted">—</span>}</td>
          <td><Select value={n.so_id} onChange={e => setNew(n.key, { so_id: e.target.value })} aria-label="SO"><option value="">None</option>{officers.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</Select></td>
        </tr>)}</tbody></table></div></>}

    {err && <div className="status err">{err}</div>}
    <div className="footer-actions">
      {!ready && <span className="hint">{undecided.length ? `Confirm whose stock ${plural(undecided.length, "file")} ${undecided.length === 1 ? "is" : "are"} (yellow rows). ` : ""}
        {incomplete.length ? `Fill in town, state and super stockist for ${plural(incomplete.length, "new distributor")}. ` : ""}
        {badDates.length ? `Give ${plural(badDates.length, "file")} a stock date. ` : ""}</span>}
      <button disabled={!ready || busy} onClick={start}>{busy ? "Adding…" : `${newGroups.length ? `Add ${plural(newGroups.length, "New Distributor")} And ` : ""}Save ${plural(toSave.length, "File")}`}</button>
    </div>
    {toSave.length > 0 && <p className="hint">Dates of files with none in them: {dmy(defaultDate)} unless changed above.</p>}
  </section>;
}
