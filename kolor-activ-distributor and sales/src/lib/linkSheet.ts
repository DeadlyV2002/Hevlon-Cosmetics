// The unlinked DSR "DB Name" list as an Excel sheet that can be filled in and uploaded back:
// each row is linked to a distributor already in the list, or made into a new distributor and linked.
import * as XLSX from "xlsx";
import { Distributor, SalesOfficer, matchDistributor, matchSO, proper, properOrNull, cleanPhones, validPhone, missingFields } from "./supabase";
import { normName, cellText } from "./parse";
import { normalizeState } from "./india";
import { guessDetails } from "./batch";
import { DbName } from "./dsrLink";
import { dmy } from "./dates";

export const LINK_SHEET = "Unlinked DB names";
/** Column headings. The first is the key and must be left as it is; the "fill in" ones are read back on upload. */
const H = {
  name: "Name In DSR", state: "State", towns: "Towns", beats: "Beats", hq: "HQ", by: "Booked By", days: "Days", first: "First Day", last: "Last Day", value: "Booked ₹",
  same: "Likely Same As", sameWhy: "Same Because",
  sugg: "Suggested Distributor", suggCode: "Suggested Code", match: "Match",
  link: "Link To (Code Or Name)",
  newName: "New Distributor Name", company: "Company Name", owner: "Owner Name", phone: "Phone", ss: "Super Stockist", newState: "New State", region: "Region", city: "City / Area", so: "SO / ASE",
} as const;
const once = (list: Iterable<string>) => { const seen = new Map<string, string>(); for (const x of list) { const k = normName(x); if (k && !seen.has(k)) seen.set(k, x.trim()); } return [...seen.values()]; };

