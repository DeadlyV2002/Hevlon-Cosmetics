// The unlinked DSR "DB Name" list as one simple Excel sheet: every spelling the SOs typed on its own row,
// and beside it an empty column for the correct distributor name. Filled in, it is uploaded back.
import * as XLSX from "xlsx";
import { Distributor, SalesOfficer, matchDistributor, matchSO, proper, properOrNull, cleanPhones, validPhone, missingFields } from "./supabase";
import { normName, cellText } from "./parse";
import { normalizeState } from "./india";
import { DbName, nameCore } from "./dsrLink";

export const LINK_SHEET = "Names to correct";
/** The sheet's columns, in order. Only the first two matter; the other three say where the name was seen. */
const COLS = ["Name In DSR", "Correct Distributor Name", "State", "SO", "Town"] as const;
/** Headings accepted on upload. Extra columns you add yourself (Super Stockist, Owner, Phone) are read too. */
const READ: [keyof Row, RegExp][] = [
  ["spelling", /name in dsr|dsr name|similar|spelling|wrong name|mis ?spel/], ["name", /correct|^distributor( name)?$|right name|actual name/],
  ["ss", /super ?stockist|^ss( name)?$/], ["city", /^city|^town|area/], ["state", /^state$/], ["so", /^so( name)?$|^so ase|\base\b|sales ?officer/], ["owner", /owner|proprietor/], ["phone", /phone|mobile|contact/],
];
interface Row { spelling: string; name: string; ss: string; city: string; state: string; so: string; owner: string; phone: string }
const once = (list: Iterable<string>) => { const seen = new Map<string, string>(); for (const x of list) { const k = normName(x); if (k && !seen.has(k)) seen.set(k, x.trim()); } return [...seen.values()]; };
const label = (c: unknown) => cellText(c as never).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export interface SheetOut { name: string; ws: XLSX.WorkSheet }
/** One row per spelling. Rows are in order of state, then of the name with shop words set aside, so spellings of
 *  one distributor ("jmr enterprises", "J.M.R Enterprises", "J M R Enterprise") sit one under the other.
 *  The correct name is filled in only where the spelling clearly is a distributor already in the list. */
export function buildLinkSheets(names: DbName[], pick: Record<string, string>, locations: Distributor[], officers: SalesOfficer[]): SheetOut[] {
  const byId = new Map(locations.map(l => [l.id, l])), soById = new Map(officers.map(o => [o.id, o]));
  const rows = names.map(n => ({
    // A typo early in a name ("Parnjay" for "Pranjay") would send it far down an A to Z list, so spellings the software
    // thinks are one distributor share the first of their names for the order. Nothing else is made of that guess.
    key: `${normName(n.state)}|${[n.name, ...(n.same || [])].map(nameCore).sort()[0]}|${nameCore(n.name)}|${normName(n.name)}`,
    row: {
      "Name In DSR": n.name, "Correct Distributor Name": byId.get(pick[n.name] || "")?.name || "", State: n.state || "",
      SO: soById.get([...n.sos].sort((a, b) => b[1] - a[1])[0]?.[0] || "")?.name || "", Town: proper(once(n.towns)[0] || ""),
    },
  })).sort((a, b) => a.key.localeCompare(b.key)).map(x => x.row);
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ "Name In DSR": "Every DB name in the DSRs is linked." }], { header: [...COLS] });
  ws["!cols"] = [{ wch: 44 }, { wch: 36 }, { wch: 14 }, { wch: 24 }, { wch: 20 }];
  return [{ name: LINK_SHEET, ws }];
}

export interface NewDist { key: string; payload: Record<string, unknown> & { name: string }; spellings: string[]; missing: string[] }
export interface LinkPlan {
  /** DSR spellings going to a distributor already in the list. */
  links: { db_name: string; d: Distributor }[];
  /** Correct names that aren't in the list yet: added as distributors, with the spellings attached to them. */
  news: NewDist[];
  /** Details the sheet gives for a distributor already in the list, where the software has none: only empty fields are filled. */
  fills: { d: Distributor; patch: Record<string, unknown>; what: string[] }[];
  problems: { name: string; text: string }[];
  /** Rows with no correct name yet, and spellings that are no longer unlinked (linked since the sheet was made). */
  blank: number; gone: number; days: number; value: number;
}

