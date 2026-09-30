import { ReactNode, isValidElement, useMemo, useState } from "react";

export type SortVal = string | number | null | undefined;

/** A value to sort a cell by: amounts, dozens and days as numbers ("₹1,23,456", "12.5 dz", "45 days"),
 *  DD-MM-YY dates in date order, anything else as text. Blanks and "never" go last. */
export function sortValue(v: unknown): SortVal {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isValidElement(v)) return sortValue(textOf(v));
  if (Array.isArray(v)) return sortValue(v.map(textOf).join(""));
  const s = String(v).trim();
  if (!s || /^(never|—|-|none)/i.test(s)) return null;
  const d = s.match(/^(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})$/);
  if (d) return Number(`${d[3].length === 2 ? `20${d[3]}` : d[3]}${d[2].padStart(2, "0")}${d[1].padStart(2, "0")}`);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return Number(`${iso[1]}${iso[2]}${iso[3]}`);
  // A number with at most a unit after it; "2 In 1 Lip Color" stays text.
  const num = /^[-+]?₹?\s*[\d,]*\.?\d+\s*(l|cr|dz|pcs?|days?|%|% alike)?$/i.test(s) && s.replace(/[₹,\s]/g, "").match(/^[-+]?\d*\.?\d+/);
  if (num) {
    let x = Number(num[0]);
    // Lakh and crore written short ("₹1.2 L", "₹2.6 Cr").
    if (/\bcr\b/i.test(s)) x *= 1e7; else if (/\d\s*l\b/i.test(s)) x *= 1e5;
    return x;
  }
  return s.toLowerCase();
}
function textOf(n: unknown): string {
  if (n === null || n === undefined || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  if (isValidElement(n)) return textOf((n.props as { children?: unknown }).children);
  return "";
}
const cmp = (a: SortVal, b: SortVal) => {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "en-IN", { numeric: true });
};

export interface Col<T> { head: ReactNode; cell: (r: T) => ReactNode; sort?: (r: T) => SortVal; className?: (r: T) => string | undefined }

/** A table whose column heads sort it: click once for biggest / A first, again to flip. Unsorted it keeps the order it was given. */
export default function SortTable<T>({ rows, cols, rowKey, rowClass, limit, className }: {
  rows: T[]; cols: Col<T>[]; rowKey: (r: T, i: number) => string; rowClass?: (r: T) => string | undefined; limit?: number; className?: string;
}) {
  const [s, setS] = useState<{ i: number; dir: 1 | -1 } | null>(null);
  const sorted = useMemo(() => {
    if (!s) return rows;
    const col = cols[s.i], f = col?.sort || ((r: T) => sortValue(col?.cell(r)));
    return rows.map((r, i) => ({ r, i, v: f(r) })).sort((a, b) => {
      const nul = (x: SortVal) => x === null || x === undefined;
      if (nul(a.v) !== nul(b.v)) return nul(a.v) ? 1 : -1; // blanks last either way
      return cmp(a.v, b.v) * s.dir || a.i - b.i;
    }).map(x => x.r);
  }, [rows, cols, s]);
  const click = (i: number) => setS(p => {
    if (p?.i === i) return { i, dir: p.dir === 1 ? -1 : 1 };
    // Numbers start biggest first, text A to Z.
    const first = rows.map(r => (cols[i].sort ? cols[i].sort!(r) : sortValue(cols[i].cell(r)))).find(v => v !== null && v !== undefined);
    return { i, dir: typeof first === "number" ? -1 : 1 };
  });
  const shown = limit ? sorted.slice(0, limit) : sorted;
  return <table className={`sorttable${className ? ` ${className}` : ""}`}>
    <thead><tr>{cols.map((c, i) => <th key={i} aria-sort={s?.i === i ? (s.dir === 1 ? "ascending" : "descending") : "none"}>
      {c.head === "" || c.head === null ? null : <button type="button" className="sorthead" onClick={() => click(i)} title="Sort by this column">
        {c.head}<span className="arrow" aria-hidden>{s?.i === i ? (s.dir === 1 ? "▲" : "▼") : "↕"}</span></button>}</th>)}</tr></thead>
    <tbody>{shown.map((r, k) => <tr key={rowKey(r, k)} className={rowClass?.(r)}>{cols.map((c, i) => <td key={i} className={c.className?.(r)}>{c.cell(r)}</td>)}</tr>)}</tbody>
  </table>;
}
