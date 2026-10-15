// Reads a Tally stock line as SKU + shade: "Kolor Activ Lipcolor Wild Rose 13 , 219/-Pcs" is Wild Rose, shade 13;
// "Kolor Activ Lipcolor Bare Kiss 3.6ml Mrn 189/-Pcs" is Bare Kiss, shade Maroon. Brand, product type, size, MRP and
// "(Pcs)" are dropped; what is left after the SKU's own words is the shade (A and B are shade-set boxes).
import { typoDistance } from "./fuzzy";
import { normName } from "./parse";

export interface SkuLike { id: string; item_name: string; sku: string; category?: string | null; mrp?: number | null }
export interface TallyMatch<P> { product: P; shade: string; old: boolean; sure: boolean; why: string }

/** Product-type words: they say which category, but aren't part of the SKU's own name. */
const TYPES: [RegExp, string[]][] = [
  [/\b(lip ?colou?r|lipcolor|lip gloss|lip shine|lip oil)\b/, ["Liquid Lipstick"]],
  [/\blipstick\b/, ["Stick Lipstick"]],
  [/\bnail paint\b|\bnail polish\b/, ["Nail Paint"]],
  [/\bnail cleanser\b|\bnpr\b|\bwipes\b/, ["NPR"]],
  [/\bcompact\b|\bfoundation\b|\billuminator\b/, ["Compact"]],
  [/\beye ?shadow\b|\bblush on\b|\bkajal\b|\beyebrow\b/, ["Eye Shadow"]],
  [/\beye ?liner\b|\bmascara\b|\bmaskara\b/, ["Eye"]],
  [/\bsindoor\b/, ["Sindoor"]],
  [/\blip balm\b|\bglycerine?\b/, ["Lip Care"]],
  [/\brose water\b/, ["Rose Water"]],
  [/\baloe ?vera\b/, ["Aloevera Gel"]],
  [/\bcleansing milk\b/, ["Cleansing Milk"]],
  [/\bmoisturi[sz]ing\b/, ["Lotion"]],
  [/\bprimer\b|\bfixer\b|\bconcealer\b|\bremover\b|\bhighlighter\b|\bpuff\b/, ["Makeup"]],
  [/\bcotton\b/, ["Cotton Buds"]],
];
/** Never part of a SKU's identity: brand, packing, price notes. */
const BRAND = new Set("kolor activ ka pcs pc mrp new the with no rs rate box old trufit paper".split(" "));
/** Product-type words: part of a SKU's name only when the name has nothing else ("Eye Shadow 9x1", "Primer 30ml"). */
const FILLER = new Set("lip colour color lipcolor lipcolour lipstick nail paint polish compact foundation eyeshadow eye shadow eyeliner mascara kajal sindoor liquid powder stick balm gloss shine oil cleanser primer base face pack".split(" "));
const SHADE_WORDS: Record<string, string> = { mrn: "Maroon", maroon: "Maroon", red: "Red", nat: "Natural", natural: "Natural", fair: "Fair", blush: "Blush", skin: "Skin", nude: "Nude", pink: "Pink", mix: "Mix", rm: "Red + Maroon" };

/** Words of a name with prices, MRP, "(Pcs)" and dozens-per-box notes taken out; sizes ("3.6ml", "9x1", "14gm") kept apart. */
function pieces(raw: string) {
  const s = raw.toLowerCase()
    .replace(/eye\s*shadow/g, "eyeshadow").replace(/lip\s*colou?r/g, "lipcolor").replace(/eye\s*liner/g, "eyeliner").replace(/maskara/g, "mascara")
    .replace(/glycerine/g, "glycerin").replace(/(\d)\s*in\s*(\d)/g, "$1x$2").replace(/r\s*\+\s*m\b/g, " rm ")
    .replace(/\bmrp\b\.?/g, " ").replace(/\brs\.?\s*\d*/g, " ").replace(/\d+\s*\/-?|\/-/g, " ").replace(/\b\d{2,4}\s*-\s*pcs\b/g, " ")
    .replace(/\(?\b\d*\s*pcs?\b\)?/g, " ").replace(/\(?\b\d+\s*dz\b\)?/g, " ")
    .replace(/(\d+(\.\d+)?)\s*(ml|gm|g|mg)\b/g, (_, n) => ` ${Number(n)}sz `).replace(/(\d+)\s*x\s*(\d+)/g, " $1x$2 ");
  const toks = s.replace(/[^a-z0-9. ]/g, " ").replace(/(^|\s)\.+(?=\s|$)/g, " ").split(/\s+/).filter(Boolean).map(t => t.replace(/\.+$/, ""));
  const isSize = (t: string) => /sz$|^\d+x\d+$/.test(t);
  return { sizes: toks.filter(isSize), boxes: toks.filter(t => /^\d+x\d+$/.test(t)), words: toks.filter(t => t && !isSize(t)) };
}
const stem = (w: string) => (w.length > 4 ? w.replace(/s$/, "") : w);
const alike = (a: string, b: string) => {
  const x = stem(a), y = stem(b);
  // "Mat" for "Matte": a short form of three letters or more.
  return x === y || (Math.min(x.length, y.length) >= 3 && (x.startsWith(y) || y.startsWith(x))) || (Math.min(x.length, y.length) >= 4 && typoDistance(x, y) <= (Math.max(x.length, y.length) >= 7 ? 2 : 1));
};
/** Colour words in a SKU's own name are its shade, not its identity ("KA Lipstick Ultra Matte Maroon" is Ultra Matte). */
const COLOUR = new Set(["mrn", "maroon", "red", "nude", "mix", "rm"]);

