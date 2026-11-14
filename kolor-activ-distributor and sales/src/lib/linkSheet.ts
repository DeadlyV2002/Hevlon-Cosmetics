// The unlinked DSR "DB Name" list as one simple Excel sheet that can be filled in and uploaded back.
// One row per distributor: its name, every spelling of it found in the DSRs, then its details.
import * as XLSX from "xlsx";
import { Distributor, SalesOfficer, matchDistributor, matchSO, proper, properOrNull, cleanPhones, validPhone, missingFields } from "./supabase";
import { normName, cellText } from "./parse";
import { normalizeState } from "./india";
import { guessDetails } from "./batch";
import { DbName } from "./dsrLink";

export const LINK_SHEET = "Distributors to link";
/** The sheet's eight columns, in order. */
const COLS = ["Distributor Name", "Similar Names In DSR", "Super Stockist", "City", "State", "SO", "Owner", "Phone"] as const;
/** Headings accepted on upload, so a column renamed slightly ("Distributor", "Similar Names") is still read. */
const READ: [keyof Row, RegExp][] = [
  ["similar", /similar|names? in dsr|spelling|dsr name/], ["ss", /super ?stockist|^ss( name)?$/], ["city", /^city|town|area/], ["state", /^state$/],
  ["so", /^so( name)?$|^so ase|ase|sales ?officer/], ["owner", /owner|proprietor/], ["phone", /phone|mobile|contact/], ["name", /^distributor( name)?$|^name$|^db( name)?$/],
];
interface Row { name: string; similar: string; ss: string; city: string; state: string; so: string; owner: string; phone: string }
const once = (list: Iterable<string>) => { const seen = new Map<string, string>(); for (const x of list) { const k = normName(x); if (k && !seen.has(k)) seen.set(k, x.trim()); } return [...seen.values()]; };
const label = (c: unknown) => cellText(c as never).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export interface SheetOut { name: string; ws: XLSX.WorkSheet }
/** One row per distributor. The name is filled in only where it is clearly a distributor already in the list;
 *  the rest are left for you to name. City, state and SO come from the DSRs. */
export function buildLinkSheets(names: DbName[], pick: Record<string, string>, locations: Distributor[], officers: SalesOfficer[]): SheetOut[] {
  const byId = new Map(locations.map(l => [l.id, l])), soById = new Map(officers.map(o => [o.id, o])), shown = new Map(names.map(n => [n.name, n]));
  const done = new Set<string>(), rows: Record<string, string>[] = [];
  for (const n of names) {
    if (done.has(n.name)) continue;
    const group = [n, ...(n.same || []).map(x => shown.get(x)).filter((x): x is DbName => !!x && !done.has(x.name))];
    group.forEach(g => done.add(g.name));
    const ids = new Set(group.map(g => pick[g.name]).filter(Boolean)), d = ids.size === 1 ? byId.get([...ids][0]) : undefined;
    const towns = once(group.flatMap(g => [...g.towns])), hqs = once(group.flatMap(g => [...g.hqs]));
    const sos = new Map<string, number>(); group.forEach(g => g.sos.forEach((v, id) => sos.set(id, (sos.get(id) || 0) + v)));
    const topSo = soById.get([...sos].sort((a, b) => b[1] - a[1])[0]?.[0] || "")?.name || "";
    const guess = d ? null : guessDetails(towns[0] || "", topSo, hqs[0] || "", locations, officers);
    rows.push({
      "Distributor Name": d?.name || "", "Similar Names In DSR": group.map(g => g.name).join("; "),
      "Super Stockist": d ? (d.direct ? "Direct" : byId.get(d.parent_id || "")?.name || "") : byId.get(guess?.parent_id || "")?.name || "",
      City: d?.territory || proper(towns[0] || ""), State: d?.state || n.state || "", SO: soById.get(d?.so_id || "")?.name || topSo, Owner: d?.owner_name || "", Phone: d?.phone || "",
    });
  }
  rows.sort((a, b) => `${a.State}|${a.SO}|${a["Similar Names In DSR"]}`.toLowerCase().localeCompare(`${b.State}|${b.SO}|${b["Similar Names In DSR"]}`.toLowerCase()));
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ "Distributor Name": "Every DB name in the DSRs is linked." }], { header: [...COLS] });
  ws["!cols"] = [{ wch: 32 }, { wch: 60 }, { wch: 28 }, { wch: 18 }, { wch: 14 }, { wch: 24 }, { wch: 20 }, { wch: 14 }];
  return [{ name: LINK_SHEET, ws }];
}

export interface NewDist { key: string; payload: Record<string, unknown> & { name: string }; spellings: string[]; missing: string[] }
export interface LinkPlan {
  /** DSR spellings going to a distributor already in the list. */
  links: { db_name: string; d: Distributor }[];
  /** Distributors to add, each with the DSR spellings that will be linked to it. */
  news: NewDist[];
  /** Details the sheet gives for a distributor already in the list, where the software has none: only empty fields are filled. */
  fills: { d: Distributor; patch: Record<string, unknown>; what: string[] }[];
  problems: { name: string; text: string }[];
  /** Rows with no distributor name yet, and spellings that are no longer unlinked (linked since the sheet was made). */
  blank: number; gone: number; days: number; value: number;
}

