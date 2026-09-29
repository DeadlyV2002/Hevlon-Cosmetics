// Dashboard charts and alerts: what each chart shows, what can be changed on it, and where its
// numbers come from. Charts load through a shared cache, so charts and alerts that need the same
// data make one request.
import { supabase, Distributor, Kind, KINDS, KIND_LABEL, Product, SalesOfficer, StockLine, fetchAll, fmt, money, plural, missingFields } from "./supabase";
import { Scope, applyScope, emptyScope } from "../components/FilterBar";
import { localDate, today } from "./parse";
import { dmy } from "./dates";

export type ChartKind = "stock_trend" | "stock_where" | "aged" | "so_spikes" | "reorders" | "flows" | "no_stock_sales"
  | "running_low" | "stale" | "count_losses" | "top_products" | "slow_products" | "so_claims" | "new_outlets"
  | "dsr_trend" | "dsr_people" | "dsr_products" | "dsr_attendance" | "collection";

export interface ChartConfig {
  id: string; kind: ChartKind;
  title?: string; focus?: boolean; labels?: boolean;
  scope?: Scope; metric?: "value" | "units"; top?: number;
  days?: number; weeks?: number; threshold?: number;
  groupBy?: string; split?: string; series?: string[];
  /** Pinned charts stay in place on the dashboard; the others take turns in the rotating area. */
  pinned?: boolean;
}
export type Unit = "money" | "units" | "days" | "percent" | "count" | "pct";
export interface SeriesDef { key: string; name: string; slot: 1 | 2 | 3 }
export interface BarRow { key: string; label: string; sub?: string; values: number[] }
export type ChartData =
  | { type: "bars"; unit: Unit; series: SeriesDef[]; rows: BarRow[]; more: number; summary: string }
  | { type: "columns" | "lines"; unit: Unit; series: SeriesDef[]; x: string[]; values: number[][]; summary: string };
export interface Ctx { locations: Distributor[]; products: Product[]; stock: StockLine[]; officers: SalesOfficer[] }

export function formatValue(unit: Unit, n: number): string {
  if (unit === "money") return money(n);
  if (unit === "days") return `${n < 10 ? n.toFixed(1).replace(/\.0$/, "") : fmt(n)} ${n === 1 ? "day" : "days"}`;
  if (unit === "percent") return `+${fmt(n)}%`;
  if (unit === "pct") return `${fmt(n)}%`;
  return fmt(n);
}

// ---------- shared loading ----------
const cache = new Map<string, Promise<unknown>>();
export const clearInsightCache = () => cache.clear();
function once<T>(key: string, load: () => Promise<T>): Promise<T> {
  let p = cache.get(key) as Promise<T> | undefined;
  if (!p) { p = load(); cache.set(key, p); p.catch(() => cache.delete(key)); }
  return p;
}
const rpc = <T,>(fn: string, args: Record<string, unknown>) =>
  once<T[]>(`${fn}:${JSON.stringify(args)}`, () => fetchAll<T>((a, b) => supabase!.rpc(fn, args).range(a, b)));
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return localDate(d); };
const daysSince = (d: string) => Math.max(0, Math.round((Date.parse(today()) - Date.parse(d.slice(0, 10))) / 86400000));
const shortDate = (d: string) => dmy(d);

interface Maps { loc: Map<string, Distributor>; prod: Map<string, Product> }
const mapsCache = new WeakMap<Ctx, Maps>();
function maps(ctx: Ctx): Maps {
  let m = mapsCache.get(ctx);
  if (!m) { m = { loc: new Map(ctx.locations.map(d => [d.id, d])), prod: new Map(ctx.products.map(p => [p.id, p])) }; mapsCache.set(ctx, m); }
  return m;
}
const price = (ctx: Ctx, productId: string) => Number(maps(ctx).prod.get(productId)?.unit_price || 0);

/** The locations a chart looks at. list is null when nothing is filtered (the database can skip filtering). */
function scoped(ctx: Ctx, scope: Scope | undefined, kinds: Kind[]) {
  const pool = ctx.locations.filter(l => kinds.includes(l.kind));
  const s = scope || emptyScope();
  const picked = applyScope(pool, s);
  const all = !s.state && !s.region && !s.ss && !s.ids.length && !s.kind;
  return { ids: new Set(picked.map(d => d.id)), list: all ? null : picked.map(d => d.id) };
}

type Group = "location" | "product" | "ss" | "state" | "region";
function groupOf(g: string, ctx: Ctx, locId: string, prodId: string): { key: string; label: string; sub?: string } {
  const { loc, prod } = maps(ctx);
  const d = loc.get(locId), p = prod.get(prodId);
  if (g === "product") return { key: prodId, label: p?.item_name || "Unknown product" };
  if (g === "state") return { key: d?.state || "", label: d?.state || "No state" };
  if (g === "region") return { key: `${d?.state || ""}|${d?.region || ""}`, label: d?.region || "No region", sub: d?.state || undefined };
  if (g === "ss") {
    if (d?.kind === "GODOWN") return { key: "godowns", label: "Your godowns" };
    const ss = d?.kind === "SUPER_STOCKIST" ? d : loc.get(d?.parent_id || "");
    return { key: ss?.id || "", label: ss?.name || "No super stockist" };
  }
  return { key: locId, label: d?.name || "Deleted location", sub: d ? `${KIND_LABEL[d.kind]}${d.territory ? ` · ${d.territory}` : ""}` : undefined };
}

/** Adds up rows with the same key, sorts them and keeps the top n. */
function rank(items: BarRow[], top: number, order: "desc" | "asc" = "desc") {
  const m = new Map<string, BarRow>();
  for (const it of items) {
    const r = m.get(it.key);
    if (!r) m.set(it.key, { ...it, values: [...it.values] });
    else it.values.forEach((v, i) => { r.values[i] = (r.values[i] || 0) + v; });
  }
  const sum = (r: BarRow) => r.values.reduce((a, v) => a + v, 0);
  const all = [...m.values()].filter(r => sum(r) > 0).sort((a, b) => (order === "desc" ? sum(b) - sum(a) : sum(a) - sum(b)));
  return { rows: all.slice(0, top), more: Math.max(0, all.length - top) };
}
const SHORT: Record<string, string> = { dispatched: "sent from godowns", sold: "sold by distributors", so: "reported by SOs" };
/** "Sharma Traders'" and "Gupta's". */
const whose = (name: string) => (name.endsWith("s") ? `${name}'` : `${name}'s`);
const TYPE_SERIES: SeriesDef[] = [{ key: "GODOWN", name: "Godowns", slot: 1 }, { key: "SUPER_STOCKIST", name: "Super stockists", slot: 2 }, { key: "DISTRIBUTOR", name: "Distributors", slot: 3 }];
const typeIndex = (k?: Kind | null) => (k === "GODOWN" ? 0 : k === "SUPER_STOCKIST" ? 1 : 2);
const unitOf = (c: ChartConfig): Unit => (c.metric === "units" ? "units" : "money");
/** A total for a sentence: "₹12,400" or "550 units". */
const says = (c: ChartConfig, n: number) => (c.metric === "units" ? `${fmt(n)} ${n === 1 ? "unit" : "units"}` : money(n));
const amount = (c: ChartConfig, ctx: Ctx, productId: string, qty: number) => (c.metric === "units" ? qty : qty * price(ctx, productId));