export interface SheetOut { name: string; ws: XLSX.WorkSheet }
/** The list to fill in, how to fill it, and the distributor list to look codes up in. */
export function buildLinkSheets(names: DbName[], pick: Record<string, string>, locations: Distributor[], officers: SalesOfficer[], sure: number): SheetOut[] {
  const byId = new Map(locations.map(l => [l.id, l])), soById = new Map(officers.map(o => [o.id, o]));
  const rows = names.map(n => {
    const towns = once(n.towns), hqs = once(n.hqs), people = [...n.sos].sort((a, b) => b[1] - a[1]).map(([id]) => soById.get(id)?.name).filter(Boolean) as string[];
    const chosen = pick[n.name] ? byId.get(pick[n.name]) : undefined;
    const g = guessDetails(towns[0] || "", people[0] || "", hqs[0] || "", locations, officers), ss = g.parent_id ? byId.get(g.parent_id) : undefined;
    return {
      [H.name]: n.name, [H.state]: n.state, [H.towns]: towns.join(", "), [H.beats]: once(n.beats).slice(0, 15).join(", "), [H.hq]: hqs.join(", "), [H.by]: people.join(", "),
      [H.days]: n.days, [H.first]: n.first ? dmy(n.first) : "", [H.last]: n.last ? dmy(n.last) : "", [H.value]: Math.round(n.value),
      [H.same]: (n.same || []).join("; "), [H.sameWhy]: n.sameWhy || "",
      [H.sugg]: n.guess?.name || "", [H.suggCode]: n.guess?.code || "", [H.match]: n.guess ? (n.score >= sure ? "close" : "weak: check") : "none",
      // Filled in already where the match is close (or you chose one on screen); clear it if it's wrong.
      [H.link]: chosen?.code || "",
      // Hints for a new distributor; they count only when a New Distributor Name is typed.
      [H.newName]: "", [H.company]: "", [H.owner]: "", [H.phone]: "", [H.ss]: ss?.name || "", [H.newState]: n.state || g.state, [H.region]: g.region || hqs[0] || "", [H.city]: proper(towns[0] || ""), [H.so]: people[0] || "",
    };
  });
  const list = XLSX.utils.json_to_sheet(rows.length ? rows : [{ [H.name]: "Every DB name in the DSRs is linked." }]);
  list["!cols"] = Object.values(H).map(h => ({ wch: h === H.name || h === H.sugg || h === H.newName || h === H.beats || h === H.towns || h === H.same ? 30 : h === H.link ? 24 : 16 }));
  const how = XLSX.utils.aoa_to_sheet([
    ["How to fill this sheet"],
    [`1. Don't change the "${H.name}" column: it is how each row is matched when you upload the sheet.`],
    [`2. If the name is a distributor already in your list: type its code (D123) or its exact name in "${H.link}". Codes are on the "Distributor list" sheet. Close matches are filled in already: check them, and clear any that are wrong.`],
    [`3. If it is a distributor that isn't in your list yet: leave "${H.link}" empty and type its name in "${H.newName}". Fill what you know of Company, Owner, Phone, Super Stockist (or type Direct), State, Region, City and SO. Super Stockist is needed; the rest can be completed later on the Distributors page.`],
    ["4. Two spellings of the same new distributor: give both rows the same New Distributor Name. It is added once and both spellings are linked to it."],
    [`5. "${H.same}" lists other spellings that are most probably the same distributor (a typo, an added "s", dots in initials) because the same SO books them or they are in the same town. They sit on the next rows: give them the same Link To code, or the same New Distributor Name.`],
    ["6. Leave a row's Link To and New Distributor Name both empty to skip it for now."],
    ["7. Save the file and upload it with Upload Filled Sheet on SO Reports > Stock Checks. You check a summary before anything is saved."],
  ]);
  how["!cols"] = [{ wch: 160 }];
  const dists = locations.filter(l => l.kind !== "GODOWN").sort((a, b) => `${a.state} ${a.territory} ${a.name}`.localeCompare(`${b.state} ${b.territory} ${b.name}`)).map(d => ({
    Code: d.code, Name: d.name, Kind: d.kind === "SUPER_STOCKIST" ? "Super stockist" : "Distributor", "City / Area": d.territory || "", Region: d.region || "", State: d.state || "",
    "Super Stockist": d.direct ? "Direct with company" : byId.get(d.parent_id || "")?.name || "", "SO / ASE": soById.get(d.so_id || "")?.name || "", Owner: d.owner_name || "", Phone: d.phone || "", "Other Names": (d.aliases || []).join(", "),
  }));
  const ref = XLSX.utils.json_to_sheet(dists);
  ref["!cols"] = [{ wch: 8 }, { wch: 32 }, { wch: 14 }, { wch: 18 }, { wch: 16 }, { wch: 14 }, { wch: 28 }, { wch: 22 }, { wch: 20 }, { wch: 16 }, { wch: 40 }];
  return [{ name: LINK_SHEET, ws: list }, { name: "How to fill", ws: how }, { name: "Distributor list", ws: ref }];
}

export interface NewDist { key: string; payload: Record<string, unknown> & { name: string }; spellings: string[]; missing: string[] }
export interface LinkPlan {
  /** DSR spellings going to a distributor already in the list. */
  links: { db_name: string; d: Distributor }[];
  /** Distributors to add, each with the DSR spellings that will be linked to it. */
  news: NewDist[];
  problems: { name: string; text: string }[];
  /** Rows left empty, and rows whose DSR name is no longer in the unlinked list (linked since the sheet was made). */
  blank: number; gone: number; days: number; value: number;
}

