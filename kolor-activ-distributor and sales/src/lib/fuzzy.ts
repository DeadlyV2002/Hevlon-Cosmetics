// Near-matches for names typed differently in different files ("Waaah" / "Waah", "Khusbu Sringar" / "Khushbu Shringar").
import { normName } from "./parse";

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}
/** 0 to 1: how alike two names are, ignoring case, spaces and punctuation. */
export function similarity(a: string, b: string): number {
  const x = normName(a).replace(/ /g, ""), y = normName(b).replace(/ /g, "");
  if (!x || !y) return 0;
  if (x === y) return 1;
  const tokens = (s: string) => normName(s).split(" ").filter(w => w.length > 1);
  const [ta, tb] = [tokens(a), tokens(b)];
  const contained = ta.length && tb.length && (ta.every(w => tb.includes(w)) || tb.every(w => ta.includes(w)));
  return Math.max(1 - editDistance(x, y) / Math.max(x.length, y.length), contained ? 0.85 : 0);
}

/** A product with a similar name; a matching rate makes a weaker name match acceptable. */
export function guessProduct<P extends { item_name: string; sku: string; ss_rate?: number | null; unit_price: number }>(name: string, rate: number, products: P[]): P | undefined {
  let best: P | undefined, score = 0;
  for (const p of products) {
    const r = Number(p.ss_rate) || Number(p.unit_price) || 0;
    const same = rate > 0 && r > 0 && Math.abs(r - rate) <= Math.max(0.5, r * 0.005);
    const s = Math.max(similarity(name, p.item_name), similarity(name, p.sku)) + (same ? 0.25 : 0);
    if (s > score) { score = s; best = p; }
  }
  return score >= 0.85 ? best : undefined;
}

export const GENERIC = new Set(["traders", "trader", "enterprises", "enterprise", "ent", "agency", "agencies", "store", "stores", "distributors", "distributor", "and", "co", "company", "ms", "m", "s", "the", "sons", "brothers", "bros", "shop", "centre", "center", "general"]);
/** Distinctive words of a business name: "Rajkumar Traders" → ["rajkumar"]. */
export const keyWords = (s: string) => normName(s).split(" ").filter(w => w.length > 2 && !GENERIC.has(w));
/** Does a word appear in the text, allowing one or two letters off for longer words? */
export function hasWord(words: string[], w: string) {
  return words.some(x => x === w || (w.length >= 5 && x.length >= 4 && editDistance(x, w) <= (w.length >= 8 ? 2 : 1)));
}

/** Letters apart, with two letters swapped counting as one ("Sharma" / "Shrama"). */
export function typoDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
/** Two words of a name that are one word: "Chand" / "Chandra", "Sharma" / "Shrama", "Abhihsek" / "Abhishek". */
const wordAlike = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 5 && (a.startsWith(b) || b.startsWith(a)))
  || (Math.min(a.length, b.length) >= 5 && typoDistance(a, b) <= (Math.max(a.length, b.length) >= 8 ? 2 : 1));
/** Full names whose words match one for one, allowing a spelling slip in each ("Suresh Chand Sharma" / "Suresh Chandra Shrama"). */
function wordsAlike(a: string, b: string) {
  const x = a.split(" ").filter(Boolean), y = b.split(" ").filter(Boolean);
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  if (s.length < 2 || !wordAlike(s[0], l[0])) return false;
  const left = l.slice(1);
  return s.slice(1).every(w => { const i = left.findIndex(v => wordAlike(w, v)); if (i < 0) return false; left.splice(i, 1); return true; });
}
/** Same person when every word of the shorter name is in the longer one ("Amiya Kumar" and "Amiya Kumar Mohapatra"). */
function sameWords(a: string, b: string) {
  const x = normName(a).split(" ").filter(Boolean), y = normName(b).split(" ").filter(Boolean);
  if (!x.length || !y.length) return false;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  return s.length >= 2 ? s.every(w => l.includes(w)) : s[0] === l[0] && l.length === 1;
}
/** Names that are probably one person: MD / Mohd / Mr ignored, spelling a little different ("Upendar" / "Upendra Kumar"),
 *  one name inside the other ("Ravi Ranjan" / "Raviranjan Kumar", "Pritam Kumar" / "Pritam Kumar Sandip"). */