// ---------- rows the database returns ----------
interface TrendRow { week_end: string; kind: Kind | null; state: string; units: number; value: number }
interface FlowRow { week_start: string; dispatched_units: number; dispatched_value: number; sold_units: number; sold_value: number; so_units: number; so_value: number }
interface AgedRow { location_id: string; product_id: string; stock: number; aged_qty: number; oldest_in: string | null; last_out: string | null }
interface ActivityRow { so_id: string; so_name: string; last_day: string; last_units: number; last_value: number; base_days: number; base_units: number | null; base_value: number | null; week_days: number; week_units: number | null; week_value: number | null }
interface ReorderRow { location_id: string; product_id: string; received_on: string; qty_received: number; stock_before: number; daily_sales: number; cover_days: number | null }
interface OversellRow { distributor_id: string; product_id: string; report_date: string; so_total: number; available: number; so_names: string }
interface PeriodRow { location_id: string; product_id: string; qty_out: number; closing: number; out_sale: number; out_count: number }
interface StatusRow { location_id: string; last_count: string | null; last_sale: string | null; last_file: string | null }
interface CountRow { location_id: string; product_id: string; counted_on: string; change: number }
interface VsRow { distributor_id: string; product_id: string; so_checked: number; dist_out: number }
interface OutletRow { so_name: string; distributor_id: string; retailer_name: string | null }

const load = {
  trend: (weeks: number, list: string[] | null) => rpc<TrendRow>("stock_trend", { p_weeks: weeks, p_locations: list }),
  flows: (weeks: number, list: string[] | null) => rpc<FlowRow>("weekly_flows", { p_weeks: weeks, p_locations: list }),
  aged: (days: number) => rpc<AgedRow>("aged_stock", { p_days: days, p_as_of: today(), p_locations: null }),
  activity: () => rpc<ActivityRow>("so_activity", { p_base_days: 30 }),
  reorders: (days: number, cover: number) => rpc<ReorderRow>("reorders_while_stocked", { p_days: days, p_cover_days: cover, p_locations: null }),
  oversell: (days: number) => rpc<OversellRow>("so_oversell", { p_from: daysAgo(days - 1), p_to: today(), p_locations: null }),
  period: (days: number) => rpc<PeriodRow>("stock_period", { p_from: daysAgo(days - 1), p_to: today(), p_locations: null }),
  counts: (days: number) => rpc<CountRow>("count_changes", { p_from: daysAgo(days - 1), p_to: today(), p_locations: null }),
  vs: (days: number) => rpc<VsRow>("so_vs_distributor", { p_from: daysAgo(days - 1), p_to: today(), p_locations: null }),
  status: () => once("location_data_status", () => fetchAll<StatusRow>((a, b) => supabase!.from("location_data_status").select("location_id,last_count,last_sale,last_file").order("location_id").range(a, b))),
  outlets: (days: number) => once(`outlets:${days}`, () => fetchAll<OutletRow>((a, b) => supabase!.from("so_line_details").select("so_name,distributor_id,retailer_name")
    .eq("retailer_status", "UNKNOWN").gte("report_date", daysAgo(days - 1)).lte("report_date", today()).order("id").range(a, b))),
};

// ---------- SO daily reports and collections ----------
interface DsrRow { so_id: string; day: string; state: string | null; attendance: string | null; total_calls: number; productive_calls: number; sale_value: number; distributor_id: string | null }
interface BillRow { party_type: string; party_id: string; billed: number; collected: number; billed_all: number; collected_all: number }
const dsr = (days: number) => once(`dsr:${days}`, () => fetchAll<DsrRow>((a, b) => supabase!.from("dsr_days")
  .select("so_id,day,state,attendance,total_calls,productive_calls,sale_value,distributor_id").gte("day", daysAgo(days - 1)).lte("day", today()).order("day").order("id").range(a, b)));
const dsrProducts = (days: number) => rpc<{ product: string; category: string | null; qty: number; value: number }>("dsr_product_totals", { p_from: daysAgo(days - 1), p_to: today(), p_sos: null, p_state: null });
const bills = (days: number) => rpc<BillRow>("billing_summary", { p_from: daysAgo(days - 1), p_to: today() });
const person = (ctx: Ctx, id: string) => ctx.officers.find(o => o.id === id);
const WORKDAY = new Set(["Present", "Half Day", "Meeting"]);

// ---------- what can be changed on a chart ----------
export type OptionDef =
  | { key: "metric" | "top" | "labels" }
  | { key: "scope"; kinds: Kind[] }
  | { key: "groupBy" | "split"; label: string; choices: { id: string; label: string }[] }
  | { key: "days" | "weeks" | "threshold"; label: string; min: number; max: number; suffix: string }
  | { key: "series"; label: string; choices: { id: string; label: string }[] };

const GROUPS: Record<Group, string> = { location: "Each location", product: "Each product", ss: "Each super stockist", state: "Each state", region: "Each region" };
const groupChoices = (...g: Group[]) => g.map(id => ({ id, label: GROUPS[id] }));
const SELLERS: Kind[] = ["SUPER_STOCKIST", "DISTRIBUTOR"];
const groupWord = (g?: string) => (g === "product" ? "product" : g === "ss" ? "super stockist" : g === "state" ? "state" : g === "region" ? "region" : "distributor");

export interface KindSpec {
  name: string; blurb: string; title: string;
  subtitle: (c: ChartConfig) => string;
  defaults: Omit<ChartConfig, "id" | "kind">;
  options: OptionDef[];
  empty: string;
  load: (c: ChartConfig, ctx: Ctx) => Promise<ChartData>;
}

