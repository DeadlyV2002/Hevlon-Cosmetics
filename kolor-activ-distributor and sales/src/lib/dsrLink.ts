// Matching the "DB Name" SOs type in their DSRs to the distributor list, quickly enough for hundreds
// of names against hundreds of distributors without freezing the page.
import { supabase, Distributor, fetchAll, errText } from "./supabase";
import { normName } from "./parse";
import { editDistance, hasWord, GENERIC } from "./fuzzy";
import { breathe, TaskHandle } from "./tasks";

/** Words that don't tell one shop from another in a DB name (what it sells, titles, usual misspellings), on top of the usual business words. */
const SHOP = new Set([...GENERIC, "trading", "trades", "trd", "trdrs", "tradrs", "tredrs", "treaders", "entprises", "eneterprises", "agencny", "ageny", "ajenci", "stor",
  "cosmetic", "cosmetics", "cosmatic", "fancy", "bangles", "bangle", "bagles", "bangal", "sringar", "shringar", "singar", "srinagar", "sringaar", "manihari", "manihar",
  "gen", "associates", "marketing", "collection", "shri", "shree", "sri", "new", "db", "ji", "jee"]);
/** Distinctive words of a DB name: "Ashish Cosmetic Store" → ["ashish"]. */
const keyWords = (s: string) => normName(s).split(" ").filter(w => w.length > 2 && !SHOP.has(w));

interface Row { db_name: string; state: string | null; town: string | null; sale_value: number; attendance: string | null }
export interface DbName { name: string; state: string; towns: Set<string>; days: number; value: number; guess?: Distributor; score: number }

/** Words SOs put in the DB column on days they didn't visit a distributor. */
export const NOT_A_DB = /^(leave|sunday|holiday|weekly off|week off|review meeting|meeting|absent|off|na|n a|nil|office|training|self|travel)$/;

interface Prep { flat: string; core: string; toks: string[] }
// Only the distinctive part of a name counts: "A K Traders" must not match every "... Traders", nor "JMR Enterprises" match "Abni Enterprises".
const prep = (s: string): Prep => {
  const n = normName(s).replace(/^m s /, ""), w = n.split(" ").filter(x => x && !(x.length > 1 && SHOP.has(x)));
  return { flat: n.replace(/ /g, ""), core: w.join(""), toks: w.filter(x => x.length > 1) };
};
const spelling = (x: string, y: string) => { const long = Math.max(x.length, y.length); return !long || Math.abs(x.length - y.length) / long > 0.25 ? 0 : 1 - editDistance(x, y) / long; };
/** Like similarity() in fuzzy.ts, on names cleaned once instead of on every comparison. */
function sim(a: Prep, b: Prep) {
  if (!a.flat || !b.flat) return 0;
  if (a.flat === b.flat) return 1;
  const contained = a.toks.length > 0 && b.toks.length > 0 && (a.toks.every(w => b.toks.includes(w)) || b.toks.every(w => a.toks.includes(w)));
  // Spelling is compared on the distinctive part of each name; the whole name only counts when it is nearly the same ("MD Cosmetics" / "M.D Cosmetic").
  const core = a.core && b.core ? spelling(a.core, b.core) : 0, whole = spelling(a.flat, b.flat);
  // Names made only of shop words ("Shree Agency" / "Shri Agency") are compared whole.
  return Math.max(core, whole >= 0.85 || (!a.core && !b.core) ? whole : 0, contained ? 0.85 : 0);
}
export const sameState = (a?: string | null, b?: string | null) => { const x = normName(a || ""), y = normName(b || ""); return !x || !y || x.includes(y) || y.includes(x); };

/** Unlinked DSR DB names, one line per spelling, biggest bookings first. */
export async function loadUnlinked(): Promise<DbName[]> {
  if (!supabase) return [];
  const rows = await fetchAll<Row>((a, b) => supabase!.from("dsr_days").select("db_name,state,town,sale_value,attendance").is("distributor_id", null).not("db_name", "is", null).order("id").range(a, b));
  const m = new Map<string, DbName>();
  rows.forEach(r => {
    const k = normName(r.db_name);
    if (!k || NOT_A_DB.test(k)) return;
    const e = m.get(k) || { name: r.db_name.trim(), state: r.state || "", towns: new Set<string>(), days: 0, value: 0, score: 0 };
    e.days++; e.value += Number(r.sale_value) || 0; if (r.town) e.towns.add(r.town.trim());
    m.set(k, e);
  });
  return [...m.values()].sort((a, b) => b.value - a.value);
}

