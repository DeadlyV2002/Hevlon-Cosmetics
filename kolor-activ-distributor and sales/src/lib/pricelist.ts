// Reads the company price list (KA Price List: a heading row per section, "S.S.Cost Price" per dozen, "Mrp." per piece)
// and finds the software's SKU for each line. Rates come only from here, never from stock files.
import { Grid, cellText, normName, parseNum } from "./parse";
import { Product, ProductAlias, matchProduct } from "./supabase";
import { sameProductName, similarity } from "./fuzzy";

export interface PriceRow { section: string; name: string; ss: number; mrp: number | null }

const SS_HEAD = /\bs\.?\s*s\.?\s*(cost|rate|landing)|\bss\s*(rate|price)|cost price|landing price|\bss\b/i;
/** Every priced line, with the section heading it sits under ("Nail Polish", "Lipstick"…). */
export function readPriceList(grid: Grid): PriceRow[] {
  const out: PriceRow[] = [];
  let section = "", cName = -1, cSs = -1, cMrp = -1;
  for (const row of grid) {
    const cells = row.map(c => cellText(c));
    const ss = cells.findIndex(t => SS_HEAD.test(t));
    if (ss >= 0) {
      // A heading row: the product names sit under the first column unless one is labelled.
      section = cells[0] && ss !== 0 ? cells[0] : section;
      const named = cells.findIndex(t => /^(product|item|name|sku|particulars)/i.test(t));
      cName = named >= 0 ? named : 0; cSs = ss; cMrp = cells.findIndex(t => /^mrp/i.test(t));
      continue;
    }
    if (cSs < 0) continue;
    const name = (cells[cName] || "").trim(), rate = parseNum(row[cSs]);
    if (!name || rate === null || !(rate > 0)) continue;
    const mrp = cMrp >= 0 ? parseNum(row[cMrp]) : null;
    out.push({ section, name, ss: Math.round(rate * 100) / 100, mrp: mrp && mrp > 0 ? mrp : null });
  }
  return out;
}

/** The software's categories a price-list section covers. */
function sectionCats(section: string): string[] {
  const s = section.toLowerCase();
  if (/remover|npr/.test(s)) return ["NPR"];
  if (/nail/.test(s)) return ["Nail Paint"];
  if (/liquid lip|lip colou?r|lipcolou?r/.test(s)) return ["Liquid Lipstick"];
  if (/lipstick/.test(s)) return ["Stick Lipstick"];
  if (/eye ?liner|mascara/.test(s)) return ["Eye"];
  if (/eye ?shadow|kit|blush/.test(s)) return ["Eye Shadow"];
  if (/kajal/.test(s)) return ["Eye Shadow"];
  if (/compact|foundation/.test(s)) return ["Compact"];
  if (/makeup|make up/.test(s)) return ["Makeup"];
  if (/rose|aloe|moistur|cleansing/.test(s)) return ["Rose Water", "Aloevera Gel", "Cleansing Milk", "Lotion"];
  if (/lip balm|glycer/.test(s)) return ["Lip Care"];
  if (/sindoor/.test(s)) return ["Sindoor"];
  if (/cotton/.test(s)) return ["Cotton Buds"];
  return [];
}
const words = (s: string) => normName(s.replace(/\(.*?\)|\d+(\.\d+)?\s*(ml|gm|g|pcs?|s)\b|\d+\s*x\s*\d+|\bkolor\b|\bactiv\b|^ka\b|\bmrp\b|\d+\s*\/-/gi, " ")).split(" ")
  .filter(w => w.length > 1 && !/^(the|new|pack|with|box|jar|tube|pump|stems|lip|colou?r|lipcolou?r|lipstick|nail|paint|polish|mix|red|mrn|maroon|non|transfer|0)$/.test(w));
const sizes = (s: string) => (s.toLowerCase().replace(/(\d+(\.\d+)?)\s*(ml|gm|g)\b/g, (_, n) => ` ${Number(n)}sz `).match(/\d+(\.\d+)?sz|\d+\s*x\s*\d+/g) || []).map(x => x.replace(/\s/g, ""));
const wordLike = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a))) || (Math.min(a.length, b.length) >= 4 && similarity(a, b) >= 0.75);

/** The SKU a price-list line is: the same name or a remembered other name, else the closest name in the section's category. */
export function matchPriceRow(row: PriceRow, products: Product[], aliases: ProductAlias[]): Product | undefined {
  const cats = sectionCats(row.section);
  const inCat = (p: Product) => !cats.length || cats.includes(p.category || "");
  const exact = matchProduct("", row.name, products, aliases);
  if (exact && inCat(exact)) return exact;
  // Eyeliner and Mascara share names ("Glam storke", "My charm 2ml jar"): the section says which.
  const extra = /eye ?liner/i.test(row.section) ? ["eyeliner"] : /mascara/i.test(row.section) ? ["mascara", "maskara"] : [];
  const pw = [...words(row.name), ...extra.slice(0, 1)], ps = sizes(row.name);
  if (!pw.length) return undefined;
  let best: Product | undefined, score = 0;
  for (const p of products) {
    if (!inCat(p) || p.category === "POP") continue;
    const sw = words(p.item_name); if (!sw.length) continue;
    const hit = pw.filter(w => sw.some(v => wordLike(w, v)) || (extra.includes(w) && extra.some(e => sw.includes(e)))).length, back = sw.filter(v => pw.some(w => wordLike(w, v))).length;
    let x = (hit / pw.length) * 0.7 + (back / sw.length) * 0.3;
    const qs = sizes(p.item_name); if (ps.length && qs.length && !ps.some(z => qs.includes(z))) x -= 0.4;
    if (sameProductName(row.name, p.item_name)) x += 0.1;
    // The clean name over a Tally-style copy of it.
    if (/^kolor activ/i.test(p.item_name)) x -= 0.05;
    if (x > score) { score = x; best = p; }
  }
  return score >= 0.7 ? best : undefined;
}
