// File-format-independent parsing: turns any table-like data (Excel, CSV, Tally
// Excel/XML/JSON/HTML/ASCII exports, PDF text, OCR text) into inventory rows.
// Pure functions only, so it can be tested outside the browser.
import * as XLSX from "xlsx";

export type Mode = "INPUT" | "OUTPUT" | "COUNT";
export type Field = "ignore" | "item_name" | "sku" | "quantity" | "unit_price" | "amount" | "date" | "reference" | "retailer" | "distributor";
export const FIELD_LABELS: Record<Field, string> = {
  ignore: "— ignore —", item_name: "Product name", sku: "SKU / item code", quantity: "Quantity", unit_price: "Rate",
  amount: "Amount / value", date: "Date", reference: "Invoice / voucher no.", retailer: "Party / retailer", distributor: "Distributor",
};
export type Row = { date: string; reference: string; distributor: string; sku: string; item_name: string; quantity: number; unit_price: number; retailer: string };
export type Cell = string | number | boolean | Date | null | undefined;
export type Grid = Cell[][];
export interface Sheet { name: string; grid: Grid }
export interface Table { sheets: Sheet[]; source: string; note?: string; fillDown?: boolean }
export interface Layout { headerRow: number; headerRows: number; labels: string[]; mapping: Field[] }
export interface Skipped { line: number; text: string; reason: string; row?: Row }

export const today = () => new Date().toISOString().slice(0, 10);
export const emptyRow = (): Row => ({ date: today(), reference: "", distributor: "", sku: "", item_name: "", quantity: 0, unit_price: 0, retailer: "" });

