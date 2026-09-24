import { createClient } from "@supabase/supabase-js";
import { normName } from "./parse";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined;
export const supabase = url && key ? createClient(url, key) : null;

export type Role = "HO_ADMIN" | "STATE_MANAGER" | "DISTRIBUTOR_MANAGER" | "SALESMAN";
export interface Distributor { id: string; code: string; name: string; territory: string | null; phone: string | null; aliases: string[]; created_at?: string }
export interface Product { id: string; sku: string; item_name: string; unit_price: number }
export interface StockLine { distributor_id: string; distributor_code: string; distributor_name: string; product_id: string; sku: string; item_name: string; unit_price: number; total_input: number; total_output: number; current_stock: number; stock_value: number; last_movement: string }

/** Same matching rules as the database: code, name, or any alternative name (ignoring M/S, Pvt Ltd, punctuation). */
export function matchDistributor(text: string, list: Distributor[]): Distributor | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const n = normName(t);
  return list.find(d => d.code.toLowerCase() === t.toLowerCase())
    ?? list.find(d => normName(d.name) === n || (d.aliases || []).some(a => normName(a) === n));
}
export function matchProduct(sku: string, name: string, list: Product[]): Product | undefined {
  const s = sku.trim().toLowerCase(), n = normName(name);
  return (s ? list.find(p => p.sku.toLowerCase() === s) : undefined) ?? (n ? list.find(p => normName(p.item_name) === n) : undefined);
}

export const fmt = (n: unknown, d = 0) => Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });
export const errText = (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as any).message) : String(e));
