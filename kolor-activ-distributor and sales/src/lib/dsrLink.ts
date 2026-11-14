// Matching the "DB Name" SOs type in their DSRs to the distributor list, quickly enough for hundreds
// of names against hundreds of distributors without freezing the page.
import { supabase, Distributor, fetchAll, errText } from "./supabase";
import { normName } from "./parse";
import { editDistance, hasWord, GENERIC } from "./fuzzy";
import { breathe, TaskHandle } from "./tasks";

/** Words that don't tell one shop from another in a DB name (what it sells, titles, usual misspellings), on top of the usual business words. */
const SHOP = new Set([...GENERIC, "trading", "trades", "trd", "trdrs", "tradrs", "tredrs", "treaders", "entprises", "eneterprises", "agencny", "ageny", "ajenci", "ajency", "agancy", "agensi", "agenci", "stor", "treders", "tredars", "enterprice", "enterprize", "entp",
  "cosmetic", "cosmetics", "cosmatic", "fancy", "bangles", "bangle", "bagles", "bangal", "sringar", "shringar", "singar", "srinagar", "sringaar", "manihari", "manihar",
  "gen", "associates", "marketing", "collection", "shri", "shree", "sri", "new", "db", "ji", "jee"]);
/** Distinctive words of a DB name: "Ashish Cosmetic Store" → ["ashish"]. */
const keyWords = (s: string) => normName(s).split(" ").filter(w => w.length > 2 && !SHOP.has(w));

interface Row { db_name: string; state: string | null; town: string | null; beat: string | null; sale_value: number; attendance: string | null; so_id: string; day: string; hq: string | null }
export interface DbName { name: string; state: string; towns: Set<string>; days: number; value: number; guess?: Distributor; score: number;
  /** Who booked there (SO id → days), their beats and HQs, and the first and last day it appears. */
  sos: Map<string, number>; beats: Set<string>; hqs: Set<string>; first: string; last: string;
  /** Other unlinked spellings that look like this same distributor (a typo, an added "s", "J.M.R." for "JMR"), and what they share. */
  same?: string[]; sameWhy?: string }

/** Words SOs put in the DB column on days they didn't visit a distributor. */
export const NOT_A_DB = /^(leave|sunday|holiday|weekly off|week off|review meeting|meeting|absent|off|na|n a|nil|office|training|self|travel)$/;

/** Meeting days and visits to "the SS point" typed in the DB column: not a distributor, however they are spelt. */
const NOT_A_VISIT = /(me+t+ings?|mit+ings?)\b|\b(meet|review|training|p[ae]y?ments?|appoint(ed|ment)s?)\b|^(today on |work at )?(s ?)+point( \w+)?$/;
/** Two parties written in one cell ("Vishal Enterprises + Ashish Ent"): never grouped with either, or it would join them into one. */
const TWO_PARTIES = /[+&/,]| and /i;
const twoParties = (raw: string) => TWO_PARTIES.test(raw) || / and /.test(` ${normName(raw)} `);
// A day off or a day not spent at a distributor, however it is worded: "Holiday for Bihu", "Today on leave",
// "Leave due to fever", "Sunday Weekly Off", "Weakly off", "Transit Silchar to Guwahati", "Election of W.B".
const DAY_OFF = /\b(hol+[iy] ?days?|leave|sunday|transit|elections?|bandh|strike|curfew)\b|\bwe+a?k(ly)? ?off\b|\bweek ?off\b|\w*penden[cs]e ?day\b/;
const FESTIVAL = /^(holiday )?(for )?(the )?(bohag |magh |kati )?(bihu|diwali|deepawali|dipawali|holi|eid|id|chhath|chhath puja|durga puja|kali puja|laxmi puja|saraswati puja|vishwakarma puja|ganesh puja|rath yatra|raksha bandhan|rakhi|independence day|republic day|gandhi jayanti|dussehra|dashami|vijayadashami|christmas|muharram|ram navami|janmashtami|may day)( holiday| festival| off)?$/;
// Looking for, opening or discussing a distributor rather than visiting one: "New Db Search", "DB Searching",
// "Distributor searching Bheragora", "Appoint new distributor", "New SS confirm", "All DB close New DB open".
const PROSPECTING = /\b(search|sarch|serch|seach|searc)(ing)?\b|\b(new|old) (db|d b|ss|s s|distribut\w*|distrid\w*|distibut\w*)\b|\bappoint\w*\b/;
const NOT_A_PLACE = /^(outer|whole ?sale|local|main|open) market$|^market( work| visit| survey)?$/;
/** Words such remarks are made of. Anything else in the cell is a name: "New D.B. Raj Gallery" still names Raj Gallery. */
const REMARK_WORDS = new Set("new old db d b ss s distributor distributors distributior distridutar distibutor distributar search searching sarch sarching serch serching seach seaching searc open opened opening visit visited discuss discussion final confirm confrom conform confirmed created create appoint appointed appointment close closed all today for of the and point work".split(" "));
/** True when what was typed in the DB Name column is a remark about the day, not a distributor.
 *  A remark that also names a party ("Goswami Enterprise and New DB", "New DB open Sefali Enterprise") is kept, so it can still be attached to that party. */
