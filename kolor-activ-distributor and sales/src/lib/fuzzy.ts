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
  if (fx === fy || sameWords(x, y) || similarity(x, y) >= 0.85) return true;
  const [short, long] = fx.length <= fy.length ? [fx, fy] : [fy, fx];
  if (short.length >= 6 && long.startsWith(short)) return true;
  // The first names nearly the same ("Upendar" / "Upendra") and one person has just the one name.
  const [w1, w2] = [x.split(" "), y.split(" ")];
  return (w1.length === 1 || w2.length === 1) && w1[0].length >= 5 && similarity(w1[0], w2[0]) >= 0.7;
}
