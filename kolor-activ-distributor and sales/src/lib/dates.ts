// How dates are written across the app: short dates as DD-MM-YY (05-04-26), and where a date is
// written out in words, "5th April, 2026". Data stays in ISO form (2026-04-05) so it sorts correctly.
import * as XLSX from "xlsx";

const ISO = /^(\d{4})-(\d{2})-(\d{2})/;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A date or timestamp as DD-MM-YY. Anything that isn't a date comes back unchanged. */
export function dmy(v?: string | null): string {
  if (!v) return "";
  const m = String(v).match(ISO);
  if (m) return `${m[3]}-${m[2]}-${m[1].slice(2)}`;
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return `${String(d.getDate()).padStart(2, "0")}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getFullYear()).slice(2)}`;
}
/** A timestamp as DD-MM-YY and the time, e.g. 05-04-26, 3:45 pm. */
export function dmyTime(v?: string | null): string {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return `${dmy(v)}, ${d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}`;
}
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;
/** A date written out: 5th April, 2026. */
export function longDate(v?: string | null): string {
  if (!v) return "";
  const m = String(v).match(ISO);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return `${ordinal(d.getDate())} ${MONTHS[d.getMonth()]}, ${d.getFullYear()}`;
}
/** Every ISO date inside a piece of text, as DD-MM-YY. */
export const dmyText = (s: string) => s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, mo, d) => `${d}-${mo}-${y.slice(2)}`);

/** Excel downloads write their dates as DD-MM-YY too. Called once when the app starts. */
export function excelDates() {
  const u = XLSX.utils as unknown as Record<string, (...a: unknown[]) => unknown>;
  const fix = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? dmy(v) : v);
  const json = u.json_to_sheet, aoa = u.aoa_to_sheet;
  u.json_to_sheet = (rows: unknown, ...rest: unknown[]) => json(Array.isArray(rows) ? rows.map(r => (r && typeof r === "object" ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, fix(v)])) : r)) : rows, ...rest);
  u.aoa_to_sheet = (rows: unknown, ...rest: unknown[]) => aoa(Array.isArray(rows) ? rows.map(r => (Array.isArray(r) ? r.map(fix) : r)) : rows, ...rest);
}