/** Reads a filled-in sheet against the names that are unlinked right now. Nothing is saved here. */
export function readLinkSheet(wb: XLSX.WorkBook, names: DbName[], locations: Distributor[], officers: SalesOfficer[]): LinkPlan {
  const sheetName = wb.SheetNames.find(s => normName(s) === normName(LINK_SHEET)) ?? wb.SheetNames.find(s => { const a = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[s], { header: 1, defval: "" }); return a.slice(0, 10).some(r => r.some(c => normName(cellText(c as never)) === normName(H.name))); });
  if (!sheetName) throw new Error(`This isn't the unlinked DB names sheet: no "${H.name}" column was found. Use Export List To Excel, fill that file in, and upload it.`);
  const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, defval: "" });
  const hr = grid.findIndex(r => r.some(c => normName(cellText(c as never)) === normName(H.name)));
  const col = (h: string) => grid[hr].findIndex(c => normName(cellText(c as never)) === normName(h));
  const c = Object.fromEntries(Object.entries(H).map(([k, h]) => [k, col(h)])) as Record<keyof typeof H, number>;
  const byName = new Map(names.map(n => [normName(n.name), n]));
  const dists = locations.filter(l => l.kind !== "GODOWN"), supers = locations.filter(l => l.kind === "SUPER_STOCKIST");
  const plan: LinkPlan = { links: [], news: [], problems: [], blank: 0, gone: 0, days: 0, value: 0 };
  const newByKey = new Map<string, NewDist>(), done = new Set<string>();
  for (const r of grid.slice(hr + 1)) {
    const v = (k: keyof typeof H) => (c[k] >= 0 ? cellText(r[c[k]] as never).trim() : "");
    const raw = v("name");
    if (!raw) continue;
    const n = byName.get(normName(raw));
    const linkTo = v("link"), newName = proper(v("newName"));
    if (!linkTo && !newName) { plan.blank++; continue; }
    if (!n) { plan.gone++; continue; }
    if (done.has(normName(raw))) { plan.problems.push({ name: raw, text: "listed twice in the sheet; the first row is used" }); continue; }
    done.add(normName(raw));
    const count = () => { plan.days += n.days; plan.value += n.value; };
    if (linkTo) {
      const d = matchDistributor(linkTo, dists);
      if (!d) { plan.problems.push({ name: raw, text: `"${linkTo}" isn't a distributor code or name in your list. Check the code on the Distributor list sheet, or put the name under New Distributor Name to add it.` }); continue; }
      plan.links.push({ db_name: n.name, d }); count(); continue;
    }
    // A "new" name that is already in the list is simply linked to it.
    const existing = matchDistributor(newName, dists);
    if (existing) { plan.links.push({ db_name: n.name, d: existing }); count(); continue; }
    const key = normName(newName), have = newByKey.get(key);
    if (have) { have.spellings.push(n.name); (have.payload.aliases as string[]).push(n.name); count(); continue; }
    const ssText = v("ss"), direct = /^(direct|company|direct with company|ho|head office)$/i.test(ssText), ss = direct ? undefined : matchDistributor(ssText, supers);
    if (!direct && !ss) { plan.problems.push({ name: raw, text: ssText ? `super stockist "${ssText}" isn't in your list (type its code or exact name, or Direct)` : "a new distributor needs its Super Stockist (or Direct)" }); done.delete(normName(raw)); continue; }
    const soText = v("so"), so = (soText ? matchSO(soText, officers) : undefined) ?? officers.find(o => o.id === [...n.sos].sort((a, b) => b[1] - a[1])[0]?.[0]);
    const phone = cleanPhones(v("phone"));
    const payload = {
      kind: "DISTRIBUTOR" as const, name: newName, company_name: proper(v("company")) || newName, owner_name: properOrNull(v("owner")),
      parent_id: ss?.id || null, super_stockist: direct ? "Direct with company" : ss!.name, direct,
      state: normalizeState(v("newState") || n.state || ss?.state || "") || null, region: properOrNull(v("region")) || ss?.region || null, territory: properOrNull(v("city")),
      phone: phone && validPhone(phone) ? phone : null, aliases: normName(n.name) === key ? [] as string[] : [n.name], so_id: so?.id || null,
    };
    const item: NewDist = { key, payload, spellings: [n.name], missing: missingFields(payload) };
    if (phone && !validPhone(phone)) item.missing.push("phone (the number in the sheet isn't valid)");
    newByKey.set(key, item); plan.news.push(item); count();
  }
  return plan;
}
