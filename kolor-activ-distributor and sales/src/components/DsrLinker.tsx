import { useEffect, useMemo, useState } from "react";
import { supabase, Distributor, fetchAll, money, plural, errText } from "../lib/supabase";
import { normName } from "../lib/parse";
import { similarity, keyWords, hasWord } from "../lib/fuzzy";
import { Select } from "./Select";

interface Row { db_name: string; state: string | null; town: string | null; sale_value: number; attendance: string | null }
/** Words SOs put in the DB column on days they didn't visit a distributor. */
const NOT_A_DB = /^(leave|sunday|holiday|weekly off|week off|review meeting|meeting|absent|off|na|n a|nil|office|training|self|travel)$/;

/** DSR "DB Name" spellings that don't match a distributor: suggests the closest one to link. */
export default function DsrLinker({ locations, canManage, onLinked, notify }: { locations: Distributor[]; canManage: boolean; onLinked: () => void; notify: (m: string) => void }) {
  const [rows, setRows] = useState<Row[] | null>(null), [pick, setPick] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  useEffect(() => {
    if (!supabase) return;
    fetchAll<Row>((a, b) => supabase!.from("dsr_days").select("db_name,state,town,sale_value,attendance").is("distributor_id", null).not("db_name", "is", null).order("id").range(a, b))
      .then(setRows).catch(() => setRows([]));
  }, [reload]);
  const dists = useMemo(() => locations.filter(l => l.kind !== "GODOWN"), [locations]);
  const names = useMemo(() => {
    const m = new Map<string, { name: string; state: string; towns: Set<string>; days: number; value: number }>();
    (rows || []).forEach(r => {
      const k = normName(r.db_name);
      if (!k || NOT_A_DB.test(k)) return;
      const e = m.get(k) || { name: r.db_name.trim(), state: r.state || "", towns: new Set<string>(), days: 0, value: 0 };
      e.days++; e.value += Number(r.sale_value) || 0; if (r.town) e.towns.add(r.town.trim());
      m.set(k, e);
    });
    // Best guess per name: similar name (or its distinctive words), same state, and its town.
    return [...m.values()].sort((a, b) => b.value - a.value).map(e => {
      let best: Distributor | undefined, score = 0;
      for (const d of dists) {
        const sameState = !e.state || !d.state || normName(d.state).includes(normName(e.state)) || normName(e.state).includes(normName(d.state));
        if (!sameState) continue;
        const words = keyWords(e.name), dw = keyWords(d.name);
        const wordHit = dw.length > 0 && dw.every(w => hasWord(words, w));
        const town = d.territory && [...e.towns].some(t => similarity(t, d.territory!) >= 0.8);
        const s = Math.max(similarity(e.name, d.name), similarity(e.name, d.company_name || ""), ...(d.aliases || []).map(a => similarity(e.name, a)), wordHit ? 0.8 : 0) + (town ? 0.1 : 0);
        if (s > score) { score = s; best = d; }
      }
      return { ...e, guess: score >= 0.8 ? best : undefined, score };
    });
  }, [rows, dists]);
  useEffect(() => { setPick(Object.fromEntries(names.filter(n => n.guess).map(n => [n.name, n.guess!.id]))); }, [names]);

  async function link() {
    if (!supabase) return;
    const map = Object.entries(pick).filter(([, id]) => id).map(([db_name, distributor_id]) => ({ db_name, distributor_id }));
    if (!map.length) return;
    setBusy(true);
    const { data, error } = await supabase.rpc("link_dsr_distributors", { p_map: map });
    setBusy(false);
    if (error) return notify(`Not linked: ${errText(error)}. Run database step 012.`);
    const r = data as { days: number; names: number };
    notify(`Linked ${plural(r.names, "DB name")} (${plural(r.days, "SO day")}). Their spellings are saved, so future DSRs match by themselves.`);
    setReload(x => x + 1); onLinked();
  }
  if (!rows) return <p className="empty">Looking for DB names that aren't linked…</p>;
  if (!names.length) return <p className="hint">Every DB name in the DSRs is linked to a distributor.</p>;
  const chosen = Object.values(pick).filter(Boolean).length;
  return <section className="card">
    <div className="rowhead"><h2>Link DSR DB Names To Distributors</h2>
      {canManage && <button disabled={busy || !chosen} onClick={link}>{busy ? "Linking…" : `Link ${plural(chosen, "Name")}`}</button>}</div>
    <p className="hint">{plural(names.length, "DB name")} in the SO reports {names.length === 1 ? "isn't" : "aren't"} linked to your distributor list, so {names.length === 1 ? "its" : "their"} bookings can't be checked against stock. The closest distributor in the same state is suggested; change or clear any that are wrong, then link.</p>
    <div className="tablewrap scrolltable"><table className="nice"><thead><tr><th>Name In DSR</th><th>State</th><th>Towns</th><th>Days</th><th>Booked</th><th>Link To</th></tr></thead>
      <tbody>{names.map(n => <tr key={n.name} className={pick[n.name] ? "" : "muted"}><td><b>{n.name}</b></td><td>{n.state}</td><td className="wrap">{[...n.towns].slice(0, 3).join(", ")}</td><td>{n.days}</td><td>{money(n.value)}</td>
        <td><Select value={pick[n.name] || ""} disabled={!canManage} onChange={e => setPick({ ...pick, [n.name]: e.target.value })}>
          <option value="">Don't link</option>
          {dists.filter(d => !n.state || !d.state || normName(d.state).includes(normName(n.state)) || normName(n.state).includes(normName(d.state))).map(d => <option key={d.id} value={d.id}>{d.name}{d.territory ? ` · ${d.territory}` : ""}</option>)}
        </Select></td></tr>)}</tbody></table></div>
  </section>;
}
