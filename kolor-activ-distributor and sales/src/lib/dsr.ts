// Reads the SO daily secondary sales report (DSR) workbook: one sheet per SO, one row per day,
// with calls, productive calls, secondary sale value and a column per product (quantities in dozens,
// SS rate per dozen in the "Basic Rate" row above the headings).
import * as XLSX from "xlsx";
import { cellText, normName, parseNum, toISODate, today, sheetRows } from "./parse";
import { labelOf } from "./sheet";
import { plural } from "./supabase";

export interface DsrLine { product: string; category: string; qty: number; rate: number | null }
export interface DsrDay {
  so: string; day: string; state: string; manager: string; hq: string; db_name: string; town: string; beat: string; remark: string;
  attendance: string; total_calls: number; productive_calls: number; sale_value: number; lines: DsrLine[]; sheet: string; file: string;
}
export interface DsrProduct { name: string; category: string; rate: number | null; position: number }
export interface DsrStateDay { state: string; day: string; total_calls: number; productive_calls: number; sale_value: number }
export interface SheetInfo { file: string; name: string; kind: "SO daily" | "State total" | "Summary" | "Empty"; rows: number; note: string }
export interface DsrBook { days: DsrDay[]; stateDays: DsrStateDay[]; products: DsrProduct[]; sheets: SheetInfo[]; dupes: string[] }

export const ATTENDANCE = ["Present", "Half Day", "Meeting", "Leave", "Weekly Off", "Holiday", "Absent", "No Report"] as const;
const CODES: Record<string, string> = { p: "Present", present: "Present", a: "Absent", absent: "Absent", l: "Leave", leave: "Leave", cl: "Leave", sl: "Leave",
  wo: "Weekly Off", w: "Weekly Off", "weekly off": "Weekly Off", off: "Weekly Off", h: "Holiday", holiday: "Holiday", hd: "Half Day", "half day": "Half Day", m: "Meeting", meeting: "Meeting" };

/** The Attendance column when the sheet has one; otherwise read from the remark and the day's work. */
export function attendanceOf(marked: string, remark: string, calls: number, db: string): string {
  const m = marked.trim().toLowerCase();
  if (m) return CODES[m] || CODES[m.replace(/[^a-z ]/g, "")] || marked.trim();
  const r = remark.toLowerCase();
  if (/\bleave\b|sick/.test(r)) return "Leave";
  if (/weekly ?off|week ?off/.test(r)) return "Weekly Off";
  if (/holiday|festival|rath ?yatra|puja|diwali|holi\b/.test(r)) return "Holiday";
  if (/absent/.test(r)) return "Absent";
  if (/half ?day/.test(r)) return "Half Day";
  if (calls > 0) return "Present";
  if (/meeting/.test(r)) return "Meeting";
  if (db || r) return "Present";
  return "No Report";
}

const HEAD: Record<string, RegExp> = {
  state: /^state$/, date: /date|^month/, manager: /reporting|manager|asm/, so: /name so|^so( name)?$|^so ase|sales ?officer/, hq: /^hq$|head ?quarter/,
  db: /^db( name)?$|distributor/, town: /^town|city/, beat: /beat|route/, remark: /remark/, attendance: /attendance|^att$/,
  calls: /^total call/, pc: /^productive call/, value: /secondary sale|sec(ondary)? value/,
};