// ---------- small helpers ----------
export function normName(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(m s|ms|pvt|private|ltd|limited|llp|the)\b/g, " ").replace(/\s+/g, " ").trim();
}
const label = (c: Cell) => String(c ?? "").toLowerCase().replace(/[._:#()\[\]\n\r*/\\-]+/g, " ").replace(/\s+/g, " ").trim();
export const cellText = (c: Cell): string => {
  if (c instanceof Date) return toISODate(c);
  return String(c ?? "").trim();
};

/** "1,200.50 Pcs" → 1200.5, "(5) Nos" → -5, "100.00/Pcs" → 100, "-" → null */
export function parseNum(v: Cell): number | null {
  if (typeof v === "number") return isFinite(v) ? v : null;
  if (v === null || v === undefined || typeof v === "boolean" || v instanceof Date) return null;
  const s = String(v).trim();
  if (!s || s === "-") return null;
  const m = s.replace(/[₹\s]/g, "").match(/-?\d[\d,]*(\.\d+)?|-?\.\d+/);
  if (!m) return null;
  let n = Number(m[0].replace(/,/g, ""));
  if (!isFinite(n)) return null;
  if (/^\(.*\)/.test(s)) n = -Math.abs(n);
  return n;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number | string) => String(n).padStart(2, "0");
const yr = (y: string) => (y.length === 2 ? `20${y}` : y);

/** Excel serials, Date objects, dd-mm-yyyy, dd/mm/yy, yyyy-mm-dd, 1-Apr-26, 20260920 → yyyy-mm-dd ("" if unreadable). */
export function toISODate(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (v instanceof Date && !isNaN(v.getTime())) {
    const d = new Date(v.getTime() - v.getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 10);
  }
  if (typeof v === "number") {
    // Excel serial day number (1900 system), computed in UTC so the timezone can't shift the day.
    if (v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000).toISOString().slice(0, 10);
    if (v > 19000101 && v < 21001231) return toISODate(String(v));
    return "";
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) return `${yr(m[3])}-${pad(m[2])}-${pad(m[1])}`;
  m = s.match(/^(\d{1,2})[-\s/.]([A-Za-z]{3,9})[-\s/.,]*(\d{2,4})$/);
  if (m) { const mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; if (mo) return `${yr(m[3])}-${pad(mo)}-${pad(m[1])}`; }
  m = s.match(/^([A-Za-z]{3,9})[\s-]+(\d{1,2}),?[\s-]+(\d{4})$/);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[1].slice(0, 3).toLowerCase()])}-${pad(m[2])}`;
  return "";
}
export const isValidDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));

// ---------- header recognition ----------
// Order matters: the first matching rule wins.
const RULES: [Field, RegExp][] = [
  ["sku", /^(sku|sku code|item code|product code|code|part no|part number|article|article no|material code|alias|item alias|stock item alias|catalogue no|cat no)$/],
  ["date", /(^| )(date|dated|bill date|invoice date|vch date|voucher date)$/],
  ["quantity", /(^| )(qty|quantity|pcs|units|billed qty|actual qty|nos|closing stock|stock)$|(^| )(quantity|qty)( |$)/],
  ["unit_price", /(^| )(rate|price|unit price|mrp|ptr|pts|rate per unit|net rate)$/],
  ["amount", /(^| )(value|amount|net amount|taxable value|gross amount|total value)$/],
  ["reference", /^(invoice|inv|bill|voucher|vch|ref|reference|challan|order|doc)( no| number| num)?$/],
  ["retailer", /^(party|party name|party a c name|customer|customer name|retailer|retailer name|buyer|outlet|shop|shop name|consignee|ledger|ledger name|dealer)$/],
  ["distributor", /^(distributor|distributor name|distributor code|stockist|stockist name|db name|super stockist)$/],
  ["item_name", /^(particulars|item|items|item name|item description|product|product name|products|description|description of goods|stock item|stock item name|name of item|name of the item|material|goods|name|sku name|product description)$/],
];
export function fieldFor(l: string): Field {
  for (const [f, re] of RULES) if (re.test(l)) return f;
  return "ignore";
}

const SUB = /^(quantity|qty|rate|value|amount)$/;
function labelsAt(grid: Grid, r: number): { labels: string[]; rows: number } {
  const top = grid[r] || [], next = grid[r + 1] || [];
  const width = Math.max(top.length, next.length);
  const subs = next.filter(c => SUB.test(label(c))).length;
  if (subs >= 2) {
    // Two-line header (Tally: "Closing Balance" over "Quantity | Rate | Value").
    const out: string[] = []; let group = "";
    for (let c = 0; c < width; c++) {
      const t = label(top[c]), s = label(next[c]);
      if (t) group = t;
      out.push(s ? (group && group !== s ? `${group} ${s}` : s) : t);
    }
    return { labels: out, rows: 2 };
  }
  const out: string[] = [];
  for (let c = 0; c < width; c++) out.push(label(top[c]));
  return { labels: out, rows: 1 };
}

const QTY_PREF: Record<Mode, RegExp[]> = {
  COUNT: [/closing/, /balance|stock/],
  INPUT: [/inward|purchase|receipt|received|\bin\b/, /billed/, /closing/],
  OUTPUT: [/outward|sale|sold|issue|dispatch|\bout\b/, /billed/],
};

export function mapLabels(labels: string[], mode: Mode): Field[] {
  const mapping = labels.map(fieldFor);
  const idx = (f: Field) => mapping.map((m, i) => (m === f ? i : -1)).filter(i => i >= 0);

  // Several quantity columns (opening / inwards / outwards / closing): pick by mode.
  const q = idx("quantity");
  let qPick = q[0];
  if (q.length > 1) {
    for (const re of QTY_PREF[mode]) { const hit = q.find(i => re.test(labels[i])); if (hit !== undefined) { qPick = hit; break; } }
    if (mode === "COUNT" && !q.some(i => /closing/.test(labels[i]))) qPick = q[q.length - 1];
    q.forEach(i => { if (i !== qPick) mapping[i] = "ignore"; });
  }
  // Rate / value: prefer the one in the same group as the chosen quantity.
  const group = qPick !== undefined ? labels[qPick].replace(/(quantity|qty)$/, "").trim() : "";
  for (const f of ["unit_price", "amount"] as Field[]) {
    const cols = idx(f);
    if (cols.length > 1) {
      const keep = cols.find(i => group && labels[i].startsWith(group)) ?? cols.find(i => /rate|price|amount|value/.test(labels[i]) && !/mrp/.test(labels[i])) ?? cols[0];
      cols.forEach(i => { if (i !== keep) mapping[i] = "ignore"; });
    }
  }
  // "Particulars" is the party in sales registers when another column holds the item.
  const items = idx("item_name");
  if (items.length > 1) {
    const part = items.find(i => labels[i] === "particulars");
    const other = items.find(i => i !== part);
    items.forEach(i => { if (i !== (part !== undefined ? other : items[0])) mapping[i] = "ignore"; });
    if (part !== undefined && !mapping.includes("retailer")) mapping[part] = "retailer";
  }
  for (const f of ["sku", "date", "reference", "retailer", "distributor"] as Field[]) idx(f).slice(1).forEach(i => (mapping[i] = "ignore"));
  return mapping;
}

/** Finds the header row (within the first 40 rows) and maps its columns. */
export function detectLayout(grid: Grid, mode: Mode): Layout {
  let best: Layout | null = null, bestScore = 0;
  for (let r = 0; r < Math.min(grid.length, 40); r++) {
    const { labels, rows } = labelsAt(grid, r);
    const mapping = mapLabels(labels, mode);
    const has = (f: Field) => mapping.includes(f);
    if (!(has("item_name") || has("sku")) || !has("quantity")) continue;
    const score = new Set(mapping.filter(m => m !== "ignore")).size + (rows === 2 ? 0.5 : 0);
    if (score > bestScore) { bestScore = score; best = { headerRow: r, headerRows: rows, labels, mapping }; }
  }
  if (best) return best;
  const width = Math.max(0, ...grid.slice(0, 50).map(r => r.length));
  return { headerRow: -1, headerRows: 0, labels: Array.from({ length: width }, (_, i) => `column ${XLSX.utils.encode_col(i)}`), mapping: Array(width).fill("ignore") };
}

/** Text above the header — Tally puts the company (distributor) name here. */
export function titleText(grid: Grid, layout: Layout): string {
  const end = layout.headerRow >= 0 ? layout.headerRow : Math.min(grid.length, 5);
  return grid.slice(0, end).map(r => r.map(cellText).filter(Boolean).join(" ")).filter(Boolean).join(" | ");
}

export function detectDistributor(text: string, distributors: { code: string; name: string; aliases?: string[] | null }[]): string {
  const t = ` ${normName(text)} `;
  let best = "", bestLen = 0;
  for (const d of distributors) {
    for (const n of [d.name, ...(d.aliases || [])]) {
      const k = normName(n);
      if (k.length >= 4 && t.includes(` ${k} `) && k.length > bestLen) { best = d.code; bestLen = k.length; }
    }
  }
  return best;
}

const TOTAL = /^(grand\s*total|sub\s*-?\s*total|total|opening balance|closing balance|carried over|brought forward|b\/f|c\/f)\b/i;

/** Turns a grid + column mapping into rows; everything left out is reported with a reason. */
export function extractRows(grid: Grid, layout: Layout, mode: Mode, defaults: { distributor?: string; date?: string }, fillDown = true): { rows: Row[]; skipped: Skipped[] } {
  const col = (f: Field) => layout.mapping.indexOf(f);
  const c = { item: col("item_name"), sku: col("sku"), qty: col("quantity"), rate: col("unit_price"), amt: col("amount"), date: col("date"), ref: col("reference"), ret: col("retailer"), dist: col("distributor") };
  const get = (r: Cell[], i: number) => (i >= 0 ? r[i] : undefined);
  const start = layout.headerRow + Math.max(layout.headerRows, 1);
  const rows: (Row & { _line: number; _noRate: boolean })[] = [];
  const skipped: Skipped[] = [];
  const minQty = mode === "COUNT" ? 0 : Number.MIN_VALUE;

  // Registers leave date / voucher no. / party blank on a voucher's 2nd, 3rd… item line: carry them down.
  const carry: Record<number, Cell> = {};
  for (let i = Math.max(start, 0); i < grid.length; i++) {
    const r = [...(grid[i] || [])];
    if (fillDown) for (const ci of [c.date, c.ref, c.ret]) if (ci >= 0) { if (cellText(r[ci])) carry[ci] = r[ci]; else if (cellText(r[c.item]) && carry[ci] !== undefined) r[ci] = carry[ci]; }
    const text = r.map(cellText).filter(Boolean).join(" · ");
    if (!text) continue;
    const item = cellText(get(r, c.item)), sku = cellText(get(r, c.sku));
    const line = i + 1;
    if (!item && !sku) { if (c.qty >= 0 && parseNum(get(r, c.qty)) !== null) skipped.push({ line, text, reason: "no product name" }); continue; }
    if (TOTAL.test(item || sku)) { skipped.push({ line, text, reason: "total line" }); continue; }
    const qty = parseNum(get(r, c.qty));
    const rawRate = parseNum(get(r, c.rate));
    let rate = rawRate;
    const amt = parseNum(get(r, c.amt));
    if ((rate === null || rate === 0) && amt && qty) rate = Math.round((Math.abs(amt) / Math.abs(qty)) * 100) / 100;
    const row: Row = {
      date: toISODate(get(r, c.date)) || defaults.date || today(),
      reference: cellText(get(r, c.ref)),
      distributor: cellText(get(r, c.dist)) || defaults.distributor || "",
      sku, item_name: item,
      quantity: qty ?? 0,
      unit_price: rate === null ? 0 : Math.abs(rate),
      retailer: cellText(get(r, c.ret)),
    };
    if (qty === null) { skipped.push({ line, text, reason: "no quantity", row }); continue; }
    if (qty < 0) {
      // Tally shows purchases/outwards as negative in some registers; stock can't be negative.
      if (mode === "COUNT") { skipped.push({ line, text, reason: "negative stock in file", row }); continue; }
      row.quantity = Math.abs(qty);
    }
    if (row.quantity < minQty || (mode !== "COUNT" && row.quantity === 0)) { skipped.push({ line, text, reason: "zero quantity", row }); continue; }
    rows.push({ ...row, _line: line, _noRate: c.rate >= 0 && !rawRate });
  }

  // Tally "Detailed" stock summaries list a group line (with the group total) before its items.
  const out: Row[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let sum = 0, n = 0, isGroup = false;
    for (let j = i + 1; j < rows.length && n < 200; j++) {
      sum += rows[j].quantity; n++;
      if (Math.abs(sum - r.quantity) < 1e-6 && r.quantity > 0) { isGroup = n >= 2 || r._noRate; break; }
      if (sum > r.quantity) break;
    }
    const { _line, _noRate, ...clean } = r;
    if (isGroup) skipped.push({ line: _line, text: `${r.item_name || r.sku} · ${r.quantity}`, reason: "looks like a group total (equals the lines below it)", row: clean });
    else out.push(clean);
  }
  skipped.sort((a, b) => a.line - b.line);
  return { rows: out, skipped };
}

// ---------- readers that produce grids ----------
export function workbookToTable(wb: XLSX.WorkBook, source: string): Table {
  const sheets = wb.SheetNames.map(name => ({ name, grid: XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[name], { header: 1, raw: true, defval: "", blankrows: false }) }))
    .filter(s => s.grid.some(r => r.some(c => cellText(c))));
  // Largest sheet first.
  sheets.sort((a, b) => b.grid.length - a.grid.length);
  return { sheets, source, fillDown: true };
}

/** Text lines (PDF/OCR/ASCII) → grid, splitting on tabs or runs of 2+ spaces. */
export function linesToGrid(lines: string[]): Grid {
  return lines.map(l => l.split(/\t|\s{2,}/).map(s => s.trim()).filter((s, i, a) => s || i < a.length - 1)).filter(r => r.some(Boolean));
}

/** Last resort for free-text lines: "CODE  Product name  12  150.00". */
export function heuristicGrid(lines: string[]): Grid {
  const re = /^\s*([A-Za-z0-9][A-Za-z0-9_\-/]{1,30})\s+([A-Za-z][A-Za-z0-9 .&()/'-]{2,60}?)\s+(\d[\d,]*(?:\.\d+)?)\s+(\d[\d,]*(?:\.\d+)?)\b/;
  const skipWords = /^(gstin|gst|invoice|total|sub|page|date|phone|mobile|state|hsn|sr|s\.no|no\.?)$/i;
  const g: Grid = [["SKU", "Product", "Qty", "Rate"]];
  for (const line of lines) { const m = line.match(re); if (m && !skipWords.test(m[1])) g.push([m[1], m[2].trim(), m[3], m[4]]); }
  return g;
}

// ---------- Tally XML / JSON ----------
export interface Node { tag: string; attrs: Record<string, string>; children: Node[]; text: string }

const ITEM_KEYS = ["stockitemname", "itemname", "stockitem", "productname", "item"];
const QTY_KEYS = ["billedqty", "actualqty", "quantity", "qty", "closingbalance", "closingqty", "dspclqty"];
const RATE_KEYS = ["rate", "closingrate", "dspclrate", "openingrate"];
const AMT_KEYS = ["amount", "closingvalue", "dspclamta", "openingvalue"];
const CTX = { date: ["date"], reference: ["vouchernumber", "vchnumber", "reference", "invoiceno"], retailer: ["partyledgername", "partyname", "partymailingname", "basicbuyername"], vtype: ["vouchertypename", "vchtype"] };

const k = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "").replace(/list$/, "");
function fields(n: Node): Record<string, string> {
  const f: Record<string, string> = {};
  for (const [a, v] of Object.entries(n.attrs)) f[k(a)] ??= v;
  for (const c of n.children) if (!c.children.length) f[k(c.tag)] ??= c.text;
  return f;
}
const pick = (f: Record<string, string>, keys: string[]) => { for (const key of keys) if (f[key] !== undefined && f[key] !== "") return f[key]; return ""; };

/** Walks any Tally XML/JSON tree and collects every node that looks like an inventory line. */
export function treeToGrid(root: Node): { grid: Grid; kind: string } {
  const grid: Grid = [["Date", "Voucher No", "Voucher Type", "Party", "Item", "Quantity", "Rate", "Amount"]];
  const walk = (n: Node, ctx: Record<string, string>) => {
    const f = fields(n);
    const here = { ...ctx };
    for (const [name, keys] of Object.entries(CTX)) { const v = pick(f, keys); if (v) here[name] = v; }
    // Stock item masters: <STOCKITEM NAME="…"><OPENINGBALANCE>10 Pcs</OPENINGBALANCE>. Ledgers also have
    // NAME + OPENINGBALANCE (money), so those two keys only count on STOCKITEM nodes.
    const master = k(n.tag) === "stockitem";
    const qty = pick(f, QTY_KEYS) || (master ? pick(f, ["openingbalance"]) : "");
    const item = pick(f, ITEM_KEYS) || (master || pick(f, ["quantity", "qty", "billedqty"]) ? pick(f, ["name"]) : "");
    if (item && qty && parseNum(qty) !== null) {
      grid.push([here.date || "", here.reference || "", here.vtype || "", here.retailer || "", item, qty, pick(f, RATE_KEYS), pick(f, AMT_KEYS)]);
      return; // don't descend into batch allocations of the same line
    }
    n.children.forEach(c => walk(c, here));
  };
  walk(root, {});
  if (grid.length > 1) return { grid, kind: "Tally vouchers / items" };

  // Tally report display export: <DSPACCNAME><DSPDISPNAME/></DSPACCNAME><DSPSTKINFO>…</DSPSTKINFO> pairs.
  const g2: Grid = [["Item", "Opening Quantity", "Inwards Quantity", "Outwards Quantity", "Closing Quantity", "Closing Rate", "Closing Value"]];
  const find = (n: Node, tag: string): Node | undefined => n.tag.toUpperCase() === tag ? n : n.children.map(c => find(c, tag)).find(Boolean);
  const scan = (n: Node) => {
    let name = "";
    for (const c of n.children) {
      const t = c.tag.toUpperCase();
      if (t === "DSPACCNAME") name = find(c, "DSPDISPNAME")?.text || "";
      else if (t === "DSPSTKINFO" && name) {
        const v = (tag: string) => find(c, tag)?.text || "";
        g2.push([name, v("DSPOPQTY"), v("DSPINQTY"), v("DSPOUTQTY"), v("DSPCLQTY"), v("DSPCLRATE"), v("DSPCLAMTA")]);
        name = "";
      } else scan(c);
    }
  };
  scan(root);
  if (g2.length > 1) {
    const used = g2[0].map((_, i) => i === 0 || g2.slice(1).some(r => cellText(r[i])));
    return { grid: g2.map(r => r.filter((_, i) => used[i])), kind: "Tally stock summary" };
  }
  return { grid, kind: "Tally XML" };
}

/** Tally writes XML as UTF-16 and sometimes with illegal control characters. */
export function decodeText(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let enc = "utf-8";
  if (b[0] === 0xff && b[1] === 0xfe) enc = "utf-16le";
  else if (b[0] === 0xfe && b[1] === 0xff) enc = "utf-16be";
  else if (b.length > 3 && b[1] === 0 && b[3] === 0) enc = "utf-16le";
  return new TextDecoder(enc).decode(b).replace(/^﻿/, "");
}
export function cleanXml(s: string): string {
  return s.replace(/&#(?:[0-8]|1[124-9]|2\d|3[01]);/g, "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;");
}
export function domToNode(el: Element): Node {
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
  const children = Array.from(el.children).map(domToNode);
  return { tag: el.tagName, attrs, children, text: children.length ? "" : (el.textContent || "").trim() };
}
export function jsonToNode(v: unknown, tag = "root"): Node {
  if (Array.isArray(v)) return { tag, attrs: {}, children: v.map(x => jsonToNode(x, tag)), text: "" };
  if (v && typeof v === "object") return { tag, attrs: {}, children: Object.entries(v as Record<string, unknown>).map(([key, x]) => jsonToNode(x, key)), text: "" };
  return { tag, attrs: {}, children: [], text: v === null || v === undefined ? "" : String(v) };
}