export function isRemark(raw: string): boolean {
  const k = normName(raw);
  if (!k || NOT_A_DB.test(k) || NOT_A_VISIT.test(k) || DAY_OFF.test(k) || FESTIVAL.test(k) || NOT_A_PLACE.test(k)) return true;
  return PROSPECTING.test(k) && !k.split(" ").some(w => w.length > 1 && !REMARK_WORDS.has(w));
}
/** The distinctive part of a name with shop words set aside ("J.M.R Enterprises" → "jmr"), to put similar spellings side by side. */
export const nameCore = (raw: string) => { const p = prep(raw); return p.core || p.flat; };
interface Prep { flat: string; core: string; toks: string[] }
// Only the distinctive part of a name counts: "A K Traders" must not match every "... Traders", nor "JMR Enterprises" match "Abni Enterprises".
const prep = (s: string): Prep => {
  const n = normName(s).replace(/^m s /, ""), w = n.split(" ").filter(x => x && !(x.length > 1 && SHOP.has(x)));
  return { flat: n.replace(/ /g, ""), core: w.join(""), toks: w.filter(x => x.length > 1) };
};
const spelling = (x: string, y: string) => { const long = Math.max(x.length, y.length); return !long || Math.abs(x.length - y.length) / long > 0.25 ? 0 : 1 - editDistance(x, y) / long; };
/** Like similarity() in fuzzy.ts, on names cleaned once instead of on every comparison. */
function sim(a: Prep, b: Prep, spellingOnly = false) {
  if (!a.flat || !b.flat) return 0;
  if (a.flat === b.flat) return 1;
  const contained = a.toks.length > 0 && b.toks.length > 0 && (a.toks.every(w => b.toks.includes(w)) || b.toks.every(w => a.toks.includes(w)));
  // Spelling is compared on the distinctive part of each name; the whole name only counts when it is nearly the same ("MD Cosmetics" / "M.D Cosmetic").
  const core = a.core && b.core ? spelling(a.core, b.core) : 0, whole = spelling(a.flat, b.flat);
  // Names made only of shop words ("Shree Agency" / "Shri Agency") are compared whole.
  return Math.max(core, whole >= 0.85 || (!a.core && !b.core) ? whole : 0, contained && !spellingOnly ? 0.85 : 0);
}
export const sameState = (a?: string | null, b?: string | null) => { const x = normName(a || ""), y = normName(b || ""); return !x || !y || x.includes(y) || y.includes(x); };

