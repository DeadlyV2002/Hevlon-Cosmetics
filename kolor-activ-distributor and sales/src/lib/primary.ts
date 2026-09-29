// Company billing to super stockists ("SS primary sales"): one row per invoice with a column per
// item, or one row per invoice line. Headings, category and rate rows can sit anywhere near the top,
// columns can be in any order, and cells can be messy ("346 Box", blanks, merged invoice rows).
import { Grid, normName, parseNum, toISODate, headingDate } from "./parse";

export interface PrimaryItem { col: number; name: string; category: string; rate: number | null; pop: boolean }
export interface PrimaryLine { item: string; category: string; pcs: number; rate: number | null; raw?: string }
export interface PrimaryInvoice { row: number; sheet: string; date: string; invoice: string; ss: string; state: string; town: string; value: number | null; totalPcs: number | null; lines: PrimaryLine[] }
export interface PrimaryRead { invoices: PrimaryInvoice[]; items: PrimaryItem[]; pieces: boolean; notes: string[]; sheets: string[]; wide: boolean }

type Key = "sn" | "fy" | "month" | "date" | "invoice" | "state" | "ss" | "town" | "value" | "total" | "item" | "qty" | "rate" | "category";
const RULES: [Key, RegExp][] = [
  ["sn", /^(s ?n|sl ?no|sr ?no|s ?no|serial|#)$/],
  ["fy", /^(f ?y|fy|financial year|year)$/],
  ["month", /^month$/],
  ["date", /^((billing|bill|invoice|inv|voucher|vch|sale|sales) )?dated?$/],
  ["invoice", /^(tax )?(invoice|inv|bill|voucher|vch)( ?(no|number|#))?$|^ref(erence)?( no)?$/],
  ["state", /^state$/],
  ["ss", /^((ss|super ?stockist|party|customer|buyer|billed to|consignee|dealer)( name)?|name( of (party|ss|customer))?)$/],
  ["town", /^((ss|party) )?(town|city|place|station|location|district)$/],
  ["value", /^(value|amount|net amount|total value|invoice value|bill amount|net value|taxable( value)?)$/],
  ["total", /^total ?(qty|quantity|pcs|pieces)( in (pcs|pieces|dz|dozens?))?$|^(qty|quantity) in (pcs|pieces)$|^total$/],
  ["item", /^(item|product|sku|particulars|description|item name|product name)$/],
  ["qty", /^(qty|quantity|pcs|pieces|nos|units)$/],
  ["rate", /^(rate|price|rate per pc|unit price)$/],
  ["category", /^(category|group|item group|stock group)$/],
];
const lab = (v: unknown) => String(v ?? "").toLowerCase().replace(/[._:#()\[\]\n\r*/\\-]+/g, " ").replace(/\s+/g, " ").trim();
const keyOf = (v: unknown): Key | null => { const l = lab(v); if (!l) return null; for (const [k, re] of RULES) if (re.test(l)) return k; return null; };
/** Display material sent with stock: stands, trays, bags, boards. */
export const isPop = (name: string, category = "") => /\bpop\b|display|stand|standy|trey|tray|hanger|board|bag/i.test(`${category} ${name}`);
const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();
function dateOf(v: unknown): string {
  const d = toISODate(v);
  if (d) return d;
  const s = clean(v).replace(/^[a-z]+day,?\s*/i, "");
  return toISODate(s) || (s ? headingDate(s) : "");
}

/** The heading row: the one that names the SS and an invoice or date, within the first 30 rows. */
function findHeader(g: Grid): { row: number; keys: (Key | null)[] } | null {
  let best: { row: number; keys: (Key | null)[]; score: number } | null = null;
  for (let r = 0; r < Math.min(g.length, 30); r++) {
    const keys = (g[r] || []).map(keyOf);
    const has = (k: Key) => keys.includes(k);
    if (!has("ss") || !(has("invoice") || has("date"))) continue;
    const score = keys.filter(Boolean).length;
    if (!best || score > best.score) best = { row: r, keys, score };
  }
  return best && { row: best.row, keys: best.keys };
}

/** Reads every sheet that looks like SS billing. Returns null when none does. */
export function readPrimary(sheets: { name: string; grid: Grid }[], fileName = ""): PrimaryRead | null {
  const out: PrimaryRead = { invoices: [], items: [], pieces: true, notes: [], sheets: [], wide: false };
  const itemsByName = new Map<string, PrimaryItem>();
  let sawDozen = false, sawPcs = /pcs|pieces/i.test(fileName);
  for (const { name: sheet, grid: g } of sheets) {
    const h = findHeader(g);
    if (!h) continue;
    const top = g.slice(0, h.row + 1).map(r => (r || []).map(clean).join(" ")).join(" ");
    if (/\bdoz(en|ens)?\b|\bdz\b/i.test(top)) sawDozen = true;
    if (/\bpcs\b|pieces/i.test(top)) sawPcs = true;
    const col = (k: Key) => h.keys.indexOf(k);
    const head = g[h.row] || [];
    const long = col("item") >= 0 && col("qty") >= 0;
    // Wide layout: every heading to the right of the invoice details that isn't one of them is an item.
    const itemCols: PrimaryItem[] = [];
    if (!long) {
      // Items start after the SS, invoice and date columns; a column with a known heading (Qty, Total, Value…) is not an item.
      const fixed = Math.max(col("ss"), col("invoice"), col("date"));
      let cat = "";
      for (let c = fixed + 1; c < head.length; c++) {
        // The category is the nearest heading to the left in the rows above (a group title spanning its items).
        let found = "";
        for (let r = h.row - 1; r >= 0 && !found; r--) {
          const v = clean(g[r]?.[c]);
          if (v && parseNum(v) === null) found = v;
        }
        if (found) cat = found;
        const name = clean(head[c]);
        if (!name || /^total\b/i.test(name) || h.keys[c]) continue;
        // A number in the rows above is the item's rate (per piece in this format).
        let rate: number | null = null;
        for (let r = h.row - 1; r >= 0 && rate === null; r--) { const v = g[r]?.[c]; if (typeof v === "number" || (typeof v === "string" && /^\s*[\d.,]+\s*$/.test(v))) rate = parseNum(v); }
        // Before the first group title, items have no category (the app fills it from the product list).
        const category = found || (cat && c > fixed + 1 && itemCols.length && itemCols[itemCols.length - 1].category ? cat : "");
        itemCols.push({ col: c, name, category: clean(category), rate, pop: isPop(name, category) });
      }
    }
    out.sheets.push(sheet);
    if (!long) out.wide = true;
    let last: PrimaryInvoice | null = null;
    for (let r = h.row + 1; r < g.length; r++) {
      const row = g[r] || [];
      const get = (k: Key) => (col(k) >= 0 ? row[col(k)] : "");
      const ss = clean(get("ss")), inv = clean(get("invoice")), first = clean(row.find(v => clean(v)) ?? "");
      if (/^(grand )?total\b/i.test(first) || /^(grand )?total\b/i.test(clean(get("sn")))) continue;
      const lines: PrimaryLine[] = [];
      if (long) {
        const q = parseNum(get("qty") as never);
        const item = clean(get("item"));
        if (item && q) lines.push({ item, category: clean(get("category")), pcs: q, rate: parseNum(get("rate") as never), ...(typeof get("qty") === "string" && !/^\s*[\d.,]+\s*$/.test(String(get("qty"))) ? { raw: clean(get("qty")) } : {}) });
      } else {
        for (const it of itemCols) {
          const v = row[it.col];
          const q = parseNum(v as never);
          if (!q) continue;
          if (q < 0) { out.notes.push(`${sheet} row ${r + 1}: ${it.name} is ${q}; negative quantities are left out.`); continue; }
          const raw = typeof v === "string" && !/^\s*[\d.,]+\s*(pcs|pc|pieces|nos)?\.?\s*$/i.test(v) ? clean(v) : undefined;
          lines.push({ item: it.name, category: it.category, pcs: q, rate: it.rate, ...(raw ? { raw } : {}) });
        }
      }
      if (!lines.length) continue;
      // A row without its own SS / invoice continues the invoice above (merged or blank cells).
      if ((!ss || !inv) && last && (!ss || normName(ss) === normName(last.ss)) && (!inv || inv === last.invoice)) {
        if (long && (!inv || inv === last.invoice)) { last.lines.push(...lines); continue; }
        if (!ss && !inv) { last.lines.push(...lines); continue; }
      }
      if (!ss) { out.notes.push(`${sheet} row ${r + 1}: no SS name, so it was left out.`); continue; }
      const date: string = dateOf(get("date")) || (last && normName(last.ss) === normName(ss) ? last.date : "");
      if (long && last && inv && inv === last.invoice && normName(ss) === normName(last.ss)) { last.lines.push(...lines); continue; }
      last = { row: r + 1, sheet, date, invoice: inv, ss, state: clean(get("state")), town: clean(get("town")), value: parseNum(get("value") as never), totalPcs: parseNum(get("total") as never), lines };
      out.invoices.push(last);
    }
    for (const it of itemCols) if (!itemsByName.has(normName(it.name))) itemsByName.set(normName(it.name), it);
    if (long) out.invoices.forEach(i => i.lines.forEach(l => { if (!itemsByName.has(normName(l.item))) itemsByName.set(normName(l.item), { col: -1, name: l.item, category: l.category, rate: l.rate, pop: isPop(l.item, l.category) }); }));
  }
  if (!out.sheets.length) return null;
  out.items = [...itemsByName.values()];
  out.pieces = sawPcs || !sawDozen;
  // Checks a person would do by eye.
  out.invoices.forEach(i => {
    const sum = i.lines.reduce((a, l) => a + (l.raw ? 0 : l.pcs), 0), odd = i.lines.filter(l => l.raw);
    if (odd.length) out.notes.push(`${i.invoice || `Row ${i.row}`} (${i.ss}): ${odd.map(l => `${l.item} "${l.raw}"`).join(", ")} written with a unit; read as ${odd.map(l => l.pcs).join(", ")} ${out.pieces ? "pieces" : "dozens"}. Check ${odd.length === 1 ? "it" : "them"}.`);
    if (i.totalPcs !== null && Math.abs(i.totalPcs - sum) > 0.5 && !odd.length) out.notes.push(`${i.invoice || `Row ${i.row}`} (${i.ss}): items add up to ${sum}, the total column says ${i.totalPcs}.`);
    if (!i.date) out.notes.push(`${i.invoice || `Row ${i.row}`} (${i.ss}): no billing date; the upload date will be used.`);
  });
  const seen = new Map<string, number>();
  out.invoices.forEach(i => { if (i.invoice) { const k = `${normName(i.ss)}|${i.invoice}`; seen.set(k, (seen.get(k) || 0) + 1); } });
  [...seen].filter(([, n]) => n > 1).forEach(([k, n]) => out.notes.push(`Invoice ${k.split("|")[1]} appears ${n} times for the same SS; each row is kept.`));
  return out;
}