export const KIND_SPECS: Record<ChartKind, KindSpec> = {
  stock_trend: {
    name: "Stock held, week by week", blurb: "Is total stock across godowns, super stockists and distributors rising or falling?",
    title: "How much stock you hold, week by week",
    subtitle: c => `${c.metric === "units" ? "Units" : "Value at SS rate"} of all stock at the end of each week${c.split === "state" ? ", split by state" : c.split === "none" ? "" : ", split into godowns, super stockists and distributors"}. Last ${c.weeks ?? 12} weeks.`,
    defaults: { weeks: 12, split: "kind", metric: "value", labels: true },
    options: [{ key: "metric" }, { key: "weeks", label: "Weeks to show", min: 4, max: 52, suffix: "weeks" },
      { key: "split", label: "Split the bars", choices: [{ id: "kind", label: "Godowns, SS and distributors" }, { id: "state", label: "Top 2 states and the rest" }, { id: "none", label: "Don't split" }] },
      { key: "scope", kinds: KINDS }, { key: "labels" }],
    empty: "No stock has been recorded yet.",
    async load(c, ctx) {
      const rows = await load.trend(c.weeks ?? 12, scoped(ctx, c.scope, KINDS).list);
      const weeks = [...new Set(rows.map(r => r.week_end))].sort();
      const pick = (r: TrendRow) => Number(c.metric === "units" ? r.units : r.value);
      let series: SeriesDef[] = TYPE_SERIES;
      let idx: (r: TrendRow) => number = r => typeIndex(r.kind);
      if (c.split === "none") { series = [{ key: "all", name: "All stock", slot: 1 }]; idx = () => 0; }
      if (c.split === "state") {
        const last = new Map<string, number>();
        rows.filter(r => r.kind && r.week_end === weeks[weeks.length - 1]).forEach(r => last.set(r.state || "No state", (last.get(r.state || "No state") || 0) + pick(r)));
        const top = [...last].sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => x[0]);
        series = [...top.map((s, i) => ({ key: s, name: s, slot: (i + 1) as 1 | 2 })), ...(last.size > 2 ? [{ key: "other", name: "Other states", slot: 3 as const }] : [])];
        idx = r => { const i = top.indexOf(r.state || "No state"); return i >= 0 ? i : series.length - 1; };
      }
      const values = series.map(() => weeks.map(() => 0));
      rows.forEach(r => { if (r.kind) values[idx(r)][weeks.indexOf(r.week_end)] += pick(r); });
      const totals = weeks.map((_, i) => values.reduce((a, s) => a + s[i], 0));
      const now = totals[totals.length - 1] || 0, before = totals[Math.max(0, totals.length - 5)] || 0, diff = now - before;
      return { type: "columns", unit: unitOf(c), series, x: weeks.map(shortDate), values,
        summary: now ? `${says(c, now)} now, ${diff === 0 ? "the same as" : diff > 0 ? `up ${says(c, diff)} from` : `down ${says(c, -diff)} from`} 4 weeks ago.` : "" };
    },
  },
  stock_where: {
    name: "Where your stock is sitting", blurb: "Current stock by state, region, super stockist, location or product.",
    title: "Where your stock is sitting right now",
    subtitle: c => `Current stock ${c.metric === "units" ? "units" : "value at SS rate"} in each ${groupWord(c.groupBy || "state")}${c.split === "none" ? "" : ", split into godowns, super stockists and distributors"}.`,
    defaults: { groupBy: "state", split: "kind", metric: "value", top: 10, labels: true },
    options: [{ key: "metric" }, { key: "groupBy", label: "One bar for", choices: groupChoices("state", "region", "ss", "location", "product") },
      { key: "split", label: "Split the bars", choices: [{ id: "kind", label: "Godowns, SS and distributors" }, { id: "none", label: "Don't split" }] },
      { key: "top", }, { key: "scope", kinds: KINDS }, { key: "labels" }],
    empty: "No stock has been recorded yet.",
    async load(c, ctx) {
      const { ids } = scoped(ctx, c.scope, KINDS);
      const split = c.split !== "none";
      const items = ctx.stock.filter(s => ids.has(s.distributor_id) && Number(s.current_stock) > 0).map(s => {
        const g = groupOf(c.groupBy || "state", ctx, s.distributor_id, s.product_id);
        const v = c.metric === "units" ? Number(s.current_stock) : Number(s.stock_value);
        const values = split ? [0, 0, 0] : [0];
        values[split ? typeIndex(maps(ctx).loc.get(s.distributor_id)?.kind) : 0] = v;
        return { key: g.key, label: g.label, sub: c.groupBy === "location" ? g.sub : undefined, values };
      });
      const r = rank(items, c.top ?? 10);
      const total = items.reduce((a, it) => a + it.values.reduce((x, y) => x + y, 0), 0);
      return { type: "bars", unit: unitOf(c), series: split ? TYPE_SERIES : [{ key: "all", name: "Stock", slot: 1 }], ...r,
        summary: total ? `${says(c, total)} in all${r.rows[0] ? `; the most in ${r.rows[0].label}` : ""}.` : "" };
    },
  },
  aged: {
    name: "Stock piling up unsold", blurb: "Stock that has sat at a distributor or super stockist without selling for months.",
    title: "Stock piling up unsold",
    subtitle: c => `Stock that hasn't sold for over ${c.threshold ?? 60} days, by ${groupWord(c.groupBy)}.`,
    defaults: { threshold: 60, groupBy: "location", metric: "value", top: 10, labels: true },
    options: [{ key: "threshold", label: "Unsold for more than", min: 15, max: 365, suffix: "days" }, { key: "metric" },
      { key: "groupBy", label: "One bar for", choices: groupChoices("location", "product", "ss", "state") }, { key: "top" }, { key: "scope", kinds: KINDS }, { key: "labels" }],
    empty: "Nothing has sat unsold that long.",
    async load(c, ctx) {
      const { ids } = scoped(ctx, c.scope, SELLERS);
      const rows = (await load.aged(c.threshold ?? 60)).filter(r => ids.has(r.location_id) && Number(r.aged_qty) > 0);
      const oldest = new Map<string, number>();
      const items = rows.map(r => {
        const g = groupOf(c.groupBy || "location", ctx, r.location_id, r.product_id);
        const age = r.oldest_in ? daysSince(r.oldest_in) : 0;
        oldest.set(g.key, Math.max(oldest.get(g.key) || 0, age));
        return { key: g.key, label: g.label, sub: g.sub, values: [amount(c, ctx, r.product_id, Number(r.aged_qty))] };
      });
      const r = rank(items, c.top ?? 10);
      r.rows.forEach(row => { const a = oldest.get(row.key) || 0; row.sub = `oldest stock ${a >= 60 ? `${Math.round(a / 30)} months` : `${a} days`}`; });
      const total = items.reduce((a, it) => a + it.values[0], 0);
      return { type: "bars", unit: unitOf(c), series: [{ key: "aged", name: "Unsold", slot: 1 }], ...r,
        summary: total ? `${says(c, total)} of stock, ${plural(rows.length, "product line")} at ${plural(new Set(rows.map(x => x.location_id)).size, "location")}.` : "" };
    },
  },
  so_spikes: {
    name: "SOs reporting far more than usual", blurb: "An SO's latest day (or week) against their own average day. A sudden jump is worth a call.",
    title: "SOs reporting far more than usual",
    subtitle: c => `Each SO's ${c.groupBy === "week" ? "last 7 days" : "latest day"} against their average day over the 30 days before. Shown when ${c.threshold ?? 50}% or more above.`,
    defaults: { threshold: 50, groupBy: "day", metric: "value", top: 10, labels: true },
    options: [{ key: "threshold", label: "Show SOs at least", min: 10, max: 500, suffix: "% above usual" },
      { key: "groupBy", label: "Compare", choices: [{ id: "day", label: "Their latest day" }, { id: "week", label: "Their last 7 days" }] }, { key: "metric" }, { key: "top" }, { key: "labels" }],
    empty: "No SO is reporting unusually high numbers.",
    async load(c, ctx) {
      const rows = await load.activity();
      const units = c.metric === "units", week = c.groupBy === "week";
      const items = rows.flatMap(r => {
        const usual = Number(units ? r.base_units : r.base_value), now = Number(week ? (units ? r.week_units : r.week_value) : (units ? r.last_units : r.last_value));
        if (r.base_days < 3 || !usual) return [];
        const pct = (now / usual - 1) * 100;
        if (pct < (c.threshold ?? 50)) return [];
        const f = (n: number) => formatValue(units ? "units" : "money", n);
        return [{ key: r.so_id, label: r.so_name, sub: `${f(now)} ${week ? "a day this week" : `on ${shortDate(r.last_day)}`}; usually ${f(usual)}`, values: [Math.round(pct)] }];
      });
      const r = rank(items, c.top ?? 10);
      return { type: "bars", unit: "percent", series: [{ key: "pct", name: "Above usual", slot: 2 }], ...r,
        summary: items.length ? `${plural(items.length, "SO")} ${items.length === 1 ? "is" : "are"} ${c.threshold ?? 50}% or more above their usual day.` : "" };
    },
  },
  reorders: {
    name: "Reordering stock they already hold", blurb: "Distributors taking more of a product while they already have months of it: hoarding, or stock parked with them.",
    title: "Reordering stock they already hold",
    subtitle: c => `Stock received in the last ${c.days ?? 30} days while already holding more than ${c.threshold ?? 60} days' worth, by ${groupWord(c.groupBy)}.`,
    defaults: { days: 30, threshold: 60, groupBy: "location", metric: "value", top: 10, labels: true },
    options: [{ key: "threshold", label: "Already holding more than", min: 15, max: 365, suffix: "days of stock" }, { key: "days", label: "Look back", min: 7, max: 180, suffix: "days" },
      { key: "metric" }, { key: "groupBy", label: "One bar for", choices: groupChoices("location", "product", "ss", "state") }, { key: "top" }, { key: "scope", kinds: SELLERS }, { key: "labels" }],
    empty: "Nobody reordered stock they already had plenty of.",
    async load(c, ctx) {
      const { ids } = scoped(ctx, c.scope, SELLERS);
      const rows = (await load.reorders(c.days ?? 30, c.threshold ?? 60)).filter(r => ids.has(r.location_id));
      const cover = new Map<string, number>();
      const items = rows.map(r => {
        const g = groupOf(c.groupBy || "location", ctx, r.location_id, r.product_id);
        cover.set(g.key, Math.max(cover.get(g.key) || 0, r.cover_days === null ? Infinity : Number(r.cover_days)));
        return { key: g.key, label: g.label, sub: g.sub, values: [amount(c, ctx, r.product_id, Number(r.qty_received))] };
      });
      const r = rank(items, c.top ?? 10);
      r.rows.forEach(row => { const d = cover.get(row.key) || 0; row.sub = d === Infinity ? "had stock that wasn't selling" : `already held up to ${fmt(d)} days of stock`; });
      const total = items.reduce((a, it) => a + it.values[0], 0);
      return { type: "bars", unit: unitOf(c), series: [{ key: "recv", name: "Received", slot: 1 }], ...r,
        summary: total ? `${says(c, total)} received across ${plural(rows.length, "delivery", "deliveries")}.` : "" };
    },
  },
  flows: {
    name: "Stock sent out vs stock sold", blurb: "Weekly dispatches from your godowns against what distributors sold and what SOs reported.",
    title: "Stock sent out vs stock sold",
    subtitle: c => `Each week: ${(c.series?.length ? c.series : ["dispatched", "sold", "so"]).map(s => (s === "dispatched" ? "dispatches from your godowns" : s === "sold" ? "distributors' own sales" : "sales SOs reported")).join(", ")}. Last ${c.weeks ?? 12} weeks.`,
    defaults: { weeks: 12, metric: "value", series: ["dispatched", "sold", "so"], labels: true },
    options: [{ key: "metric" }, { key: "weeks", label: "Weeks to show", min: 4, max: 52, suffix: "weeks" },
      { key: "series", label: "Lines", choices: [{ id: "dispatched", label: "Sent from your godowns" }, { id: "sold", label: "Sold by distributors" }, { id: "so", label: "Reported by SOs" }] },
      { key: "scope", kinds: KINDS }, { key: "labels" }],
    empty: "No stock has moved in these weeks.",
    async load(c, ctx) {
      const rows = [...(await load.flows(c.weeks ?? 12, scoped(ctx, c.scope, KINDS).list))].sort((a, b) => a.week_start.localeCompare(b.week_start));
      const u = c.metric === "units";
      const all: (SeriesDef & { pick: (r: FlowRow) => number })[] = [
        { key: "dispatched", name: "Sent from your godowns", slot: 1, pick: r => Number(u ? r.dispatched_units : r.dispatched_value) },
        { key: "sold", name: "Sold by distributors", slot: 3, pick: r => Number(u ? r.sold_units : r.sold_value) },
        { key: "so", name: "Reported by SOs", slot: 2, pick: r => Number(u ? r.so_units : r.so_value) },
      ];
      const chosen = all.filter(s => (c.series?.length ? c.series : ["dispatched", "sold", "so"]).includes(s.key));
      const values = chosen.map(s => rows.map(s.pick));
      const last = rows.length - 1;
      return { type: "lines", unit: unitOf(c), series: chosen.map(({ pick: _, ...s }) => s), x: rows.map(r => shortDate(r.week_start)), values,
        summary: values.some(v => v.some(Boolean)) && last >= 0 ? `This week: ${chosen.map((s, i) => `${says(c, values[i][last])} ${SHORT[s.key]}`).join(", ")}.` : "" };
    },
  },
  no_stock_sales: {
    name: "SO sales without stock behind them", blurb: "SOs reporting sales of stock the distributor never had. Usually bogus entries.",
    title: "SO sales without stock behind them",
    subtitle: c => `What SOs reported beyond the distributor's stock in the last ${c.days ?? 30} days, by ${c.groupBy === "so" || !c.groupBy ? "SO" : groupWord(c.groupBy)}.`,
    defaults: { days: 30, groupBy: "so", metric: "units", top: 10, labels: true },
    options: [{ key: "days", label: "Look back", min: 7, max: 180, suffix: "days" }, { key: "metric" },
      { key: "groupBy", label: "One bar for", choices: [{ id: "so", label: "Each SO" }, ...groupChoices("location", "product")] }, { key: "top" }, { key: "scope", kinds: SELLERS }, { key: "labels" }],
    empty: "No SO reported more than the distributor had.",
    async load(c, ctx) {
      const { ids } = scoped(ctx, c.scope, SELLERS);
      const worst = new Map<string, OversellRow & { gap: number }>();
      (await load.oversell(c.days ?? 30)).filter(r => ids.has(r.distributor_id)).forEach(r => {
        const gap = Number(r.so_total) - Number(r.available), k = `${r.distributor_id}|${r.product_id}`;
        if (gap > (worst.get(k)?.gap || 0)) worst.set(k, { ...r, gap });
      });
      const items = [...worst.values()].flatMap(r => {
        const v = amount(c, ctx, r.product_id, r.gap);
        if (c.groupBy === "so" || !c.groupBy) { const names = (r.so_names || "?").split(", "); return names.map(n => ({ key: n, label: n, values: [v / names.length] })); }
        const g = groupOf(c.groupBy, ctx, r.distributor_id, r.product_id);
        return [{ key: g.key, label: g.label, sub: g.sub, values: [v] }];
      });
      const r = rank(items, c.top ?? 10);
      const total = items.reduce((a, it) => a + it.values[0], 0);
      return { type: "bars", unit: unitOf(c), series: [{ key: "gap", name: "Beyond stock", slot: 2 }], ...r,
        summary: total ? `${says(c, total)} reported beyond stock, ${plural(worst.size, "product line")}.` : "" };
    },
  },
  running_low: {
    name: "Fast sellers about to run out", blurb: "Products with only days of stock left at their recent selling rate.",
    title: "Fast sellers about to run out",
    subtitle: c => `Products with under ${c.threshold ?? 7} days of stock left at the rate they sold over the last 30 days. Fewest days first.`,
    defaults: { threshold: 7, top: 10, labels: true },
    options: [{ key: "threshold", label: "Less than", min: 1, max: 60, suffix: "days of stock left" }, { key: "top" }, { key: "scope", kinds: KINDS }, { key: "labels" }],
    empty: "Nothing is about to run out.",
    async load(c, ctx) {
      const { ids } = scoped(ctx, c.scope, KINDS);
      const { loc, prod } = maps(ctx);
      const items = (await load.period(30)).filter(r => ids.has(r.location_id) && Number(r.qty_out) > 0).map(r => ({ r, cover: Number(r.closing) / (Number(r.qty_out) / 30) }))
        .filter(x => x.cover < (c.threshold ?? 7)).sort((a, b) => a.cover - b.cover);
      const rows = items.slice(0, c.top ?? 10).map(({ r, cover }) => ({ key: `${r.location_id}|${r.product_id}`, label: prod.get(r.product_id)?.item_name || "Unknown product",
        sub: `${loc.get(r.location_id)?.name || "Deleted location"} · ${fmt(r.closing)} left`, values: [Math.max(Math.round(cover * 10) / 10, 0.1)] }));
      return { type: "bars", unit: "days", series: [{ key: "days", name: "Days left", slot: 2 }], rows, more: Math.max(0, items.length - rows.length),
        summary: items.length ? `${plural(items.length, "product line")} will run out within ${c.threshold ?? 7} days.` : "" };
    },
  },
  stale: {
    name: "Distributors gone quiet", blurb: "Distributors and super stockists that haven't sent a stock count or sales file for a while.",
    title: "Distributors gone quiet",
    subtitle: c => `Days since each one last sent a file of its own (stock count, sales, dispatch or purchase register). Shown after ${c.threshold ?? 15} days.`,
    defaults: { threshold: 15, top: 10, labels: true },
    options: [{ key: "threshold", label: "Quiet for more than", min: 1, max: 180, suffix: "days" }, { key: "top" }, { key: "scope", kinds: SELLERS }, { key: "labels" }],
    empty: "Everyone has sent data recently.",
    async load(c, ctx) {
      const { ids } = scoped(ctx, c.scope, SELLERS);
      const status = new Map((await load.status()).map(s => [s.location_id, s]));
      const items = ctx.locations.filter(d => ids.has(d.id)).map(d => {
        const s = status.get(d.id), own = [s?.last_count, s?.last_sale, s?.last_file].filter(Boolean).sort().pop() || null;
        return { d, own, days: daysSince(own || d.created_at || today()) };
      }).filter(x => x.days > (c.threshold ?? 15)).sort((a, b) => b.days - a.days);
      const rows = items.slice(0, c.top ?? 10).map(x => ({ key: x.d.id, label: x.d.name, sub: x.own ? `last sent ${shortDate(x.own)}` : "never sent any; days since added", values: [x.days] }));
      return { type: "bars", unit: "days", series: [{ key: "days", name: "Days quiet", slot: 1 }], rows, more: Math.max(0, items.length - rows.length),
        summary: items.length ? `${plural(items.length, "location")} quiet for over ${c.threshold ?? 15} days.` : "" };
    },
  },
  count_losses: {
    name: "Stock missing at stock counts", blurb: "Stock that was lower at a count than the app expected. Opening counts are left out.",
    title: "Stock missing at stock counts",
    subtitle: c => `Stock found lower than expected at counts in the last ${c.days ?? 30} days, by ${groupWord(c.groupBy)}. Each location's opening count is left out.`,
    defaults: { days: 30, groupBy: "location", metric: "value", top: 10, labels: true },
    options: [{ key: "days", label: "Look back", min: 7, max: 365, suffix: "days" }, { key: "metric" },
      { key: "groupBy", label: "One bar for", choices: groupChoices("location", "product", "ss", "state") }, { key: "top" }, { key: "scope", kinds: KINDS }, { key: "labels" }],
    empty: "No stock went missing at counts.",
    async load(c, ctx) {
      const { ids } = scoped(ctx, c.scope, KINDS);
      const rows = (await load.counts(c.days ?? 30)).filter(r => ids.has(r.location_id) && Number(r.change) < 0);
      const items = rows.map(r => { const g = groupOf(c.groupBy || "location", ctx, r.location_id, r.product_id); return { key: g.key, label: g.label, sub: g.sub, values: [amount(c, ctx, r.product_id, -Number(r.change))] }; });
      const r = rank(items, c.top ?? 10);
      const total = items.reduce((a, it) => a + it.values[0], 0);
      return { type: "bars", unit: unitOf(c), series: [{ key: "lost", name: "Missing", slot: 2 }], ...r,
        summary: total ? `${says(c, total)} missing across ${plural(rows.length, "count line")}.` : "" };
    },
  },
  top_products: {
    name: "Best-selling products", blurb: "What distributors and super stockists sold most in a period.",
    title: "Best-selling products",
    subtitle: c => `Distributors' own sales (sales files and stock count drops) in the last ${c.days ?? 30} days.`,
    defaults: { days: 30, metric: "value", top: 10, labels: true },
    options: [{ key: "days", label: "Look back", min: 7, max: 365, suffix: "days" }, { key: "metric" }, { key: "top" }, { key: "scope", kinds: SELLERS }, { key: "labels" }],
    empty: "No sales recorded in this period.",
    async load(c, ctx) {
      const { ids } = scoped(ctx, c.scope, SELLERS);
      const items = (await load.period(c.days ?? 30)).filter(r => ids.has(r.location_id)).map(r => {
        const g = groupOf("product", ctx, r.location_id, r.product_id);
        return { key: g.key, label: g.label, values: [amount(c, ctx, r.product_id, Number(r.out_sale) + Number(r.out_count))] };
      });
      const r = rank(items, c.top ?? 10);
      return { type: "bars", unit: unitOf(c), series: [{ key: "sold", name: "Sold", slot: 3 }], ...r,
        summary: r.rows[0] ? `${r.rows[0].label} leads with ${says(c, r.rows[0].values[0])}.` : "" };
    },
  },
  slow_products: {
    name: "Products not moving", blurb: "Products sitting in stock that haven't sold anywhere in a period.",
    title: "Products not moving",
    subtitle: c => `Products in stock that didn't move out of any location in the last ${c.days ?? 60} days.`,
    defaults: { days: 60, metric: "value", top: 10, labels: true },
    options: [{ key: "days", label: "Not moved for", min: 15, max: 365, suffix: "days" }, { key: "metric" }, { key: "top" }, { key: "scope", kinds: KINDS }, { key: "labels" }],
    empty: "Every product in stock moved in this period.",
    async load(c, ctx) {
      const { ids } = scoped(ctx, c.scope, KINDS);
      const moved = new Set<string>(), held = new Map<string, number>();
      (await load.period(c.days ?? 60)).filter(r => ids.has(r.location_id)).forEach(r => {
        if (Number(r.qty_out) > 0) moved.add(r.product_id);
        if (Number(r.closing) > 0) held.set(r.product_id, (held.get(r.product_id) || 0) + Number(r.closing));
      });
      const items = [...held].filter(([p]) => !moved.has(p)).map(([p, q]) => ({ key: p, label: maps(ctx).prod.get(p)?.item_name || "Unknown product", values: [amount(c, ctx, p, q)] }));
      const r = rank(items, c.top ?? 10);
      return { type: "bars", unit: unitOf(c), series: [{ key: "stuck", name: "In stock", slot: 1 }], ...r,
        summary: items.length ? `${plural(items.length, "product")} didn't move.` : "" };
    },
  },
  so_claims: {
    name: "SO sales the distributor's data doesn't show", blurb: "SO-reported sales above what the distributor's own stock counts and sales files show.",
    title: "SO sales the distributor's data doesn't show",
    subtitle: c => `What SOs reported above the distributor's own sales in the last ${c.days ?? 30} days, by ${groupWord(c.groupBy)}.`,
    defaults: { days: 30, groupBy: "location", metric: "units", top: 10, labels: true },
    options: [{ key: "days", label: "Look back", min: 7, max: 180, suffix: "days" }, { key: "metric" },
      { key: "groupBy", label: "One bar for", choices: groupChoices("location", "product", "ss") }, { key: "top" }, { key: "scope", kinds: SELLERS }, { key: "labels" }],
    empty: "SO reports match what distributors' data shows.",
    async load(c, ctx) {
      const { ids } = scoped(ctx, c.scope, SELLERS);
      const items = (await load.vs(c.days ?? 30)).filter(r => ids.has(r.distributor_id) && Number(r.so_checked) > Number(r.dist_out)).map(r => {
        const g = groupOf(c.groupBy || "location", ctx, r.distributor_id, r.product_id);
        return { key: g.key, label: g.label, sub: g.sub, values: [amount(c, ctx, r.product_id, Number(r.so_checked) - Number(r.dist_out))] };
      });
      const r = rank(items, c.top ?? 10);
      const total = items.reduce((a, it) => a + it.values[0], 0);
      return { type: "bars", unit: unitOf(c), series: [{ key: "extra", name: "Extra claimed", slot: 2 }], ...r,
        summary: total ? `${says(c, total)} claimed beyond distributors' data.` : "" };
    },
  },
  new_outlets: {
    name: "Unverified outlets in SO reports", blurb: "Retailers SOs reported that aren't in your retailer list. Check new ones before they pile up.",
    title: "Unverified outlets in SO reports",
    subtitle: c => `Retailers in SO reports from the last ${c.days ?? 30} days that aren't in your retailer list, by ${c.groupBy === "location" ? "distributor" : "SO"}.`,
    defaults: { days: 30, groupBy: "so", top: 10, labels: true },
    options: [{ key: "days", label: "Look back", min: 7, max: 180, suffix: "days" },
      { key: "groupBy", label: "One bar for", choices: [{ id: "so", label: "Each SO" }, { id: "location", label: "Each distributor" }] }, { key: "top" }, { key: "labels" }],
    empty: "Every retailer in SO reports is in your list.",
    async load(c, ctx) {
      const byKey = new Map<string, { label: string; names: Set<string> }>();
      (await load.outlets(c.days ?? 30)).forEach(r => {
        const k = c.groupBy === "location" ? r.distributor_id : r.so_name;
        const label = c.groupBy === "location" ? maps(ctx).loc.get(r.distributor_id)?.name || "Deleted location" : r.so_name;
        const e = byKey.get(k) || { label, names: new Set<string>() };
        if (r.retailer_name) e.names.add(r.retailer_name.trim().toLowerCase());
        byKey.set(k, e);
      });
      const items = [...byKey].map(([k, e]) => ({ key: k, label: e.label, values: [e.names.size] }));
      const r = rank(items, c.top ?? 10);
      const total = items.reduce((a, it) => a + it.values[0], 0);
      return { type: "bars", unit: "count", series: [{ key: "outlets", name: "Outlets", slot: 1 }], ...r,
        summary: total ? `${plural(total, "outlet")} to verify.` : "" };
    },
  },
  dsr_trend: {
    name: "Secondary sales day by day", blurb: "What the sales team booked each day from their daily reports, by zone.",
    title: "Secondary sales day by day",
    subtitle: c => `Secondary sales from SO daily reports over the last ${c.days ?? 30} days${c.split === "zone" ? ", top zones" : ""}.`,
    defaults: { days: 30, split: "zone", labels: false },
    options: [{ key: "days", label: "Look back", min: 7, max: 365, suffix: "days" }, { key: "split", label: "Lines", choices: [{ id: "zone", label: "Top 3 zones and the rest" }, { id: "none", label: "One line for everyone" }] }, { key: "labels" }],
    empty: "No SO daily reports in this period. Upload DSRs on the SO Reports page.",
    async load(c, ctx) {
      const rows = await dsr(c.days ?? 30), days = [...Array(c.days ?? 30)].map((_, i) => daysAgo((c.days ?? 30) - 1 - i));
      const zoneOf = (r: DsrRow) => person(ctx, r.so_id)?.zone || r.state || "Other";
      const tot = new Map<string, number>(); rows.forEach(r => tot.set(zoneOf(r), (tot.get(zoneOf(r)) || 0) + Number(r.sale_value)));
      const top = c.split === "none" ? [] : [...tot].sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
      const keys = c.split === "none" ? ["All"] : [...top, ...(tot.size > top.length ? ["Other zones"] : [])];
      const values = keys.map(k => days.map(d => rows.filter(r => r.day === d && (k === "All" || (k === "Other zones" ? !top.includes(zoneOf(r)) : zoneOf(r) === k))).reduce((a, r) => a + Number(r.sale_value), 0)));
      const total = rows.reduce((a, r) => a + Number(r.sale_value), 0);
      return { type: "lines", unit: "money", series: keys.map((k, i) => ({ key: k, name: k, slot: (Math.min(i, 2) + 1) as 1 | 2 | 3 })), x: days.map(shortDate), values,
        summary: total ? `${money(total)} booked by the sales team in ${c.days ?? 30} days.` : "" };
    },
  },
  dsr_people: {
    name: "Best and weakest sales staff", blurb: "Secondary sales by person, zone or senior, from the daily reports.",
    title: "Secondary sales by person",
    subtitle: c => `Secondary sales in the last ${c.days ?? 30} days, by ${c.groupBy === "zone" ? "zone" : c.groupBy === "boss" ? "senior (ASM or ASE) and their team" : "person"}${c.split === "asc" ? ", lowest first" : ""}.`,
    defaults: { days: 30, groupBy: "so", split: "desc", top: 10, labels: true },
    options: [{ key: "days", label: "Look back", min: 1, max: 365, suffix: "days" },
      { key: "groupBy", label: "One bar for", choices: [{ id: "so", label: "Each person" }, { id: "zone", label: "Each zone" }, { id: "boss", label: "Each senior and team" }] },
      { key: "split", label: "Order", choices: [{ id: "desc", label: "Highest first" }, { id: "asc", label: "Lowest first" }] }, { key: "top" }, { key: "labels" }],
    empty: "No SO daily reports in this period.",
    async load(c, ctx) {
      const rows = await dsr(c.days ?? 30);
      const items = rows.map(r => {
        const p = person(ctx, r.so_id), boss = p?.manager_id ? person(ctx, p.manager_id) : undefined;
        const g = c.groupBy === "zone" ? { key: p?.zone || r.state || "Other", label: p?.zone || r.state || "Other" }
          : c.groupBy === "boss" ? { key: boss?.id || r.so_id, label: boss ? `${boss.name}'s team` : p?.name || "Unknown", sub: boss?.designation || undefined }
          : { key: r.so_id, label: p?.name || "Unknown", sub: [p?.designation, p?.hq].filter(Boolean).join(" · ") || undefined };
        return { ...g, values: [Number(r.sale_value)] };
      });
      const r = rank(items, c.top ?? 10, c.split === "asc" ? "asc" : "desc");
      const total = items.reduce((a, it) => a + it.values[0], 0);
      return { type: "bars", unit: "money", series: [{ key: "sec", name: "Secondary", slot: 1 }], ...r, summary: total ? `${money(total)} in ${c.days ?? 30} days.` : "" };
    },
  },
  dsr_products: {
    name: "What the sales team is selling", blurb: "Products or categories in the daily reports, by value or dozens.",
    title: "What the sales team is selling",
    subtitle: c => `Products in SO daily reports over the last ${c.days ?? 30} days, by ${c.groupBy === "category" ? "category" : "product"}.`,
    defaults: { days: 30, groupBy: "product", top: 10, labels: true },
    options: [{ key: "days", label: "Look back", min: 1, max: 365, suffix: "days" }, { key: "groupBy", label: "One bar for", choices: [{ id: "product", label: "Each product" }, { id: "category", label: "Each category" }] }, { key: "top" }, { key: "labels" }],
    empty: "No product lines in the daily reports for this period.",
    async load(c) {
      const rows = await dsrProducts(c.days ?? 30);
      const items = rows.map(p => ({ key: c.groupBy === "category" ? p.category || "Other" : p.product, label: c.groupBy === "category" ? p.category || "Other" : p.product, sub: c.groupBy === "category" ? undefined : p.category || undefined, values: [Number(p.value)] }));
      const r = rank(items, c.top ?? 10);
      return { type: "bars", unit: "money", series: [{ key: "v", name: "Sold", slot: 2 }], ...r, summary: r.rows[0] ? `${r.rows[0].label} leads with ${money(r.rows[0].values[0])}.` : "" };
    },
  },
  dsr_attendance: {
    name: "Days worked by the sales team", blurb: "Working days per person from the daily reports; the fewest first.",
    title: "Days worked",
    subtitle: c => `Days each person worked (present, half day or meeting) in the last ${c.days ?? 30} days, fewest first.`,
    defaults: { days: 30, top: 10, labels: true },
    options: [{ key: "days", label: "Look back", min: 7, max: 180, suffix: "days" }, { key: "top" }, { key: "labels" }],
    empty: "No SO daily reports in this period.",
    async load(c, ctx) {
      const rows = await dsr(c.days ?? 30);
      const m = new Map<string, number>(); rows.forEach(r => m.set(r.so_id, (m.get(r.so_id) || 0) + (WORKDAY.has(r.attendance || "") ? (r.attendance === "Half Day" ? 0.5 : 1) : 0)));
      const items = [...m].map(([id, v]) => ({ key: id, label: person(ctx, id)?.name || "Unknown", sub: person(ctx, id)?.hq || undefined, values: [v || 0.0001] }));
      const r = rank(items, c.top ?? 10, "asc");
      return { type: "bars", unit: "count", series: [{ key: "d", name: "Days worked", slot: 3 }], ...r, summary: items.length ? `${plural(items.length, "person", "people")} reported.` : "" };
    },
  },
  collection: {
    name: "Collection against billing", blurb: "How much of what was billed has been paid, by super stockist or distributor. Low collection with big orders is a red flag.",
    title: "Collection against billing",
    subtitle: c => `Payments as a share of billing over the last ${c.days ?? 90} days, by ${c.groupBy === "location" ? "distributor" : "super stockist"}, lowest first.`,
    defaults: { days: 90, groupBy: "ss", top: 10, labels: true },
    options: [{ key: "days", label: "Look back", min: 30, max: 365, suffix: "days" }, { key: "groupBy", label: "One bar for", choices: [{ id: "ss", label: "Each super stockist" }, { id: "location", label: "Each distributor" }] }, { key: "top" }, { key: "labels" }],
    empty: "No bills or payments in this period yet. Record payments on the Collections page.",
    async load(c, ctx) {
      const kind = c.groupBy === "location" ? "DISTRIBUTOR" : "SUPER_STOCKIST", { loc } = maps(ctx);
      const rows = (await bills(c.days ?? 90)).filter(b => b.party_type === "LOCATION" && loc.get(b.party_id)?.kind === kind && Number(b.billed) > 0);
      const items = rows.map(b => ({ key: b.party_id, label: loc.get(b.party_id)?.name || "Deleted", sub: `${money(b.collected)} of ${money(b.billed)}`, values: [Math.max(0.01, (Number(b.collected) / Number(b.billed)) * 100)] }));
      const r = rank(items, c.top ?? 10, "asc");
      const billed = rows.reduce((a, b) => a + Number(b.billed), 0), got = rows.reduce((a, b) => a + Number(b.collected), 0);
      return { type: "bars", unit: "pct", series: [{ key: "p", name: "Collected", slot: 1 }], ...r, summary: billed ? `${fmt((got / billed) * 100)}% collected overall (${money(got)} of ${money(billed)}).` : "" };
    },
  },
};