export function looksAlike(a: string, b: string) {
  const bare = (x: string) => normName(x.replace(/^(md|mohd|mr|smt|shri)\.?\s+/i, ""));
  const x = bare(a), y = bare(b), fx = x.replace(/ /g, ""), fy = y.replace(/ /g, "");
  if (!fx || !fy) return false;
  if (fx === fy || sameWords(x, y) || wordsAlike(x, y)) return true;
  const [short, long] = fx.length <= fy.length ? [fx, fy] : [fy, fx];
  if (short.length >= 6 && long.startsWith(short)) return true;
  // Two full names with clearly different first names are different people ("Ajay Kumar Singh" / "Aman Kumar Singh").
  const [f1, f2] = [x.split(" "), y.split(" ")];
  if (f1.length >= 2 && f2.length >= 2 && similarity(f1[0], f2[0]) < 0.7) return false;
  if (similarity(x, y) >= 0.85) return true;
  // The first names nearly the same ("Upendar" / "Upendra") and one person has just the one name.
  const [w1, w2] = [x.split(" "), y.split(" ")];
  return (w1.length === 1 || w2.length === 1) && w1[0].length >= 5 && (similarity(w1[0], w2[0]) >= 0.7 || typoDistance(w1[0], w2[0]) <= 1);
}

/** The distinctive part of a business name, run together: "New Maa Kamakhya Enterprises" → "newmaakamakhya". */
const businessKey = (s: string) => keyWords(s.replace(/\(.*?\)/g, " ")).join("");
/** One business written two ways: "New Maa Kamakhya" / "New Maa Kamakhya Enterprises", "Parlar House" / "Parlor House". */
export function sameBusinessName(a: string, b: string) {
  const x = businessKey(a), y = businessKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 5 && 1 - editDistance(x, y) / Math.max(x.length, y.length) >= 0.85;
}
/** Two different towns ("Belur" / "Halisahar"), so a shared name like "Mahabir Enterprise" is two businesses. */
export const otherTown = (a?: string | null, b?: string | null) => !!a?.trim() && !!b?.trim() && similarity(a, b) < 0.8;
/** An entry in the list that is this name spelt a little differently, in the same state and town. */
export function closeLocation<L extends { name: string; company_name?: string | null; aliases?: string[] | null; state?: string | null; territory?: string | null }>(
  name: string, list: L[], state?: string | null, town?: string | null): L | undefined {
  const st = normName(state || "");
  return list.find(l => (!st || !l.state || normName(l.state) === st) && !otherTown(town, l.territory)
    && [l.name, l.company_name || "", ...(l.aliases || [])].some(x => x && sameBusinessName(name, x)));
}

/** Words of a SKU name that tell it apart: brand, price and pack words dropped, sizes run together ("10 Gm" → "10gm"). */
function skuWords(s: string) {
  const t = s.toLowerCase().replace(/\bmrp\b|\d+\s*\/-|\(?\bpcs?\)?|\bkolor\b|\bactiv\b|^ka\b|\bbox\b|\bpack\b|\bnew\b/g, " ")
    .replace(/(\d+)\s*(ml|gm|g|mg)\b/g, "$1$2").replace(/[^a-z0-9 ]/g, " ");
  const all = t.split(/\s+/).filter(Boolean);
  // Anything with a figure in it is a size or pack ("10gm", "9x1", "12 pc"): those must match.
  return { size: all.filter(w => /\d/.test(w)).sort().join(","), words: all.filter(w => !/\d/.test(w)) };
}
/** One SKU written two ways: "Strawberry Blast Tube" / "Strawberry Blast Tube 10 Gm", "Glycerin-50ml Box Pack" / "Glycrine 50ml".
 *  Different sizes are different SKUs. */
export function sameProductName(a: string, b: string) {
  const x = skuWords(a), y = skuWords(b);
  if (x.size && y.size && x.size !== y.size) return false;
  const [s, l] = x.words.length <= y.words.length ? [x.words, y.words] : [y.words, x.words];
  if (!s.length || (s.length === 1 && s[0].length < 6)) return false;
  const left = [...l];
  return s.every(w => { const i = left.findIndex(v => wordAlike(w, v)); if (i < 0) return false; left.splice(i, 1); return true; });
}
