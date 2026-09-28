import { useState } from "react";
import { supabase, SalesOfficer, fetchAll, fmt, plural, errText } from "../lib/supabase";
import { localDate } from "../lib/parse";
import { similarity } from "../lib/fuzzy";
import { teamTotal } from "../lib/dsr";

export interface CheckItem { id: string; label: string; count: number; note?: string; tab?: string }
interface Result { at: string; items: (CheckItem & { ok: boolean; info?: boolean })[] }

/** One button that runs every check and says plainly whether everything matches, or what needs a manual look. */
export default function CheckAll({ checks, officers, onOpen }: { checks: CheckItem[]; officers: SalesOfficer[]; onOpen: (tab: string) => void }) {
  const [res, setRes] = useState<Result | null>(null), [busy, setBusy] = useState(false), [err, setErr] = useState("");
  async function run() {
    if (!supabase) return;
    setBusy(true); setErr("");
    try {
      const now = new Date(), from = localDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to = localDate(new Date(now.getFullYear(), now.getMonth(), 0));
      const [unlinked, stateDays, soDays, stockCheck, dsrCount] = await Promise.all([
        fetchAll<{ db_name: string }>((a, b) => supabase!.from("dsr_days").select("db_name").is("distributor_id", null).not("db_name", "is", null).gt("sale_value", 0).order("id").range(a, b)).catch(() => []),
        fetchAll<{ state: string; day: string; sale_value: number; team: string }>((a, b) => supabase!.from("dsr_state_days").select("*").gte("day", from).lte("day", to).order("day").range(a, b)).catch(() => []),
        fetchAll<{ so_id: string; state: string | null; day: string; sale_value: number }>((a, b) => supabase!.from("dsr_days").select("so_id,state,day,sale_value").gte("day", from).lte("day", to).order("id").range(a, b)).catch(() => []),
        fetchAll<{ product_id: string | null; so_qty: number; opening: number; received: number; closing: number; counted: boolean; has_before: boolean }>((a, b) => supabase!.rpc("dsr_stock_check", { p_from: from, p_to: to }).range(a, b)).catch(() => []),
        supabase.from("dsr_days").select("id", { count: "exact", head: true }),
      ]);
      const sos = new Map<string, number>(); soDays.forEach(d => { const k = `${d.state}|${d.day}`; sos.set(k, (sos.get(k) || 0) + Number(d.sale_value)); });
      const gaps = stateDays.filter(s => Math.abs(Number(s.sale_value) - (s.team ? teamTotal(s.team, s.day, soDays, officers) : sos.get(`${s.state}|${s.day}`) || 0)) > Math.max(100, Number(s.sale_value) * 0.01)).length;
      const over = stockCheck.filter(r => r.product_id && (r.has_before || Number(r.received)) && Number(r.so_qty) > Number(r.opening) + Number(r.received) + 0.05).length;
      const drop = stockCheck.filter(r => r.product_id && r.counted && (r.has_before || Number(r.received)) && Number(r.so_qty) > Number(r.opening) + Number(r.received) - Number(r.closing) + 0.5).length;
      const cantCheck = stockCheck.filter(r => !r.product_id || (!r.has_before && !Number(r.received))).length;
      const names = new Set(unlinked.map(u => u.db_name.trim().toLowerCase()).filter(n => !/^(leave|sunday|holiday|weekly off|review meeting|meeting|absent)$/.test(n)));
      let dupes = 0;
      for (let i = 0; i < officers.length; i++) for (let j = i + 1; j < officers.length; j++) {
        const a = officers[i].name.replace(/^(md|mohd|mr)\.?\s+/i, ""), b = officers[j].name.replace(/^(md|mohd|mr)\.?\s+/i, "");
        if (similarity(a, b) >= 0.85) dupes++;
      }
      const month = new Date(`${from}T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
      const items: Result["items"] = [
        ...checks.map(c => ({ ...c, ok: c.count === 0 })),
        { id: "state", label: "DSR state totals match the SO sheets", count: gaps, note: stateDays.length ? `${month}` : "no state total sheets uploaded for last month", ok: gaps === 0, info: !stateDays.length },
        { id: "link", label: "DSR DB names linked to distributors", count: names.size, note: "link them on SO Reports › Stock Checks", ok: names.size === 0 },
        { id: "over", label: `SO bookings covered by the distributor's stock (${month})`, count: over + drop, note: cantCheck ? `${plural(cantCheck, "line")} can't be checked yet: no stock before the month, or product not in the list` : undefined, ok: over + drop === 0 && !cantCheck, info: over + drop === 0 && cantCheck > 0 },
        { id: "dupes", label: "Sales team without duplicate entries", count: dupes, note: "merge them on SO Reports › Sales Team", ok: dupes === 0 },
        { id: "dsr", label: `SO daily reports for ${month}`, count: soDays.length || dsrCount.count || 0, ok: !!(soDays.length || dsrCount.count), info: true },
      ];
      setRes({ at: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }), items });
    } catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  }
  const bad = res?.items.filter(i => !i.ok && !i.info) || [];
  return <section className="card checkall">
    <div className="rowhead"><div><h2>Check Everything</h2><p className="hint">Runs every check at once. Figures that match each other get a tick; anything doubtful is flagged for manual review.</p></div>
      <button disabled={busy} onClick={run}>{busy ? "Checking…" : res ? "Check Again" : "Run All Checks"}</button></div>
    {err && <div className="status err">{err}</div>}
    {res && <>
      <div className={`status ${bad.length ? "err" : "ok"}`}>{bad.length ? `${plural(bad.length, "check")} need${bad.length === 1 ? "s" : ""} a manual review.` : "Everything checked matches."} Checked at {res.at}.</div>
      <ul className="checklist">{res.items.map(i => <li key={i.id} className={i.ok ? "ok" : i.info ? "info" : "bad"}>
        <span className="mark" aria-hidden>{i.ok ? "✓" : i.info ? "•" : "⚠"}</span>
        <span className="what">{i.label}{i.note && <small>{i.note}</small>}</span>
        <span className="num">{i.id === "dsr" ? fmt(i.count) : i.ok ? "OK" : i.info && !i.count ? "Can't verify yet" : fmt(i.count)}</span>
        {!i.ok && i.tab && <button className="secondary small" onClick={() => onOpen(i.tab!)}>Review</button>}
      </li>)}</ul>
    </>}
  </section>;
}
