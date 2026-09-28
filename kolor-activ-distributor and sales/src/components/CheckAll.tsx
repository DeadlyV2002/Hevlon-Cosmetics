import { ReactNode, useState } from "react";
import { supabase, Distributor, SalesOfficer, fetchAll, fmt, money, plural, errText } from "../lib/supabase";
import { localDate } from "../lib/parse";
import { similarity } from "../lib/fuzzy";
import { teamTotal } from "../lib/dsr";
import { SURE } from "./DsrLinker";
import { loadUnlinked, suggest, linkNames, suspectLinks, unlinkName } from "../lib/dsrLink";
import { runTask, startTask, TaskHandle } from "../lib/tasks";

/** A one-click fix: does the work and says what it did. */
export interface Fix { label: string; hint?: string; run: (t: TaskHandle) => Promise<string> }
/** One line of evidence. cant: couldn't be checked (missing data), not a problem as such. */
export interface Line { cells: ReactNode[]; ok: boolean; cant?: boolean }
export interface CheckItem { id: string; label: string; count: number; help?: string; tab?: string; head?: string[]; lines?: Line[]; fixes?: Fix[]; info?: boolean }

/** WhatsApp chat with a location's first phone number and a message ready to send. */
export function whatsapp(l: Distributor | undefined, text: string) {
  const d = (l?.phone || "").split(/[,;/]/)[0].replace(/\D/g, "");
  const to = d.length === 10 ? `91${d}` : d;
  return to.length >= 11 ? <a className="button secondary small" href={`https://wa.me/${to}?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">WhatsApp</a> : <span className="muted">no phone</span>;
}

/** One button that runs every check; each check opens to show every figure it compared and the fixes the app can make. */
export default function CheckAll({ checks, officers, locations, canManage, onOpen, onFixed }: {
  checks: CheckItem[]; officers: SalesOfficer[]; locations: Distributor[]; canManage: boolean; onOpen: (tab: string) => void; onFixed: () => Promise<void> | void;
}) {
  const [res, setRes] = useState<{ at: string; month: string; items: CheckItem[] } | null>(null), [busy, setBusy] = useState(""), [err, setErr] = useState("");
  async function run() {
    if (!supabase) return;
    setBusy("run"); setErr("");
    const task = startTask("Checking everything", 6);
    try {
      const now = new Date(), from = localDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to = localDate(new Date(now.getFullYear(), now.getMonth(), 0));
      const month = new Date(`${from}T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
      const loc = (id: string) => locations.find(l => l.id === id);
      const ask = (l?: Distributor) => whatsapp(l, `Hello ${l?.owner_name || l?.name || ""}, please send your stock statement and bills for ${month} to Kolor Activ. Thank you.`);
      let step = 0; const done = <T,>(p: Promise<T>) => p.then(r => { task.step(++step, 6); return r; });
      const [names, stateDays, soDays, stockCheck, suspects] = await Promise.all([
        done(loadUnlinked().then(l => suggest(l, locations))).catch(() => []),
        done(fetchAll<{ state: string; day: string; sale_value: number; team: string }>((a, b) => supabase!.from("dsr_state_days").select("*").gte("day", from).lte("day", to).order("day").range(a, b))).catch(() => []),
        done(fetchAll<{ so_id: string; state: string | null; day: string; sale_value: number }>((a, b) => supabase!.from("dsr_days").select("so_id,state,day,sale_value").gte("day", from).lte("day", to).order("id").range(a, b))).catch(() => []),
        done(fetchAll<{ distributor_id: string; product: string; product_id: string | null; so_qty: number; opening: number; received: number; closing: number; counted: boolean; has_before: boolean }>((a, b) => supabase!.rpc("dsr_stock_check", { p_from: from, p_to: to }).range(a, b))).catch(() => []),
        done(suspectLinks(locations)).catch(() => []),
      ]);
      // State totals against their own workbook's SOs, day by day.
      const byState = new Map<string, number>(); soDays.forEach(d => { const k = `${d.state}|${d.day}`; byState.set(k, (byState.get(k) || 0) + Number(d.sale_value)); });
      const stateLines: Line[] = stateDays.map(s => {
        const sos = s.team ? teamTotal(s.team, s.day, soDays, officers) : byState.get(`${s.state}|${s.day}`) || 0, tot = Number(s.sale_value);
        return { cells: [`${s.state} ${s.day}`, money(tot), money(sos), money(tot - sos)], ok: Math.abs(tot - sos) <= Math.max(100, tot * 0.01) };
      });
      // SO bookings against the distributor's stock, product by product.
      const noProduct = new Set<string>(), noStock = new Set<string>();
      const stockLines: Line[] = stockCheck.map(r => {
        const so = Number(r.so_qty), had = Number(r.opening) + Number(r.received), drop = had - Number(r.closing), l = loc(r.distributor_id);
        if (!r.product_id) noProduct.add(r.product);
        const unknown = !r.product_id || (!r.has_before && !Number(r.received));
        if (unknown && r.product_id) noStock.add(r.distributor_id);
        const bad = !unknown && (so > had + 0.05 || (r.counted && so > drop + 0.5));
        return { cells: [l?.name || "Deleted", r.product, `${fmt(so, 1)} dz`, unknown ? (r.product_id ? "no stock before the month" : "product not in the list") : `${fmt(had, 1)} dz${r.counted ? `, went down ${fmt(drop, 1)}` : ""}`,
          unknown ? "can't check" : bad ? "booked more" : "covered", unknown && r.product_id ? ask(l) : ""], ok: !bad && !unknown, cant: unknown };
      });
      // DB names in DSRs that don't point at a distributor.
      const nameLines: Line[] = names.map(e => ({ cells: [e.name, e.state, money(e.value), e.guess ? `${e.guess.name}${e.guess.territory ? ` · ${e.guess.territory}` : ""}${e.score < SURE ? " (check)" : ""}` : "no close match"], ok: false }));
      const toLink = names.filter(n => n.guess && n.score >= SURE);
      // Names linked to a distributor whose name looks different.
      const unlink = async (rows: typeof suspects, t?: TaskHandle) => { let n = 0; for (let i = 0; i < rows.length; i++) { n += await unlinkName(rows[i].distributor.id, rows[i].db_name); t?.step(i + 1, rows.length); } return `Unlinked ${plural(rows.length, "name")} (${plural(n, "SO day")}).`; };
      const suspectLines: Line[] = suspects.map(l => ({ cells: [l.db_name, l.distributor.name, fmt(l.days), money(l.value),
        canManage ? <button className="secondary small" onClick={() => fix({ label: `Unlink ${l.db_name}`, run: () => unlink([l]) })}>Unlink</button> : ""], ok: false }));
      // People who look like the same person. The fuller name is kept; the other becomes an alias.
      const pairs: [SalesOfficer, SalesOfficer][] = [];
      const bare = officers.map(o => o.name.replace(/^(md|mohd|mr)\.?\s+/i, ""));
      for (let i = 0; i < officers.length; i++) for (let j = i + 1; j < officers.length; j++) if (similarity(bare[i], bare[j]) >= 0.85) pairs.push(officers[i].name.length >= officers[j].name.length ? [officers[i], officers[j]] : [officers[j], officers[i]]);
      const merge = async (keep: SalesOfficer, drop: SalesOfficer) => { const { error } = await supabase!.rpc("merge_staff", { p_keep: keep.id, p_drop: drop.id }); if (error) throw new Error(errText(error)); };
      const dupLines: Line[] = pairs.map(([k, d]) => ({ cells: [`${k.name} / ${d.name}`, k.zone || k.state || "", d.zone || d.state || "", `${Math.round(similarity(k.name, d.name) * 100)}% alike`,
        canManage ? <button className="secondary small" onClick={() => fix({ label: `Merge ${d.name} into ${k.name}`, run: async () => { await merge(k, d); return `${d.name} is now another name for ${k.name}.`; } })}>Merge</button> : ""], ok: false }));
      const flaggedFirst = (l: Line[]) => [...l].sort((x, y) => Number(x.ok) - Number(y.ok) || Number(!!x.cant) - Number(!!y.cant));
      const bad = (l: Line[]) => l.filter(x => !x.ok && !x.cant).length;
      const items: CheckItem[] = [
        { id: "state", label: "DSR state totals match the SO sheets", count: bad(stateLines), info: !stateLines.length,
          help: stateLines.length ? `Each day's state total in the DSR against the SOs of the same workbook, ${month}. Differences over 1% (or ₹100) are flagged. Days uploaded before July 2026 kept one total per state, so North and South Bihar overwrote each other; upload those workbooks again on SO Reports › Upload DSR (tick Replace) and each is checked against its own SOs.` : `No state total sheets for ${month}.`,
          head: ["State and day", "State total", "SOs add up to", "Difference"], lines: flaggedFirst(stateLines) },
        { id: "link", label: "DSR DB names linked to distributors", count: nameLines.length,
          help: "Names in the DSR's DB column that don't point to a distributor, so their bookings can't be checked. The closest distributor in the same state is suggested.",
          head: ["Name in DSR", "State", "Booked", "Suggested distributor"], lines: nameLines,
          fixes: canManage && toLink.length ? [{ label: `Link ${plural(toLink.length, "Close Match", "Close Matches")}`, hint: "Links only names that are nearly the same as a distributor in the same state. Weaker suggestions wait for you on SO Reports › Stock Checks.",
            run: async t => { const r = await linkNames(toLink.map(n => ({ db_name: n.name, distributor_id: n.guess!.id })), t); return `Linked ${plural(r.names, "name")} (${plural(r.days, "SO day")}).`; } }] : [] },
        { id: "suspect", label: "DSR names linked to the right distributor", count: suspectLines.length,
          help: "DSR names linked to a distributor whose name looks different, so the link may be wrong. Unlinked names go back to the list above to link again.",
          head: ["Name in DSR", "Linked to", "Days", "Booked", ""], lines: suspectLines,
          fixes: canManage && suspects.length ? [{ label: `Unlink All ${suspects.length}`, hint: "Only if none of these are right. Otherwise unlink them one by one below.", run: t => unlink(suspects, t) }] : [] },
        { id: "over", label: `SO bookings covered by the distributor's stock (${month})`, count: bad(stockLines), info: !bad(stockLines) && stockLines.some(l => l.cant),
          help: "For each distributor and product: dozens SOs booked in the month, against stock before the month plus stock received, and how far stock went down when a count was posted. Lines marked \"can't check\" need that distributor's stock statement.",
          head: ["Distributor", "Product", "SO booked", "Distributor had", "Result", "Ask for stock"], lines: flaggedFirst(stockLines),
          fixes: canManage && noProduct.size ? [{ label: `Add ${plural(noProduct.size, "DSR Product")} To The Product List`, hint: `${[...noProduct].slice(0, 6).join(", ")}${noProduct.size > 6 ? "…" : ""}`,
            run: async () => { const { data, error } = await supabase!.rpc("products_from_dsr"); if (error) throw new Error(errText(error)); return `Added ${plural((data as { added: number }).added, "product")}.`; } }] : [] },
        { id: "dupes", label: "Sales team without duplicate entries", count: dupLines.length,
          help: "Pairs of names 85% or more alike (MD / Mohd ignored). Merging keeps the fuller name, moves every day and distributor to it, and saves the other spelling so future DSRs match.",
          head: ["Names", "Zone", "Zone", "Alike", ""], lines: dupLines,
          fixes: canManage && pairs.length ? [{ label: `Merge All ${plural(pairs.length, "Pair")}`, hint: "Only if every pair listed is the same person.",
            run: async t => { for (let i = 0; i < pairs.length; i++) { await merge(...pairs[i]); t.step(i + 1, pairs.length); } return `Merged ${plural(pairs.length, "pair")}.`; } }] : [] },
        { id: "dsr", label: `SO daily reports for ${month}`, count: soDays.length, info: true, help: `${plural(soDays.length, "SO-day")} uploaded for the month; the checks above use them.${noStock.size ? ` ${plural(noStock.size, "distributor")} with bookings sent no stock before the month.` : ""}` },
      ];
      setRes({ at: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }), month, items });
      task.ok("Open any line to see what it compared.");
    } catch (e) { setErr(errText(e)); task.fail(errText(e)); }
    finally { setBusy(""); }
  }
  async function fix(f: Fix) {
    setBusy(f.label);
    try { await runTask(f.label, f.run); await onFixed(); await run(); }
    catch (e) { setErr(`${f.label}: ${errText(e)}`); }
    finally { setBusy(""); }
  }
  // The SO check tabs are always shown as they stand now; the other checks as of the last run.
  const all: CheckItem[] = [...checks, ...(res?.items || [])];
  const isOk = (i: CheckItem) => !i.info && i.count === 0, isBad = (i: CheckItem) => !i.info && i.count > 0;
  const flagged = all.filter(isBad);
  return <section className="card checkall">
    <div className="rowhead"><div><h2>Check Everything</h2><p className="hint">Runs every check at once. Open any line to see exactly what it compared, with a button for each fix the app can make itself. Anything else is listed for you to review.</p></div>
      <button disabled={!!busy} onClick={run}>{busy === "run" ? "Checking…" : res ? "Check Again" : "Run All Checks"}</button></div>
    {err && <div className="status err">{err}</div>}
    {res && <>
      <div className={`status ${flagged.length ? "err" : "ok"}`}>{flagged.length ? `${plural(flagged.length, "check")} need${flagged.length === 1 ? "s" : ""} attention.` : "Everything checked matches."} Checked at {res.at}.</div>
      <div className="checklist">{all.map(i => <details key={i.id} className={isOk(i) ? "ok" : isBad(i) ? "bad" : "info"}>
        <summary><span className="mark" aria-hidden>{isOk(i) ? "✓" : isBad(i) ? "⚠" : "•"}</span>
          <span className="what">{i.label}</span>
          <span className="num">{i.id === "dsr" ? fmt(i.count) : isOk(i) ? "OK" : i.info && !i.count ? "Can't verify yet" : `${fmt(i.count)} flagged`}</span></summary>
        <div className="checkbody">
          {i.help && <p className="hint">{i.help}</p>}
          {(i.fixes?.length || i.tab) && <div className="fixes">
            {i.fixes?.map(f => <div key={f.label} className="fixrow"><button disabled={!!busy} onClick={() => fix(f)}>{busy === f.label ? "Working…" : f.label}</button>{f.hint && <small className="muted">{f.hint}</small>}</div>)}
            {i.tab && <button className="secondary" onClick={() => onOpen(i.tab!)}>Open The Full Tab</button>}</div>}
          {i.lines && (i.lines.length ? <div className="tablewrap scrolltable short"><table className="nice"><thead><tr><th />{i.head!.map((h, k) => <th key={k}>{h}</th>)}</tr></thead>
            <tbody>{i.lines.slice(0, 500).map((l, k) => <tr key={k} className={l.ok || l.cant ? "" : "flagged"}><td>{l.ok ? "✓" : l.cant ? "•" : "⚠"}</td>{l.cells.map((c, j) => <td key={j} className="wrap">{c}</td>)}</tr>)}</tbody></table>
            {i.lines.length > 500 && <p className="hint">First 500 of {fmt(i.lines.length)} lines. Download the full list from the tab.</p>}</div> : <p className="hint">Nothing to compare.</p>)}
        </div>
      </details>)}</div>
    </>}
  </section>;
}
