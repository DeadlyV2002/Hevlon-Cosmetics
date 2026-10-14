// Checks a batch of stock files before anything is saved: what each file is, whose stock it is,
// and the stock date, so new distributors can be added and doubtful matches settled in one place.
import { Distributor, SalesOfficer, matchDistributor, matchSO, proper } from "./supabase";
import { readAnyFile } from "./readers";
import { readPrimary } from "./primary";
import { detectFile, readSheetInfo, FileType } from "./detect";
import { detectLayout, titleText, headingDate, normName } from "./parse";
import { matchHolder, nameScore } from "./dsrLink";
import { closeLocation, similarity } from "./fuzzy";

/** A likely location name from a stock file's name: drops "DB", "closing stock", months and dates. */
export function nameFromFile(file: string) {
  const words = file.replace(/\.[a-z0-9]+$/i, "").replace(/[_\-.()&]+/g, " ").split(/\s+/).filter(Boolean)
    .filter(w => !/^(db|ss|closing|stocks?|stoks?|stoke|statement|format|report|month|of|and|the|\d+|jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)$/i.test(w));
  return proper(words.join(" "));
}
/** Identifies one chosen file across the batch check and the save queue. */
export const fileKey = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;

export interface Scan {
  key: string; file: File;
  type: FileType | "BILLING" | "ERROR"; error?: string;
  /** Whose stock, as the sheet (or, failing that, the file name) gives it. */
  name: string; fromFileName: boolean;
  town: string; person: string; hq: string;
  /** Stock date found in the sheet or file name, "" when there is none. */
  date: string;
  match?: Distributor; score: number;
  /** matched: sure; check: a likely match to confirm; new: not in the list; none: no distributor needed (SO reports). */
  status: "matched" | "check" | "new" | "none";
  note: string;
}

export async function scanFile(f: File, locations: Distributor[], officers: SalesOfficer[]): Promise<Scan> {
  const base: Scan = { key: fileKey(f), file: f, type: "ERROR", name: "", fromFileName: false, town: "", person: "", hq: "", date: "", score: 0, status: "none", note: "" };
  try {
    const t = await readAnyFile(f);
    if (!t.sheets.length) return { ...base, error: "the file is empty" };
    const pr = readPrimary(t.sheets, f.name);
    const supers = locations.filter(l => l.kind === "SUPER_STOCKIST");
    if (pr && pr.invoices.length > 0 && (pr.wide ? pr.items.length >= 3 : pr.invoices.filter(i => matchDistributor(i.ss, supers)).length >= pr.invoices.length / 2))
      return { ...base, type: "BILLING", note: `company billing: ${pr.invoices.length} invoices to ${new Set(pr.invoices.map(i => i.ss)).size} super stockists` };
    const g = t.sheets[0].grid, l0 = detectLayout(g, "COUNT"), heading = titleText(g, l0);
    const det = detectFile(g, l0, heading, f.name, locations, officers);
    const info = readSheetInfo(g, l0.headerRow);
    const out: Scan = { ...base, type: det.type, town: proper(info.town), person: info.person, hq: proper(info.hq), date: headingDate(`${heading} ${f.name}`) };
    if (l0.headerRow < 0) out.note = "column headings not found: it will open for you to set the columns";
    if (det.type === "SO") return { ...out, status: "none", note: out.note || "SO daily report: no distributor needed" };

    const pool = locations.filter(l => l.kind !== "GODOWN");
    let name = info.name, match: Distributor | undefined, score = 0, fromFileName = false;
    if (name) {
      match = matchDistributor(name, pool);
      if (match) score = 1;
      else {
        const g2 = await matchHolder(name, info.town, pool);
        if (g2) { match = g2; score = nameScore(name, g2); }
        else { const c = closeLocation(name, pool, undefined, info.town); if (c) { match = c; score = 0.85; } }
      }
    } else {
      const byHeading = locations.find(l => l.code === det.holder);
      if (byHeading) { match = byHeading; score = 0.95; name = byHeading.name; }
      else {
        name = nameFromFile(f.name); fromFileName = true;
        if (name) { const g2 = await matchHolder(name, "", pool); if (g2) { match = g2; score = Math.min(0.85, nameScore(name, g2)); } }
      }
    }
    // The same name in another town is more likely a different business.
    const otherTown = !!(match && info.town && match.territory && similarity(info.town, match.territory) < 0.75);
    // A different name in a different town is a new business; the same name in another town is worth asking about.
    const status = !match || (otherTown && score < 0.95) ? "new" : score >= 0.92 && !otherTown ? "matched" : "check";
    const note = [out.note, otherTown && status === "check" ? `${match!.name} is in ${match!.territory}, the sheet says ${proper(info.town)}` : "", fromFileName ? "the sheet doesn't name its distributor; the name comes from the file name" : ""].filter(Boolean).join("; ");
    return { ...out, name: proper(name), fromFileName, match: status === "new" ? undefined : match, score, status, note };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Details for a new distributor, from the distributors already in the same town (or served by the same SO). */
export function guessDetails(town: string, person: string, hq: string, locations: Distributor[], officers: SalesOfficer[]) {
  const so = person ? matchSO(person, officers) : undefined;
  const dists = locations.filter(l => l.kind === "DISTRIBUTOR");
  const near = town ? dists.filter(l => l.territory && (normName(l.territory) === normName(town) || similarity(l.territory, town) >= 0.85)) : [];
  const pool = near.length ? near : so ? dists.filter(l => l.so_id === so.id) : [];
  const top = (f: (l: Distributor) => string | null | undefined) => {
    const m = new Map<string, number>();
    pool.forEach(l => { const v = f(l); if (v) m.set(v, (m.get(v) || 0) + 1); });
    return [...m].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
  };
  const parent_id = top(l => l.parent_id);
  const parent = locations.find(l => l.id === parent_id);
  return {
    state: top(l => l.state) || so?.state || parent?.state || "",
    region: top(l => l.region) || hq || parent?.region || "",
    parent_id, so_id: so?.id || "",
    why: near.length ? `from the ${near.length} distributor${near.length > 1 ? "s" : ""} already in ${town}` : so ? `from ${so.name}'s other distributors` : "",
  };
}