/** Best distributor for each name: similar name (or its distinctive words), same state, and its town. Works in small steps so the page stays usable. */
export async function suggest(names: DbName[], locations: Distributor[], task?: TaskHandle): Promise<DbName[]> {
  const pd = locations.filter(l => l.kind !== "GODOWN").map(d => ({ d, names: [d.name, d.company_name || "", ...(d.aliases || [])].filter(Boolean).map(prep), kw: keyWords(d.name), town: d.territory ? prep(d.territory) : null }));
  const out: DbName[] = [];
  for (let i = 0; i < names.length; i++) {
    const e = names[i], me = prep(e.name), words = keyWords(e.name), towns = [...e.towns].map(prep);
    let best: Distributor | undefined, score = 0;
    for (const x of pd) {
      if (!sameState(e.state, x.d.state)) continue;
      let s = x.kw.length > 0 && x.kw.every(w => hasWord(words, w)) ? 0.8 : 0;
      for (const p of x.names) { const v = sim(me, p); if (v > s) s = v; }
      if (s >= 0.7 && x.town && towns.some(t => sim(t, x.town!) >= 0.8)) s += 0.1;
      if (s > score) { score = s; best = x.d; }
    }
    out.push({ ...e, guess: score >= 0.8 ? best : undefined, score });
    if (i % 20 === 19) { task?.step(i + 1, names.length); await breathe(); }
  }
  return out;
}

/** Links DSR spellings to distributors in small batches, with progress. The spellings are kept as other names, so later DSRs match on their own. */
export async function linkNames(map: { db_name: string; distributor_id: string }[], task: TaskHandle) {
  let days = 0, names = 0;
  for (let i = 0; i < map.length; i += 20) {
    const { data, error } = await supabase!.rpc("link_dsr_distributors", { p_map: map.slice(i, i + 20) });
    if (error) throw new Error(`${errText(error)}. Run database step 012.`);
    const r = data as { days: number; names: number };
    days += r.days; names += r.names;
    task.step(Math.min(i + 20, map.length), map.length, `${days} SO days linked so far`);
  }
  return { days, names };
}

/** How alike a DSR spelling is to a distributor's name or company name. */
export const nameScore = (dbName: string, d: Distributor) => Math.max(0, ...[d.name, d.company_name || ""].filter(Boolean).map(x => sim(prep(dbName), prep(x))),
  keyWords(d.name).length > 0 && keyWords(d.name).every(w => hasWord(keyWords(dbName), w)) ? 0.8 : 0);

export interface LinkedName { distributor: Distributor; db_name: string; days: number; value: number; score: number }
/** DSR spellings already linked to a distributor whose name looks different: likely wrong links. */
export async function suspectLinks(locations: Distributor[]): Promise<LinkedName[]> {
  if (!supabase) return [];
  const rows = await fetchAll<{ distributor_id: string; db_name: string; sale_value: number }>((a, b) => supabase!.from("dsr_days").select("distributor_id,db_name,sale_value").not("distributor_id", "is", null).not("db_name", "is", null).order("id").range(a, b));
  const byId = new Map(locations.map(l => [l.id, l])), m = new Map<string, LinkedName>();
  rows.forEach(r => {
    const d = byId.get(r.distributor_id); if (!d) return;
    const k = `${r.distributor_id}|${normName(r.db_name)}`;
    const e = m.get(k) || { distributor: d, db_name: r.db_name.trim(), days: 0, value: 0, score: -1 };
    e.days++; e.value += Number(r.sale_value) || 0; m.set(k, e);
  });
  return [...m.values()].map(e => ({ ...e, score: nameScore(e.db_name, e.distributor) })).filter(e => e.score < 0.5).sort((a, b) => b.value - a.value);
}
/** Undoes a link: the DSR days with that spelling go back to unlinked, and the spelling is dropped from the distributor's other names. */
export async function unlinkName(distributorId: string, dbName: string) {
  const { data, error } = await supabase!.rpc("unlink_dsr_name", { p_distributor: distributorId, p_name: dbName });
  if (error) throw new Error(`${errText(error)}. Run database step 012.`);
  return (data as { days: number }).days;
}
