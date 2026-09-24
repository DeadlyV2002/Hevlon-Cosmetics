// Heading-row detection for list imports (distributors, retailers), where the columns
// are names and details rather than stock lines.
import { Grid, cellText } from "./parse";

export const labelOf = (s: string) => s.toLowerCase().replace(/[._:#()\-/]+/g, " ").replace(/\s+/g, " ").trim();
const SERIAL = /^(s ?no|sr ?no|sl ?no|serial|serial no|#|pin ?code|pincode|pin)$/;

/** Maps a heading to a field with the first matching rule; serial numbers and pin codes are ignored. */
export function ruleField<F extends string>(rules: [F, RegExp][], label: string): F | "ignore" {
  const l = labelOf(label);
  if (!l || SERIAL.test(l)) return "ignore";
  for (const [f, re] of rules) if (re.test(l)) return f;
  return "ignore";
}

/**
 * Finds the heading row in the first 30 rows: the one that maps the most different fields and
 * includes `must`. Keeps one column per field (except `multi`, which may repeat).
 */
export function findHeader<F extends string>(g: Grid, rules: [F, RegExp][], must: F, multi?: F): { row: number; labels: string[]; mapping: (F | "ignore")[] } | null {
  let best = -1, bestScore = 0;
  for (let r = 0; r < Math.min(g.length, 30); r++) {
    const fields = (g[r] || []).map(c => ruleField(rules, cellText(c)));
    const score = new Set(fields.filter(x => x !== "ignore")).size + (fields.includes(must) ? 2 : 0);
    if (score > bestScore) { bestScore = score; best = r; }
  }
  if (best < 0 || bestScore < 3) return null;
  const labels = (g[best] || []).map(cellText);
  const mapping = labels.map(l => ruleField(rules, l));
  const seen = new Set<string>();
  mapping.forEach((m, i) => { if (m !== "ignore" && m !== multi) { if (seen.has(m)) mapping[i] = "ignore"; seen.add(m); } });
  return { row: best, labels, mapping };
}