/** Reads a filled-in sheet against the names that are unlinked right now. Nothing is saved here. */
export function readLinkSheet(wb: XLSX.WorkBook, names: DbName[], locations: Distributor[], officers: SalesOfficer[]): LinkPlan {
  let grid: unknown[][] = [], hr = -1, c = {} as Record<keyof Row, number>;
  for (const sn of wb.SheetNames) {
    const g = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sn], { header: 1, defval: "" });
    const at = g.slice(0, 15).findIndex(r => r.some(x => READ[0][1].test(label(x))) && r.some(x => READ[READ.length - 1][1].test(label(x))));
    if (at < 0) continue;
    grid = g; hr = at;
    const used = new Set<number>();
    c = Object.fromEntries(READ.map(([k, re]) => { const i = g[at].findIndex((x, j) => !used.has(j) && re.test(label(x))); if (i >= 0) used.add(i); return [k, i]; })) as Record<keyof Row, number>;
    break;
  }
  if (hr < 0) {
    const old = wb.SheetNames.some(sn => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sn], { header: 1, defval: "" }).slice(0, 5).some(r => r.some(x => label(x) === "name in dsr")));
    throw new Error(old ? "This is the earlier, longer layout. Download the list again (it is now one simple sheet), fill that in and upload it."
      : `This isn't the distributor list: it needs a "${COLS[0]}" column and a "${COLS[1]}" column. Download the list, fill it in and upload that file.`);
  }
  const byName = new Map(names.map(n => [normName(n.name), n]));
  const dists = locations.filter(l => l.kind !== "GODOWN"), supers = locations.filter(l => l.kind === "SUPER_STOCKIST");
  const plan: LinkPlan = { links: [], news: [], fills: [], problems: [], blank: 0, gone: 0, days: 0, value: 0 };
  const newByKey = new Map<string, NewDist>(), taken = new Set<string>(), filled = new Set<string>();
  for (const r of grid.slice(hr + 1)) {
    const v = (k: keyof Row) => (c[k] >= 0 ? cellText(r[c[k]] as never).trim() : "");
    // The name is kept as you typed it ("JMR Enterprises" stays in capitals); only stray spaces go.
    const name = v("name").replace(/\s+/g, " "), spellText = v("similar");
    if (!name && !spellText) continue;
    if (!name) { plan.blank++; continue; }
    // Every spelling in the row (and the name itself, when the DSRs use it) that is still unlinked.
    const mine: DbName[] = [];
    for (const sp of once([...spellText.split(/[;\n]+/), name])) {
      const n = byName.get(normName(sp));
      if (!n) { if (normName(sp) !== normName(name)) plan.gone++; continue; }
      if (taken.has(normName(sp))) { plan.problems.push({ name: sp, text: `is listed on two rows; it stays with the first one, not with "${name}"` }); continue; }
      taken.add(normName(sp)); mine.push(n);
    }
    const count = () => mine.forEach(n => { plan.days += n.days; plan.value += n.value; });
    const ssText = v("ss"), direct = /^(direct|company|direct with company|ho|head office)$/i.test(ssText), ss = direct || !ssText ? undefined : matchDistributor(ssText, supers);
    const soText = v("so"), topSo = (() => { const m = new Map<string, number>(); mine.forEach(n => n.sos.forEach((d, id) => m.set(id, (m.get(id) || 0) + d))); return officers.find(o => o.id === [...m].sort((a, b) => b[1] - a[1])[0]?.[0]); })();
    const so = (soText ? matchSO(soText, officers) : undefined) ?? topSo;
    const phone = cleanPhones(v("phone")), goodPhone = phone && validPhone(phone) ? phone : "";
    const existing = matchDistributor(name, dists);
    if (existing) {
      mine.forEach(n => plan.links.push({ db_name: n.name, d: existing })); count();
      // The sheet may know things the software doesn't yet: empty fields are filled, nothing already there is changed.
      if (!filled.has(existing.id)) {
        filled.add(existing.id);
        const patch: Record<string, unknown> = {}, what: string[] = [];
        const put = (field: keyof Distributor, value: unknown, word: string) => { if (value && !existing[field]) { patch[field] = value; what.push(word); } };
        put("owner_name", properOrNull(v("owner")), "owner"); put("phone", goodPhone, "phone"); put("territory", properOrNull(v("city")), "city"); put("so_id", soText ? so?.id : undefined, "SO");
        if (existing.kind === "DISTRIBUTOR" && !existing.parent_id && !existing.direct) {
          if (ss) { patch.parent_id = ss.id; patch.super_stockist = ss.name; what.push("super stockist"); }
          else if (direct) { patch.direct = true; patch.super_stockist = "Direct with company"; what.push("super stockist"); }
        }
        if (what.length) plan.fills.push({ d: existing, patch, what });
      }
      continue;
    }
    const key = normName(name), have = newByKey.get(key);
    if (have) { mine.forEach(n => { have.spellings.push(n.name); (have.payload.aliases as string[]).push(n.name); }); count(); continue; }
    const first = mine[0];
    const payload = {
      kind: "DISTRIBUTOR" as const, name, company_name: name, owner_name: properOrNull(v("owner")),
      parent_id: ss?.id || null, super_stockist: direct ? "Direct with company" : ss?.name || null, direct,
      state: normalizeState(v("state") || first?.state || ss?.state || "") || null, region: ss?.region || null, territory: properOrNull(v("city")),
      phone: goodPhone || null, aliases: mine.map(n => n.name).filter(x => normName(x) !== key), so_id: so?.id || null,
    };
    const item: NewDist = { key, payload, spellings: mine.map(n => n.name), missing: missingFields(payload).filter(x => x !== "company name" && x !== "region") };
    if (ssText && !direct && !ss) item.missing.push(`super stockist ("${ssText}" isn't in your list)`);
    if (phone && !goodPhone) item.missing.push("phone (the number in the sheet isn't valid)");
    newByKey.set(key, item); plan.news.push(item); count();
  }
  return plan;
}