/** The SKU and shade of a Tally line. `sure` is false when two SKUs fit about equally well or only a generic name fits. */
export function matchTallyLine<P extends SkuLike>(line: string, products: P[], aliases: { product_id: string; alias: string }[] = []): TallyMatch<P> | null {
  const cats = TYPES.filter(([re]) => re.test(line.toLowerCase())).flatMap(([, c]) => c);
  const lp = pieces(line);
  const old = /\bold\b/i.test(line);
  const lineAll = lp.words.filter(w => !BRAND.has(w));
  const matchable = lineAll.filter(w => w.length > 1 || /^\d+$/.test(w));
  const names = (p: P) => [p.item_name, p.sku, ...aliases.filter(a => a.product_id === p.id).map(a => a.alias)];
  let best: { p: P; used: Set<string>; score: number } | null = null, second = 0;
  for (const p of products) {
    if (p.category === "POP") continue;
    for (const n of names(p)) {
      const np = pieces(n), core = np.words.filter(w => !BRAND.has(w) && !COLOUR.has(w) && w.length > 1 && !/^\d+$/.test(w));
      const dist = core.filter(w => !FILLER.has(w)), generic = !dist.length, sw = generic ? core : dist;
      if (!sw.length) continue;
      // "9x1", "2x1": a box size in the SKU's name must be in the line too; ml / gm sizes only have to agree when both give one.
      if (np.boxes.length && !np.boxes.every(b => lp.boxes.includes(b))) continue;
      if (np.sizes.length && lp.sizes.length && !np.sizes.some(z => lp.sizes.includes(z))) continue;
      const used = new Set<string>();
      if (!sw.every(w => { const hit = matchable.find(v => !used.has(v) && alike(w, v)); if (hit) used.add(hit); return !!hit; })) continue;
      let score = sw.join("").length * (generic ? 0.5 : 1) + (generic ? 0 : 2) + (cats.length ? (cats.includes(p.category || "") ? 5 : -8) : 0)
        + (np.sizes.length && lp.sizes.length ? 3 : 0);
      // The clean SKU over a Tally-style copy of it.
      if (/^kolor activ/i.test(p.item_name)) score -= 6;
      // This very line saved as the SKU's other name: it's that SKU.
      if (normName(n) === normName(line)) score += 100;
      if (!best || score > best.score) { if (best && best.p.id !== p.id) second = Math.max(second, best.score); best = { p, used, score }; }
      else if (p.id !== best.p.id) second = Math.max(second, score);
    }
  }
  if (!best) return null;
  // The shade: whatever the line says beyond the SKU's own words.
  // A trailing figure equal to the SKU's MRP is the price written without "/-" ("Lustre … Natural 150"), not a shade.
  const mrp = Number(best.p.mrp) || 0;
  const rest = lineAll.filter((w, i) => !best!.used.has(w) && !FILLER.has(w) && !(mrp && i === lineAll.length - 1 && Number(w) === mrp));
  const shade = rest.map(w => SHADE_WORDS[w] || (/^\d+$/.test(w) ? w : w.length === 1 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(" ").replace(/\s+/g, " ").trim();
  const sure = best.score - second >= 3 && best.score >= 6;
  return { product: best.p, shade, old, sure, why: sure ? "" : second && best.score - second < 3 ? "two SKUs fit" : "only a general name fits" };
}
