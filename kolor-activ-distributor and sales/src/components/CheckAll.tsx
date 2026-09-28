import { useState } from "react";
import { supabase, Distributor, SalesOfficer, fetchAll, fmt, money, plural, errText } from "../lib/supabase";
import { localDate, normName } from "../lib/parse";
import { similarity } from "../lib/fuzzy";
import { teamTotal } from "../lib/dsr";

export interface CheckItem { id: string; label: string; count: number; help?: string; tab?: string }
/** One line of evidence: what was compared, the figures, and whether they agree. */
interface Line { what: string; a?: string; b?: string; diff?: string; ok: boolean }
interface Row extends CheckItem { ok: boolean; info?: boolean; note?: string; head?: string[]; lines?: Line[] }

/** One button that runs every check, and for each one shows exactly what it compared so it can be verified by hand. */
export default function CheckAll({ checks, officers, locations, onOpen }: { checks: CheckItem[]; officers: SalesOfficer[]; locations: Distributor[]; onOpen: (tab: string) => void }) {
  const [res, setRes] = useState<{ at: string; month: string; items: Row[] } | null>(null), [busy, setBusy] = useState(false), [err, setErr] = useState("");
  async function run() {
    if (!supabase) return;
    setBusy(true); setErr("");
    try {
      const now = new Date(), from = localDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to = localDate(new Date(now.getFullYear(), now.getMonth(), 0));
      const month = new Date(`${from}T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
      const [unlinked, stateDays, soDays, stockCheck] = await Promise.all([
        fetchAll<{ db_name: string; state: string | null; sale_value: number }>((a, b) => supabase!.from("dsr_days").select("db_name,state,sale_value").is("distributor_id", null).not("db_name", "is", null).gt("sale_value", 0).order("id").range(a, b)).catch(() => []),
        fetchAll<{ state: string; day: string; sale_value: number; team: string }>((a, b) => supabase!.from("dsr_state_days").select("*").gte("day", from).lte("day", to).order("day").range(a, b)).catch(() => []),
        fetchAll<{ so_id: string; state: string | null; day: string; sale_value: number }>((a, b) => supabase!.from("dsr_days").select("so_id,state,day,sale_value").gte("day", from).lte("day", to).order("id").range(a, b)).catch(() => []),
        fetchAll<{ distributor_id: string; product: string; product_id: string | null; so_qty: number; opening: number; received: number; closing: number; counted: boolean; has_before: boolean }>((a, b) => supabase!.rpc("dsr_stock_check", { p_from: from, p_to: to }).range(a, b)).catch(() => []),
      ]);
      const loc = (id: string) => locations.find(l => l.id === id)?.name || "Deleted";
      // State totals against their own workbook's SOs, day by day.
      const byState = new Map<string, number>(); soDays.forEach(d => { const k = `${d.state}|${d.day}`; byState.set(k, (byState.get(k) || 0) + Number(d.sale_value)); });
      const stateLines: Line[] = stateDays.map(s => {
        const sos = s.team ? teamTotal(s.team, s.day, soDays, officers) : byState.get(`${s.state}|${s.day}`) || 0, tot = Number(s.sale_value);
        return { what: `${s.state} ${s.day}`, a: money(tot), b: money(sos), diff: money(tot - sos), ok: Math.abs(tot - sos) <= Math.max(100, tot * 0.01) };
      });
      // SO bookings against the distributor's stock, product by product.
      const stockLines: Line[] = stockCheck.map(r => {
        const so = Number(r.so_qty), had = Number(r.opening) + Number(r.received), drop = had - Number(r.closing);
        const unknown = !r.product_id || (!r.has_before && !Number(r.received));
        const bad = !unknown && (so > had + 0.05 || (r.counted && so > drop + 0.5));
        return { what: `${loc(r.distributor_id)} · ${r.product}`, a: `${fmt(so, 1)} dz`, b: unknown ? (r.product_id ? "no stock before the month" : "product not in the list") : `${fmt(had, 1)} dz${r.counted ? `, went down ${fmt(drop, 1)}` : ""}`, ok: !bad && !unknown, diff: unknown ? "can't check" : bad ? "booked more" : "covered" };
      });
      // DB names in DSRs that don't point at a distributor.
      const nm = new Map<string, { name: string; state: string; v: number }>();
      unlinked.forEach(u => { const k = u.db_name.trim(); if (/^(leave|sunday|holiday|weekly off|review meeting|meeting|absent)$/i.test(k)) return; const e = nm.get(normName(k)) || { name: k, state: u.state || "", v: 0 }; e.v += Number(u.sale_value); nm.set(normName(k), e); });
      const nameLines: Line[] = [...nm.values()].sort((a, b) => b.v - a.v).map(e => ({ what: e.name, a: e.state, b: money(e.v), ok: false }));
      // People who look like the same person.
      const dupLines: Line[] = [];
      for (let i = 0; i < officers.length; i++) for (let j = i + 1; j < officers.length; j++) {
        const a = officers[i].name.replace(/^(md|mohd|mr)\.?\s+/i, ""), b = officers[j].name.replace(/^(md|mohd|mr)\.?\s+/i, "");
        const s = similarity(a, b);
        if (s >= 0.85) dupLines.push({ what: `${officers[i].name} / ${officers[j].name}`, a: officers[i].zone || officers[i].state || "", b: officers[j].zone || officers[j].state || "", diff: `${Math.round(s * 100)}% alike`, ok: false });
      }
      const flaggedFirst = (l: Line[]) => [...l].sort((x, y) => Number(x.ok) - Number(y.ok));
      const bad = (l: Line[]) => l.filter(x => !x.ok && x.diff !== "can't check").length;
      const cant = stockLines.some(l => l.diff === "can't check");
      const items: Row[] = [
        ...checks.map(c => ({ ...c, ok: c.count === 0, note: c.help })),
        { id: "state", label: "DSR state totals match the SO sheets", count: bad(stateLines), ok: !!stateLines.length && !bad(stateLines), info: !stateLines.length,
          note: stateLines.length ? `Each day's state total in the DSR against the SOs of the same workbook, ${month}. Differences over 1% (or ₹100) are flagged.` : `No state total sheets for ${month}.`,
          head: ["State and day", "State total", "SOs add up to", "Difference"], lines: flaggedFirst(stateLines) },
        { id: "link", label: "DSR DB names linked to distributors", count: nameLines.length, ok: !nameLines.length, note: "Names in the DSR's DB column that don't point to a distributor, so their bookings can't be checked. Link them on SO Reports › Stock Checks.",
          head: ["Name in DSR", "State", "Booked"], lines: nameLines },
        { id: "over", label: `SO bookings covered by the distributor's stock (${month})`, count: bad(stockLines), ok: !!stockLines.length && !bad(stockLines) && !cant, info: !bad(stockLines) && cant,
          note: "For each distributor and product: dozens SOs booked in the month, against stock before the month plus stock received, and how far stock went down when a count was posted.",
          head: ["Distributor · product", "SO booked", "Distributor had", "Result"], lines: flaggedFirst(stockLines) },
        { id: "dupes", label: "Sales team without duplicate entries", count: dupLines.length, ok: !dupLines.length, note: "Pairs of names 85% or more alike (MD / Mohd ignored). Merge real duplicates on SO Reports › Sales Team.",
          head: ["Names", "Zone", "Zone", "Alike"], lines: dupLines },
        { id: "dsr", label: `SO daily reports for ${month}`, count: soDays.length, ok: !!soDays.length, info: true, note: "SO-days uploaded for the month; the checks above use them." },
      ];
      setRes({ at: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }), month, items });
    } catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  }
  const flagged = res?.items.filter(i => !i.ok && !i.info) || [];
  return <section className="card checkall">
    <div className="rowhead"><div><h2>Check Everything</h2><p className="hint">Runs every check at once. Open any line to see exactly what it compared, figure by figure, so you can verify it yourself.</p></div>
      <button disabled={busy} onClick={run}>{busy ? "Checking…" : res ? "Check Again" : "Run All Checks"}</button></div>
    {err && <div className="status err">{err}</div>}
    {res && <>
      <div className={`status ${flagged.length ? "err" : "ok"}`}>{flagged.length ? `${plural(flagged.length, "check")} need${flagged.length === 1 ? "s" : ""} a manual review.` : "Everything checked matches."} Checked at {res.at}.</div>
      <div className="checklist">{res.items.map(i => <details key={i.id} className={i.ok ? "ok" : i.info ? "info" : "bad"}>
        <summary><span className="mark" aria-hidden>{i.ok ? "✓" : i.info ? "•" : "⚠"}</span>
          <span className="what">{i.label}{i.note && <small>{i.note}</small>}</span>
          <span className="num">{i.id === "dsr" ? fmt(i.count) : i.ok ? "OK" : i.info && !i.count ? "Can't verify yet" : `${fmt(i.count)} flagged`}</span>
          {!i.ok && i.tab && <button className="secondary small" onClick={e => { e.preventDefault(); onOpen(i.tab!); }}>Review</button>}</summary>
        {i.lines ? (i.lines.length ? <div className="tablewrap scrolltable short"><table className="nice"><thead><tr><th />{i.head!.map(h => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{i.lines.slice(0, 500).map((l, k) => <tr key={k} className={l.ok ? "" : "flagged"}><td>{l.ok ? "✓" : l.diff === "can't check" ? "•" : "⚠"}</td><td>{l.what}</td>{l.a !== undefined && <td>{l.a}</td>}{l.b !== undefined && <td>{l.b}</td>}{l.diff !== undefined && <td>{l.diff}</td>}</tr>)}</tbody></table>
          {i.lines.length > 500 && <p className="hint">First 500 of {i.lines.length} lines.</p>}</div> : <p className="hint">Nothing to compare.</p>)
          : <p className="hint">{i.count ? `${plural(i.count, "item")} found. Press Review to see them in the tab below.` : "Nothing found."}</p>}
      </details>)}</div>
    </>}
  </section>;
}