export function readDsr(wb: XLSX.WorkBook, file = ""): DsrBook {
  const days: DsrDay[] = [], stateDays: DsrStateDay[] = [], products = new Map<string, DsrProduct>(), sheets: SheetInfo[] = [];
  const last = today();
  for (const name of wb.SheetNames) {
    const g = sheetRows(wb.Sheets[name]);
    const info = (kind: SheetInfo["kind"], rows: number, note: string) => sheets.push({ file, name, kind, rows, note });
    if (!g.length) { info("Empty", 0, "No data in this sheet (charts only)."); continue; }
    const hr = g.findIndex((r, i) => i < 15 && r.some(c => HEAD.calls.test(labelOf(cellText(c)))) && r.some(c => HEAD.date.test(labelOf(cellText(c)))));
    if (hr < 0) { info("Summary", g.length, "Summary or analysis table. Its figures are worked out again from the daily rows, so nothing is lost."); continue; }
    const head = g[hr].map(c => labelOf(cellText(c)));
    const c = Object.fromEntries(Object.keys(HEAD).map(k => [k, head.findIndex(h => HEAD[k].test(h))])) as Record<string, number>;
    // Product columns come after the secondary sale value; the rows above give category and rate.
    const rateRow = g.slice(0, hr).findIndex(r => r.some(x => /basic rate|rate in/i.test(cellText(x))));
    const catRow = g.slice(0, hr).findIndex(r => r.some(x => /^category$/i.test(cellText(x).trim())));
    const prodCols: { i: number; name: string; category: string; rate: number | null }[] = [];
    let cat = "";
    for (let i = Math.max(c.value, c.pc, c.calls) + 1; i < g[hr].length; i++) {
      if (catRow >= 0 && cellText(g[catRow][i]).trim()) cat = cellText(g[catRow][i]).trim();
      const pn = cellText(g[hr][i]).trim();
      if (!pn || HEAD.attendance.test(labelOf(pn))) continue;
      const rate = rateRow >= 0 ? parseNum(g[rateRow][i]) : null;
      prodCols.push({ i, name: pn, category: cat, rate });
      if (!products.has(pn)) products.set(pn, { name: pn, category: cat, rate, position: products.size });
    }
    // A sheet with no SO names is the state (or zone) total, used to check the SO sheets.
    const body = g.slice(hr + 1).filter(r => toISODate(r[c.date]));
    const isTotal = /total/i.test(name) || (c.so >= 0 ? body.every(r => !cellText(r[c.so]).trim()) : !/\(/.test(name));
    const soFromSheet = name.replace(/\(.*\)/, "").trim();
    let found = 0;
    for (const r of body) {
      const day = toISODate(r[c.date]);
      if (!day || day > last) continue;
      const v = (k: string) => (c[k] >= 0 ? cellText(r[c[k]]).trim() : "");
      const num = (k: string) => (c[k] >= 0 ? parseNum(r[c[k]]) || 0 : 0);
      const lines = prodCols.map(p => ({ product: p.name, category: p.category, qty: parseNum(r[p.i]) || 0, rate: p.rate })).filter(l => l.qty);
      const calls = num("calls"), pc = num("pc");
      let value = num("value");
      if (!value && lines.length) value = lines.reduce((a, l) => a + l.qty * (l.rate || 0), 0);
      if (isTotal) {
        if (!calls && !value) continue;
        stateDays.push({ state: v("state") || soFromSheet, day, total_calls: Math.round(calls), productive_calls: Math.round(pc), sale_value: Math.round(value * 100) / 100 });
        found++; continue;
      }
      const remark = v("remark"), db = v("db");
      if (!remark && !db && !calls && !value && !v("attendance")) continue;
      days.push({ so: v("so") || soFromSheet, day, state: v("state"), manager: v("manager"), hq: v("hq"), db_name: db, town: v("town"), beat: v("beat"), remark,
        attendance: attendanceOf(v("attendance"), remark, calls, db), total_calls: Math.round(calls), productive_calls: Math.round(pc), sale_value: Math.round(value * 100) / 100, lines, sheet: name, file });
      found++;
    }
    if (isTotal) info("State total", found, `${plural(found, "day")} of state totals, used to check that the SO sheets add up.`);
    else info("SO daily", found, found ? `${plural(found, "day")} for ${days[days.length - 1]?.so || soFromSheet}.` : "Daily layout, but no filled-in days yet.");
  }
  return { days, stateDays, products: [...products.values()], sheets, dupes: [] };
}

/** Several workbooks as one upload. The same person on the same day twice is kept once and reported. */
export function mergeBooks(books: DsrBook[]): DsrBook {
  const seen = new Map<string, DsrDay>(), days: DsrDay[] = [], dupes: string[] = [], products = new Map<string, DsrProduct>(), states = new Map<string, DsrStateDay>();
  for (const b of books) {
    for (const d of b.days) {
      const k = `${normName(d.so)}|${d.day}`, first = seen.get(k);
      if (first) { dupes.push(`${d.so} on ${d.day}: in ${first.file ? `${first.file} › ` : ""}${first.sheet} and ${d.file ? `${d.file} › ` : ""}${d.sheet}${first.sale_value !== d.sale_value || first.total_calls !== d.total_calls ? " (different figures)" : ""}`); continue; }
      seen.set(k, d); days.push(d);
    }
    b.products.forEach(p => { if (!products.has(p.name)) products.set(p.name, { ...p, position: products.size }); });
    b.stateDays.forEach(s => states.set(`${s.state}|${s.day}`, s));
  }
  return { days, stateDays: [...states.values()], products: [...products.values()], sheets: books.flatMap(b => b.sheets), dupes };
}