export const chartTitle = (c: ChartConfig) => c.title?.trim() || KIND_SPECS[c.kind].title;
export const newChart = (kind: ChartKind, extra: Partial<ChartConfig> = {}): ChartConfig =>
  ({ id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind, ...KIND_SPECS[kind].defaults, ...extra });
/** The ten charts that matter most to start with: four pinned (three large), the rest rotating with every other chart. */
export const defaultCharts = (): ChartConfig[] => [
  newChart("dsr_trend", { focus: true, pinned: true }), newChart("collection", { focus: true, pinned: true }), newChart("stock_trend", { focus: true, pinned: true }),
  newChart("dsr_people", { pinned: true }), newChart("dsr_products"), newChart("aged"), newChart("no_stock_sales"),
  newChart("running_low"), newChart("dsr_attendance"), newChart("stale"),
];
/** Drops charts of kinds this version doesn't know. */
export const cleanCharts = (list: unknown): ChartConfig[] =>
  Array.isArray(list) ? list.filter((c): c is ChartConfig => !!c && typeof c === "object" && (c as ChartConfig).kind in KIND_SPECS && typeof (c as ChartConfig).id === "string") : [];

// ---------- alerts ----------
export interface Alert { id: string; level: "high" | "medium"; text: string; kind?: ChartKind; page?: "Distributors"; value: number }