/** Unlinked DSR DB names, one line per spelling, biggest bookings first. */
export async function loadUnlinked(): Promise<DbName[]> {
  if (!supabase) return [];
  const rows = await fetchAll<Row>((a, b) => supabase!.from("dsr_days").select("db_name,state,town,beat,sale_value,attendance,so_id,day,hq").is("distributor_id", null).not("db_name", "is", null).order("id").range(a, b));
  const m = new Map<string, DbName>();
  rows.forEach(r => {
    const k = normName(r.db_name);
    if (isRemark(r.db_name)) return;
    const e = m.get(k) || { name: r.db_name.trim(), state: r.state || "", towns: new Set<string>(), days: 0, value: 0, score: 0, sos: new Map<string, number>(), beats: new Set<string>(), hqs: new Set<string>(), first: r.day, last: r.day };
    e.days++; e.value += Number(r.sale_value) || 0; if (r.town) e.towns.add(r.town.trim());
    if (r.beat) e.beats.add(r.beat.trim()); if (r.hq) e.hqs.add(r.hq.trim()); e.sos.set(r.so_id, (e.sos.get(r.so_id) || 0) + 1);
    if (r.day < e.first) e.first = r.day; if (r.day > e.last) e.last = r.day;
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
      // The SO who books this name already looks after that distributor: more likely the same one, misspelt.
      if (s >= 0.7 && x.d.so_id && e.sos.has(x.d.so_id)) s += 0.1;
      if (s > score) { score = s; best = x.d; }
    }
    // Two parties in one cell: a match is only ever a suggestion, since it fits one of the two at best.
    if (twoParties(e.name)) score = Math.min(score, 0.9);
    out.push({ ...e, guess: score >= 0.8 ? best : undefined, score });
    if (i % 20 === 19) { task?.step(i + 1, names.length); await breathe(); }
  }
  return out;
}

/** Groups unlinked spellings that are most probably one distributor: nearly the same name (once shop words such as
 *  Enterprises / Store / Sringar are set aside) in the same state, booked by the same SO or in the same town or HQ.
 *  "Omm Santi Enterprise" / "Enterprises", "JMR" / "J.M.R.", "Navya Srinagar Store" / "Navya Sringaar", "Yuraj" / "Yuvraj Store".
 *  Members of a group are put next to each other, biggest group booking first. */
export async function groupAlike(names: DbName[]): Promise<DbName[]> {
  const p = names.map(n => ({ me: prep(n.name), towns: [...n.towns, ...n.hqs].map(prep) }));
  const two = names.map(n => twoParties(n.name));
  const parent = names.map((_, i) => i), why = new Map<number, Set<string>>();
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i], b = names[j];
      if (!sameState(a.state, b.state) || two[i] || two[j]) continue;
      // close: nearly the same spelling. Otherwise one name's words all sit inside the other's ("Vinayak" in "Siddhi Vinayak").
      const close = sim(p[i].me, p[j].me, true), v = close >= 0.8 ? close : sim(p[i].me, p[j].me);
      // Very short distinctive parts ("AK", "RK") must match exactly; longer ones may differ by a letter or two.
      if (v < 0.8 || (Math.min(p[i].me.core.length, p[j].me.core.length) < 4 && v < 1)) continue;
      const so = [...a.sos.keys()].some(id => b.sos.has(id)), town = p[i].towns.some(t => p[j].towns.some(u => sim(t, u) >= 0.8));
      // A shared SO is enough for a near-identical spelling. A name inside a longer one needs the same town too:
      // seniors travel with many SOs, so a shared name alone would join shops in different towns.
      if (close >= 0.8 ? !so && !town : !town) continue;
      const ri = find(i), rj = find(j);
      if (ri !== rj) parent[rj] = ri;
      const w = why.get(find(i)) || new Set<string>(); (why.get(rj) || []).forEach(x => w.add(x));
      if (so) w.add("same SO"); if (town) w.add("same town"); why.set(find(i), w);
    }
    if (i % 40 === 39) await breathe();
  }
  const groups = new Map<number, number[]>();
  names.forEach((_, i) => { const r = find(i); groups.set(r, [...(groups.get(r) || []), i]); });
  const out: DbName[] = [];
  [...groups.entries()].map(([r, ix]) => ({ r, ix, value: ix.reduce((t, i) => t + names[i].value, 0) })).sort((a, b) => b.value - a.value).forEach(g => {
    const label = [...(why.get(g.r) || [])].join(" and ");
    g.ix.sort((a, b) => names[b].value - names[a].value).forEach(i => out.push(g.ix.length > 1 ? { ...names[i], same: g.ix.filter(k => k !== i).map(k => names[k].name), sameWhy: label } : names[i]));
  });
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

/** The location a stock sheet's "DB name" line (and town) points to, when it's close enough to be sure. */
export async function matchHolder(name: string, town: string, locations: Distributor[]): Promise<Distributor | undefined> {
  if (!name.trim()) return undefined;
  const [r] = await suggest([{ name, state: "", towns: new Set(town ? [town] : []), days: 0, value: 0, score: 0, sos: new Map(), beats: new Set(), hqs: new Set(), first: "", last: "" }], locations);
  return r?.guess;
}