/** Reads a filled-in sheet against the names that are unlinked right now. Nothing is saved here. */
export function readLinkSheet(wb: XLSX.WorkBook, names: DbName[], locations: Distributor[], officers: SalesOfficer[]): LinkPlan {
  let grid: unknown[][] = [], hr = -1, c = {} as Record<keyof Row, number>;
  for (const sn of wb.SheetNames) {
    const g = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sn], { header: 1, defval: "" });
    const at = g.slice(0, 15).findIndex(r => r.some(x => READ[0][1].test(label(x))) && r.some(x => READ[1][1].test(label(x))));
    if (at < 0) continue;
    grid = g; hr = at;
    const used = new Set<number>();
    c = Object.fromEntries(READ.map(([k, re]) => { const i = g[at].findIndex((x, j) => !used.has(j) && re.test(label(x))); if (i >= 0) used.add(i); return [k, i]; })) as Record<keyof Row, number>;
    break;
  }
  if (hr < 0) throw new Error(`This isn't the names list: it needs a "${COLS[0]}" column and a "${COLS[1]}" column. Download the list, fill in the correct names and upload that file.`);
  const byName = new Map(names.map(n => [normName(n.name), n]));
  const dists = locations.filter(l => l.kind !== "GODOWN"), supers = locations.filter(l => l.kind === "SUPER_STOCKIST");
  const plan: LinkPlan = { links: [], news: [], fills: [], problems: [], blank: 0, gone: 0, days: 0, value: 0 };
  const newByKey = new Map<string, NewDist>(), taken = new Set<string>(), filled = new Set<string>();
  for (const r of grid.slice(hr + 1)) {
    const v = (k: keyof Row) => (c[k] >= 0 ? cellText(r[c[k]] as never).trim() : "");
    // The correct name is kept as you typed it ("JMR Enterprises" stays in capitals); only stray spaces go.
    const name = v("name").replace(/\s+/g, " "), spellText = v("spelling");
    if (!name && !spellText) continue;
    if (!name) { plan.blank++; continue; }
    // Usually one spelling a row; several in one cell, separated by ";", are read too.
    const mine: DbName[] = [];
    for (const sp of once(spellText.split(/[;\n]+/))) {
      const n = byName.get(normName(sp));
      if (!n) { plan.gone++; continue; }
      if (taken.has(normName(sp))) { plan.problems.push({ name: sp, text: `is on two rows of the sheet; it stays with the first one, not with "${name}"` }); continue; }
      taken.add(normName(sp)); mine.push(n);
    }
    const count = () => mine.forEach(n => { plan.days += n.days; plan.value += n.value; });
    const ssText = v("ss"), direct = /^(direct|company|direct with company|ho|head office)$/i.test(ssText), ss = direct || !ssText ? undefined : matchDistributor(ssText, supers);
    const soText = v("so"), so = soText ? matchSO(soText, officers) : undefined;
    const phone = cleanPhones(v("phone")), goodPhone = phone && validPhone(phone) ? phone : "";
    const existing = matchDistributor(name, dists);
    if (existing) {
      mine.forEach(n => plan.links.push({ db_name: n.name, d: existing })); count();
      // Owner, phone or super stockist typed in the sheet go in where the software has none; nothing already there is changed.
      if (!filled.has(existing.id)) {
        filled.add(existing.id);
        const patch: Record<string, unknown> = {}, what: string[] = [];
        const put = (field: keyof Distributor, value: unknown, word: string) => { if (value && !existing[field]) { patch[field] = value; what.push(word); } };
        put("owner_name", properOrNull(v("owner")), "owner"); put("phone", goodPhone, "phone");
        if (existing.kind === "DISTRIBUTOR" && !existing.parent_id && !existing.direct) {
          if (ss) { patch.parent_id = ss.id; patch.super_stockist = ss.name; what.push("super stockist"); }
          else if (direct) { patch.direct = true; patch.super_stockist = "Direct with company"; what.push("super stockist"); }
        }
        if (what.length) plan.fills.push({ d: existing, patch, what });
      }
      continue;
    }
    const key = normName(name), have = newByKey.get(key);
    if (have) { mine.forEach(n => { have.spellings.push(n.name); if (normName(n.name) !== key) (have.payload.aliases as string[]).push(n.name); }); count(); continue; }
    if (!mine.length) { continue; }
    const first = mine[0];
    const payload = {
      kind: "DISTRIBUTOR" as const, name, company_name: name, owner_name: properOrNull(v("owner")),
      parent_id: ss?.id || null, super_stockist: direct ? "Direct with company" : ss?.name || null, direct,
      state: normalizeState(v("state") || first.state || ss?.state || "") || null, region: ss?.region || null, territory: properOrNull(v("city")) || properOrNull(once(first.towns)[0] || ""),
      phone: goodPhone || null, aliases: mine.map(n => n.name).filter(x => normName(x) !== key),
      so_id: so?.id || [...first.sos].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    };
    const item: NewDist = { key, payload, spellings: mine.map(n => n.name), missing: missingFields(payload).filter(x => x !== "company name" && x !== "region") };
    if (ssText && !direct && !ss) item.missing.push(`super stockist ("${ssText}" isn't in your list)`);
    if (phone && !goodPhone) item.missing.push("phone (the number in the sheet isn't valid)");
    newByKey.set(key, item); plan.news.push(item); count();
  }
  return plan;
}