/** Things worth a look, worked out with fixed thresholds so they don't depend on how charts are set up. */
export async function loadAlerts(ctx: Ctx): Promise<Alert[]> {
  const { loc, prod } = maps(ctx);
  const L = (id: string) => loc.get(id)?.name || "a deleted location";
  const P = (id: string) => prod.get(id)?.item_name || "a product";
  const sellers = new Set(ctx.locations.filter(d => d.kind !== "GODOWN").map(d => d.id));
  const out: Alert[] = [];
  const safe = async (f: () => Promise<void>) => { try { await f(); } catch { /* one failing check shouldn't hide the others */ } };
  await Promise.all([
    safe(async () => {
      (await load.aged(90)).filter(r => sellers.has(r.location_id) && Number(r.aged_qty) > 0).map(r => ({ r, v: Number(r.aged_qty) * price(ctx, r.product_id) }))
        .sort((a, b) => b.v - a.v).slice(0, 4).forEach(({ r, v }) => {
          const age = r.oldest_in ? daysSince(r.oldest_in) : 90;
          out.push({ id: `aged-${r.location_id}-${r.product_id}`, level: age > 180 ? "high" : "medium", kind: "aged", value: v,
            text: `${fmt(r.aged_qty)} × ${P(r.product_id)} unsold at ${L(r.location_id)} for ${Math.max(3, Math.round(age / 30))} months (${money(v)}).` });
        });
    }),
    safe(async () => {
      (await load.activity()).forEach(r => {
        const usual = Number(r.base_value), now = Number(r.last_value);
        if (r.base_days < 5 || !usual || daysSince(r.last_day) > 7 || now < usual * 1.5) return;
        out.push({ id: `so-${r.so_id}`, level: now >= usual * 2 ? "high" : "medium", kind: "so_spikes", value: now - usual,
          text: `${r.so_name} reported ${money(now)} on ${shortDate(r.last_day)}, ${(now / usual).toFixed(1)}× their usual day.` });
      });
    }),
    safe(async () => {
      // One alert per location and product: the latest delivery.
      const latest = new Map<string, ReorderRow>();
      (await load.reorders(30, 60)).forEach(r => { const k = `${r.location_id}|${r.product_id}`; if (!latest.has(k) || r.received_on > latest.get(k)!.received_on) latest.set(k, r); });
      [...latest.values()].map(r => ({ r, v: Number(r.qty_received) * price(ctx, r.product_id) })).sort((a, b) => b.v - a.v).slice(0, 4).forEach(({ r, v }) => {
        out.push({ id: `re-${r.location_id}-${r.product_id}-${r.received_on}`, level: "medium", kind: "reorders", value: v,
          text: `${L(r.location_id)} took ${fmt(r.qty_received)} more ${P(r.product_id)} on ${shortDate(r.received_on)} while holding ${r.cover_days === null ? "stock that wasn't selling" : `${fmt(r.cover_days)} days of it`}.` });
      });
    }),
    safe(async () => {
      const worst = new Map<string, OversellRow & { gap: number }>();
      (await load.oversell(30)).forEach(r => { const gap = Number(r.so_total) - Number(r.available), k = `${r.distributor_id}|${r.product_id}`; if (gap > (worst.get(k)?.gap || 0)) worst.set(k, { ...r, gap }); });
      [...worst.values()].sort((a, b) => b.gap * price(ctx, b.product_id) - a.gap * price(ctx, a.product_id)).slice(0, 4).forEach(r => {
        out.push({ id: `os-${r.distributor_id}-${r.product_id}`, level: "high", kind: "no_stock_sales", value: r.gap * price(ctx, r.product_id),
          text: `${r.so_names} reported ${fmt(r.so_total)} × ${P(r.product_id)} at ${L(r.distributor_id)}${Number(r.available) > 0 ? `, which only had ${fmt(r.available)}` : ", which had none"}.` });
      });
    }),
    safe(async () => {
      (await load.period(30)).filter(r => Number(r.qty_out) >= 10).map(r => ({ r, cover: Number(r.closing) / (Number(r.qty_out) / 30) }))
        .filter(x => x.cover < 3).sort((a, b) => a.cover - b.cover).slice(0, 4).forEach(({ r, cover }) => {
          out.push({ id: `low-${r.location_id}-${r.product_id}`, level: "medium", kind: "running_low", value: Number(r.qty_out) * price(ctx, r.product_id),
            text: cover <= 0 ? `${L(r.location_id)} has run out of ${P(r.product_id)}, a fast seller.` : `${L(r.location_id)} will run out of ${P(r.product_id)} in about ${formatValue("days", Math.round(cover * 10) / 10)}.` });
        });
    }),
    safe(async () => {
      const status = new Map((await load.status()).map(s => [s.location_id, s]));
      const quiet = ctx.locations.filter(d => d.kind !== "GODOWN").map(d => {
        const s = status.get(d.id), own = [s?.last_count, s?.last_sale, s?.last_file].filter(Boolean).sort().pop() || null;
        return { d, days: daysSince(own || d.created_at || today()) };
      }).filter(x => x.days > 15).sort((a, b) => b.days - a.days);
      if (quiet.length > 3) out.push({ id: "stale-many", level: "medium", kind: "stale", value: 0, text: `${plural(quiet.length, "distributor")} haven't sent stock data for over 15 days.` });
      else quiet.forEach(x => out.push({ id: `stale-${x.d.id}`, level: "medium", kind: "stale", value: 0, text: `${x.d.name} hasn't sent stock data for ${x.days} days.` }));
    }),
    safe(async () => {
      const byLoc = new Map<string, { v: number; on: string }>();
      (await load.counts(30)).filter(r => Number(r.change) < 0).forEach(r => {
        const e = byLoc.get(r.location_id) || { v: 0, on: r.counted_on };
        e.v += -Number(r.change) * price(ctx, r.product_id); if (r.counted_on > e.on) e.on = r.counted_on;
        byLoc.set(r.location_id, e);
      });
      [...byLoc].sort((a, b) => b[1].v - a[1].v).slice(0, 3).forEach(([id, e]) => {
        out.push({ id: `count-${id}`, level: e.v >= 10000 ? "high" : "medium", kind: "count_losses", value: e.v,
          text: `${money(e.v)} of stock missing at ${whose(L(id))} stock count on ${shortDate(e.on)}.` });
      });
    }),
  ]);
  const incomplete = ctx.locations.filter(d => missingFields(d).length).length;
  if (incomplete) out.push({ id: "incomplete", level: "medium", page: "Distributors", value: 0, text: `${plural(incomplete, "location")} ${incomplete === 1 ? "has" : "have"} empty details.` });
  return out.sort((a, b) => (a.level === b.level ? b.value - a.value : a.level === "high" ? -1 : 1));
}
