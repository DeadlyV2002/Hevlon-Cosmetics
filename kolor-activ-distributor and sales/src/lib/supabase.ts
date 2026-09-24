import { createClient } from "@supabase/supabase-js";
import { normName } from "./parse";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined;
export const supabase = url && key ? createClient(url, key) : null;

export type Role = "HO_ADMIN" | "STATE_MANAGER" | "DISTRIBUTOR_MANAGER" | "SALESMAN";

/** Every place that holds stock lives in the distributors table; kind says which it is. */
export type Kind = "GODOWN" | "SUPER_STOCKIST" | "DISTRIBUTOR";
export const KINDS: Kind[] = ["GODOWN", "SUPER_STOCKIST", "DISTRIBUTOR"];
export const KIND_LABEL: Record<Kind, string> = { GODOWN: "Godown", SUPER_STOCKIST: "Super stockist", DISTRIBUTOR: "Distributor" };
export const KIND_PLURAL: Record<Kind, string> = { GODOWN: "Godowns", SUPER_STOCKIST: "Super stockists", DISTRIBUTOR: "Distributors" };
const CODE_PREFIX: Record<Kind, string> = { GODOWN: "G", SUPER_STOCKIST: "SS", DISTRIBUTOR: "D" };

export interface Distributor {
  id: string; code: string; name: string; kind: Kind; parent_id: string | null;
  company_name: string | null; owner_name: string | null; super_stockist: string | null;
  state: string | null; region: string | null; territory: string | null; phone: string | null;
  aliases: string[]; created_at?: string;
}
export interface Retailer { id: string; distributor_id: string | null; code: string | null; name: string; territory: string | null; owner_name: string | null; phone: string | null; created_at: string }
export interface SalesOfficer { id: string; code: string; name: string; phone: string | null; state: string | null; region: string | null; aliases: string[]; active: boolean }
export interface ProductAlias { product_id: string; alias: string }
export interface Product { id: string; sku: string; item_name: string; unit_price: number }
export interface StockLine {
  distributor_id: string; distributor_code: string; distributor_name: string; product_id: string; sku: string; item_name: string; unit_price: number;
  total_input: number; total_output: number; current_stock: number; stock_value: number; last_movement: string; last_in: string | null; last_out: string | null; kind: Kind;
}

/** Next free code for a kind: D001…, SS001…, G001… */
export function nextCode(kind: Kind, list: { code: string }[]): string {
  const re = new RegExp(`^${CODE_PREFIX[kind]}(\\d+)$`, "i");
  const n = Math.max(0, ...list.map(d => Number(d.code.match(re)?.[1] || 0))) + 1;
  return `${CODE_PREFIX[kind]}${String(n).padStart(3, "0")}`;
}

// ---------- required details ----------
type Required = "name" | "company_name" | "owner_name" | "parent_id" | "state" | "region" | "territory" | "phone";
const REQUIRED_LABEL: Record<Required, string> = {
  name: "name", company_name: "company name", owner_name: "owner name", parent_id: "super stockist",
  state: "state", region: "region", territory: "city / area", phone: "phone",
};
/** Other names are never required. Region is optional for super stockists and godowns, which often cover several. */
export const REQUIRED: Record<Kind, Required[]> = {
  DISTRIBUTOR: ["name", "company_name", "owner_name", "parent_id", "state", "region", "territory", "phone"],
  SUPER_STOCKIST: ["name", "company_name", "owner_name", "state", "territory", "phone"],
  GODOWN: ["name", "company_name", "state", "territory"],
};
export function missingFields(d: Partial<Record<Required, string | null>> & { kind: Kind }): string[] {
  return REQUIRED[d.kind].filter(f => !String(d[f] ?? "").trim()).map(f => REQUIRED_LABEL[f]);
}
/** Indian mobile or landline: 8 to 13 digits once spaces, dashes and +91 are ignored. */
export const validPhone = (s: string) => { const n = s.replace(/\D/g, "").length; return n >= 8 && n <= 13; };

// ---------- loading ----------
const PAGE = 1000;
type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
/** Supabase returns at most 1,000 rows per request; this keeps asking until everything is in. */
export async function fetchAll<T>(page: (from: number, to: number) => Page<T>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAGE) return out;
  }
}

// ---------- matching (same rules as the database) ----------
/** Code, name, company name, or any other name, ignoring M/S, Pvt Ltd, capitals and punctuation. */
export function matchDistributor(text: string, list: Distributor[]): Distributor | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const n = normName(t);
  return list.find(d => d.code.toLowerCase() === t.toLowerCase())
    ?? list.find(d => normName(d.name) === n || (!!d.company_name && normName(d.company_name) === n) || (d.aliases || []).some(a => normName(a) === n));
}
export function matchSO(text: string, list: SalesOfficer[]): SalesOfficer | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const n = normName(t);
  return list.find(s => s.code.toLowerCase() === t.toLowerCase()) ?? list.find(s => normName(s.name) === n || (s.aliases || []).some(a => normName(a) === n));
}
export function matchProduct(sku: string, name: string, list: Product[], aliases: ProductAlias[] = []): Product | undefined {
  const s = sku.trim().toLowerCase(), n = normName(name), ns = normName(sku);
  const byId = (id?: string) => (id ? list.find(p => p.id === id) : undefined);
  return (s ? list.find(p => p.sku.toLowerCase() === s) : undefined)
    ?? (n ? list.find(p => normName(p.item_name) === n) : undefined)
    ?? (n ? byId(aliases.find(a => normName(a.alias) === n)?.product_id) : undefined)
    ?? (ns ? byId(aliases.find(a => normName(a.alias) === ns)?.product_id) : undefined);
}

// ---------- formatting ----------
export const fmt = (n: unknown, d = 0) => Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });
/** "1 row", "3 rows". */
export const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
/** ₹12,34,567 → "₹12.3 L"; crores as "Cr"; negatives as "−₹4,500". */
export function money(n: unknown): string {
  const v = Number(n || 0), a = Math.abs(v), sign = v < 0 ? "−" : "";
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(a >= 1e8 ? 0 : 1)} Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(a >= 1e6 ? 0 : 1)} L`;
  return `${sign}₹${fmt(a)}`;
}
export const errText = (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as any).message) : String(e));
export const locLabel = (d: Distributor) => `${d.name} (${d.code})`;
