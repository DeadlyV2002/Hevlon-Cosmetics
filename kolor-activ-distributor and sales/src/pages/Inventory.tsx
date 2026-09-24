import { useEffect, useMemo, useRef, useState } from "react";
import {
  Mode, Row, Field, Table, Layout, Skipped, FIELD_LABELS, emptyRow, today, localDate, isValidDate,
  detectLayout, extractRows, titleText, cellText, formatSignature, normName, headingDate,
} from "../lib/parse";
import { readAnyFile, fileHash, ACCEPT } from "../lib/readers";
import { detectFile, Detection, FileType } from "../lib/detect";
import {
  supabase, Distributor, Product, ProductAlias, StockLine, SalesOfficer, Retailer, Kind, KINDS, KIND_LABEL, KIND_PLURAL,
  matchDistributor, matchProduct, matchSO, fetchAll, fmt, plural, errText,
} from "../lib/supabase";
import StockDownload from "../components/StockDownload";
import LocationForm from "../components/LocationForm";

const TYPES: { id: FileType; label: string; help: string }[] = [
  { id: "COUNT", label: "Closing stock", help: "A stock count: Tally Stock Summary, a stock statement, or your stock format. The location's stock is set to these quantities and the difference is recorded. Products not in the file keep their stock." },
  { id: "IN", label: "Stock received", help: "Purchases and receipts. Stock received from one of your godowns, super stockists or distributors is a transfer: their stock goes down by the same amount." },
  { id: "OUT", label: "Stock sent out", help: "Sales and dispatches. Stock sent to one of your super stockists or distributors is a transfer: their stock goes up. Anything else is a sale (to a retailer, or an outside buyer from a godown)." },
  { id: "SO", label: "SO daily report", help: "What a sales officer says they sold. It doesn't change anyone's stock; the SO checks page compares it with the distributor's stock and sales." },
];
const MODE_OF: Record<FileType, Mode> = { COUNT: "COUNT", IN: "INPUT", OUT: "OUTPUT", SO: "SO" };
const shiftDate = (d: string, days: number) => { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + days); return localDate(x); };
const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;

type ERow = Row & { include?: boolean };
interface Existing { distributor_id: string; counterparty_id: string | null; product_id: string; transaction_date: string; quantity: number; reference: string | null }
interface Checked { p?: Product; h?: Distributor; partyLoc?: Distributor; cur: number; problems: string[]; notes: string[]; excluded: boolean; senderShort: boolean }

interface Props {
  locations: Distributor[]; products: Product[]; aliases: ProductAlias[]; stock: StockLine[]; officers: SalesOfficer[]; retailers: Retailer[];
  canManage: boolean; onPosted: () => Promise<void>; onListsChanged: () => Promise<void>; notify: (m: string) => void;
}

export default function Inventory({ locations, products, aliases, stock, officers, retailers, canManage, onPosted, onListsChanged, notify }: Props) {
  const [type, setType] = useState<FileType>("COUNT");
  const [detection, setDetection] = useState<Detection | null>(null);
  const [table, setTable] = useState<Table | null>(null);
  const [sheet, setSheet] = useState(0);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [file, setFile] = useState<{ name: string; hash: string; heading: string } | null>(null);
  const [holder, setHolder] = useState("");
  const [soDefault, setSoDefault] = useState("");
  const [date, setDate] = useState(today());
  const [rows, setRows] = useState<ERow[]>([]);
  const [skipped, setSkipped] = useState<Skipped[]>([]);
  const [busy, setBusy] = useState("");
  const [showSkipped, setShowSkipped] = useState(false);
  const [savedFormat, setSavedFormat] = useState(false);
  const [aliasPlan, setAliasPlan] = useState<Record<string, { productId: string; name: string }>>({});
  const [reduceSender, setReduceSender] = useState(true);
  const [existing, setExisting] = useState<Existing[]>([]);
  const [status, setStatus] = useState<{ kind: "err" | "ok" | "info"; text: string } | null>(null);
  const [adding, setAdding] = useState<{ name: string; kind: Kind } | null>(null);
  const [fix, setFix] = useState<Record<string, string>>({});
  const reviewRef = useRef<HTMLDivElement>(null);

  const mode = MODE_OF[type];
  const grid = table?.sheets[sheet]?.grid || [];
  const say = (kind: "err" | "ok" | "info", text: string) => { setStatus({ kind, text }); notify(text); };
  const holderLoc = matchDistributor(holder, locations);

  function extract(t: Table, sh: number, l: Layout, tp: FileType, h: string, d: string, so: string) {
    const res = extractRows(t.sheets[sh]?.grid || [], l, MODE_OF[tp], { distributor: h, date: d, so }, t.fillDown !== false);
    setRows(res.rows); setSkipped(res.skipped);
    return res;
  }

  /** Detect columns, then use the saved column setup for files with the same headings. */
  async function layoutFor(g: Table["sheets"][number]["grid"], m: Mode): Promise<{ l: Layout; saved: boolean }> {
    const l = detectLayout(g, m);
    if (!supabase || l.headerRow < 0) return { l, saved: false };
    const { data } = await supabase.from("import_formats").select("mapping").eq("signature", `${m}:${formatSignature(l)}`).maybeSingle();
    const saved = data?.mapping as Field[] | undefined;
    if (saved && saved.length === l.labels.length) return { l: { ...l, mapping: saved }, saved: true };
    return { l, saved: false };
  }

  async function load(t: Table, sh: number, tp: FileType, f: { name: string; hash: string } | null, det: Detection | null) {
    const g = t.sheets[sh]?.grid || [];
    const { l, saved } = await layoutFor(g, MODE_OF[tp]);
    const heading = titleText(g, l);
    let h = holder, so = soDefault, d = date;
    if (det) { h = det.holder; so = det.so; d = headingDate(`${heading} ${f?.name || ""}`) || today(); }
    setHolder(h); setSoDefault(so); setDate(d);
    if (f) setFile({ ...f, heading });
    else setFile(x => (x ? { ...x, heading } : x));
    setLayout(l); setSavedFormat(saved); setAliasPlan({}); setReduceSender(true); setAdding(null);
    return { l, res: extract(t, sh, l, tp, h, d, so) };
  }

  async function onFile(f: File) {
    setBusy(`Reading ${f.name}…`); setStatus(null);
    try {
      const [t, hash] = await Promise.all([readAnyFile(f, setBusy), fileHash(f)]);
      if (!t.sheets.length) throw new Error("The file is empty.");
      const g = t.sheets[0].grid, l0 = detectLayout(g, "COUNT");
      const det = detectFile(g, l0, titleText(g, l0), f.name, locations, officers);
      setDetection(det); setType(det.type); setTable(t); setSheet(0);
      const { l, res } = await load(t, 0, det.type, { name: f.name, hash }, det);
      if (l.headerRow < 0) say("info", `Couldn't find column headings in ${f.name}. Pick what each column is under "Columns"; the app remembers it for next time.`);
      else say("info", `${plural(res.rows.length, "row")} read from ${f.name}.${res.skipped.length ? ` ${plural(res.skipped.length, "line")} left out (totals, groups, blanks).` : ""} Check them, then save.`);
      if (t.note) notify(t.note);
      setTimeout(() => reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } catch (e) { say("err", `Could not read the file: ${errText(e)}`); }
    finally { setBusy(""); }
  }

  function changeType(tp: FileType) { setType(tp); setStatus(null); if (table) load(table, sheet, tp, null, null); }
  function changeSheet(i: number) { setSheet(i); if (table) load(table, i, type, null, null); }
  function changeColumn(i: number, f: Field) {
    if (!layout || !table) return;
    const mapping = layout.mapping.map((m, j) => (j === i ? f : f !== "ignore" && m === f ? "ignore" : m)) as Field[];
    const l = { ...layout, mapping };
    setLayout(l); setSavedFormat(false); extract(table, sheet, l, type, holder, date, soDefault);
  }
  /** Top-of-form choices apply to every row. The date only replaces dates that came from the old default. */
  function setAll(k: "distributor" | "date" | "so", v: string) {
    if (k === "distributor") setHolder(v); else if (k === "so") setSoDefault(v); else setDate(v);
    setRows(rs => rs.map(r => (k === "date" ? (r.date === date ? { ...r, date: v } : r) : { ...r, [k]: v })));
  }
  function updateRow(i: number, k: keyof ERow, v: string | boolean) {
    setRows(rs => rs.map((r, j) => (j === i ? { ...r, [k]: k === "quantity" || k === "unit_price" ? Number(String(v).replace(/,/g, "")) || 0 : v } : r)));
  }
  function restore(s: Skipped) { if (s.row) { setRows(rs => [...rs, s.row!]); setSkipped(ss => ss.filter(x => x !== s)); } }
  function clearAll() { setTable(null); setLayout(null); setRows([]); setSkipped([]); setFile(null); setDetection(null); setAliasPlan({}); setStatus(null); setAdding(null); setExisting([]); }

  /** "This name in the file = that existing product": applied to every row with the same name and remembered on save. */
  function matchTo(original: string, value: string) {
    const p = products.find(x => `${x.sku} — ${x.item_name}` === value);
    const key = normName(original);
    if (!p) {
      setAliasPlan(a => { const { [key]: _, ...rest } = a; return rest; });
      setRows(rs => rs.map(r => (normName(r.item_name) === key && aliasPlan[key] ? { ...r, sku: "" } : r)));
      return;
    }
    setAliasPlan(a => ({ ...a, [key]: { productId: p.id, name: original } }));
    setRows(rs => rs.map(r => (normName(r.item_name) === key ? { ...r, sku: p.sku } : r)));
  }

  // ---------- transfers already recorded from the other side ----------
  // The receiving leg of a transfer always exists once posted, so look for it: at the holder for
  // stock received, or anywhere the holder sent stock (counterparty = holder) for stock sent out.
  const transferQuery = useMemo(() => {
    if (type !== "IN" && type !== "OUT") return "";
    const ids = new Set<string>(); let min = "", max = "";
    rows.forEach(r => {
      const h = matchDistributor(r.distributor, locations), pl = r.retailer.trim() ? matchDistributor(r.retailer, locations) : undefined;
      if (!h || !pl || pl.id === h.id || !isValidDate(r.date)) return;
      ids.add(h.id);
      if (!min || r.date < min) min = r.date;
      if (!max || r.date > max) max = r.date;
    });
    return ids.size ? JSON.stringify({ field: type === "IN" ? "distributor_id" : "counterparty_id", ids: [...ids].sort(), min, max }) : "";
  }, [rows, type, locations]);
  useEffect(() => {
    if (!supabase || !transferQuery) { setExisting([]); return; }
    const q: { field: "distributor_id" | "counterparty_id"; ids: string[]; min: string; max: string } = JSON.parse(transferQuery);
    let live = true;
    fetchAll<Existing>((a, b) => supabase!.from("inventory_transactions").select("distributor_id,counterparty_id,product_id,transaction_date,quantity,reference")
      .eq("source", "TRANSFER").eq("mode", "INPUT").in(q.field, q.ids).gte("transaction_date", shiftDate(q.min, -20)).lte("transaction_date", shiftDate(q.max, 20)).order("id").range(a, b))
      .then(d => { if (live) setExisting(d); }).catch(() => { if (live) setExisting([]); });
    return () => { live = false; };
  }, [transferQuery]);

  // ---------- row checks ----------
  const stockMap = useMemo(() => new Map(stock.map(s => [`${s.distributor_id}|${s.product_id}`, Number(s.current_stock)])), [stock]);
  const retailersByName = useMemo(() => {
    const m = new Map<string, Retailer[]>();
    retailers.forEach(r => { const k = normName(r.name); m.set(k, [...(m.get(k) || []), r]); });
    return m;
  }, [retailers]);
  const locById = useMemo(() => new Map(locations.map(d => [d.id, d])), [locations]);

  const checked = useMemo<Checked[]>(() => {
    const used = new Map<string, number>(), taken = new Set<number>();
    return rows.map(r => {
      const problems: string[] = [], notes: string[] = [];
      let excluded = false, senderShort = false;
      const p = matchProduct(r.sku, r.item_name, products, aliases);
      if (!r.sku.trim() && !r.item_name.trim()) problems.push("product missing");
      if (!isValidDate(r.date)) problems.push("date must be a valid date");
      if (type === "COUNT") {
        if (!holderLoc) problems.push("choose whose stock this is (above)");
        if (r.quantity < 0) problems.push("negative quantity");
        return { p, h: holderLoc, cur: holderLoc && p ? stockMap.get(`${holderLoc.id}|${p.id}`) ?? 0 : 0, problems, notes, excluded, senderShort };
      }
      if (!(r.quantity > 0)) problems.push("quantity must be more than 0");
      const h = matchDistributor(r.distributor, locations);
      if (type === "SO") {
        if (!matchSO(r.so, officers)) problems.push(r.so ? `SO "${r.so}" isn't in your SO list` : "SO missing");
        if (!h) problems.push(r.distributor ? `"${r.distributor}" isn't in your list` : "distributor missing");
        if (!p && (r.sku.trim() || r.item_name.trim())) problems.push("product not found: pick it under “Same as”");
        const name = r.retailer.trim();
        if (!name) notes.push("no retailer");
        else if (h) {
          const hits = retailersByName.get(normName(name)) || [];
          if (!hits.some(x => x.distributor_id === h.id)) {
            const other = hits.map(x => locById.get(x.distributor_id || "")).find(x => x && (!h.state || !x.state || x.state === h.state));
            notes.push(other ? `retailer is under ${other.name}` : "retailer not in your list");
          }
        }
        return { p, h, cur: 0, problems, notes, excluded, senderShort };
      }
      if (!h) problems.push(r.distributor ? `"${r.distributor}" isn't in your list` : "choose whose stock this is (above)");
      const party = r.retailer.trim();
      const pl = party ? matchDistributor(party, locations) : undefined;
      const partyLoc = pl && h && pl.id !== h.id ? pl : undefined;
      if (type === "OUT") {
        if (!p && (r.sku.trim() || r.item_name.trim())) problems.push("product never stocked in: match it to an existing product");
        if (!party) problems.push("who received it? (party missing)");
      }
      if (partyLoc && h && p) {
        const receiver = type === "IN" ? h : partyLoc, sender = type === "IN" ? partyLoc : h;
        const i = existing.findIndex((e, j) => !taken.has(j) && e.distributor_id === receiver.id && e.counterparty_id === sender.id && e.product_id === p.id
          && Number(e.quantity) === r.quantity && daysApart(e.transaction_date, r.date) <= 20
          && (!r.reference.trim() || !e.reference || normName(e.reference) === normName(r.reference)));
        if (i >= 0) {
          taken.add(i);
          excluded = !r.include;
          notes.push(`already recorded on ${existing[i].transaction_date}${existing[i].reference ? ` (${existing[i].reference})` : ""}`);
        }
      }
      if (!excluded && h) {
        const sender = type === "OUT" ? h : partyLoc;
        const reduces = type === "OUT" ? !partyLoc || reduceSender : !!partyLoc && reduceSender;
        if (sender && reduces && (p || type === "IN")) {
          const key = `${sender.id}|${p?.id || ""}`, have = p ? stockMap.get(key) ?? 0 : 0, before = used.get(key) || 0;
          used.set(key, before + r.quantity);
          if (before + r.quantity > have) {
            senderShort = !!partyLoc;
            problems.push(`${sender.name} has only ${fmt(Math.max(have - before, 0))} in the app`);
          }
        }
      }
      if (partyLoc) notes.push(`transfer ${type === "OUT" ? "to" : "from"} ${partyLoc.name}`);
      else if (party && h) notes.push(type === "IN" ? "purchase"
        : h.kind === "GODOWN" ? "sale to outside buyer"
        : (retailersByName.get(normName(party)) || []).some(x => x.distributor_id === h.id) ? "sale to retailer" : "sale · new retailer");
      return { p, h, partyLoc, cur: 0, problems, notes, excluded, senderShort };
    });
  }, [rows, type, holderLoc, products, aliases, stockMap, existing, reduceSender, locations, officers, retailersByName, locById]);

  const live = checked.filter(c => !c.excluded);
  const problemRows = checked.map((c, i) => (!c.excluded && c.problems.length ? i : -1)).filter(i => i >= 0);
  const nExcluded = checked.length - live.length;
  const nTransfers = live.filter(c => c.partyLoc).length;
  const anySenderShort = checked.some(c => c.senderShort);
  const newProducts = type === "COUNT" || type === "IN"
    ? new Set(rows.filter((r, i) => checked[i] && !checked[i].excluded && !checked[i].p).map(r => normName(r.item_name || r.sku))).size : 0;

  // ---------- names the app doesn't know yet ----------
  const unknownLocs = useMemo(() => {
    const s = new Set<string>();
    if (type === "COUNT") { if (!holderLoc && holder.trim()) s.add(holder.trim()); }
    else rows.forEach(r => { if (r.distributor.trim() && !matchDistributor(r.distributor, locations)) s.add(r.distributor.trim()); });
    return [...s];
  }, [rows, holder, holderLoc, locations, type]);
  const unknownParties = useMemo(() => {
    if (type !== "IN" && type !== "OUT") return [];
    const s = new Set<string>();
    rows.forEach(r => {
      const h = matchDistributor(r.distributor, locations), party = r.retailer.trim();
      // Godowns and super stockists send mostly to your own network; distributors and SS receive mostly from it.
      if (h && party && (type === "OUT" ? h.kind !== "DISTRIBUTOR" : h.kind !== "GODOWN") && !matchDistributor(party, locations)) s.add(party);
    });
    return [...s];
  }, [rows, locations, type]);
  const unknownSOs = useMemo(() => (type === "SO" ? [...new Set(rows.map(r => r.so.trim()).filter(s => s && !matchSO(s, officers)))] : []), [rows, officers, type]);

  async function saveLocationAlias(name: string, code: string) {
    const d = locations.find(x => x.code === code);
    if (!supabase || !d || !name.trim()) return;
    const { error } = await supabase.from("distributors").update({ aliases: [...new Set([...(d.aliases || []), name.trim()])] }).eq("id", d.id);
    if (error) return say("err", `Could not save: ${error.code === "42501" ? "only HO admins and state managers can do this" : error.message}`);
    await onListsChanged();
    say("ok", `"${name}" saved as another name for ${d.name}. Files with this name match automatically from now on.`);
  }
  async function saveSOAlias(name: string, id: string) {
    const s = officers.find(x => x.id === id);
    if (!supabase || !s) return;
    const { error } = await supabase.from("sales_officers").update({ aliases: [...new Set([...(s.aliases || []), name.trim()])] }).eq("id", id);
    if (error) return say("err", `Could not save: ${error.message}`);
    await onListsChanged();
    say("ok", `"${name}" saved as another name for ${s.name}.`);
  }
  async function addSO(name: string) {
    if (!supabase || !name.trim()) return;
    const n = Math.max(0, ...officers.map(o => Number(o.code.match(/^SO(\d+)$/i)?.[1] || 0))) + 1;
    const { error } = await supabase.from("sales_officers").insert({ code: `SO${String(n).padStart(3, "0")}`, name: name.trim() });
    if (error) return say("err", `Could not add: ${error.code === "42501" ? "only HO admins and state managers can add SOs" : error.message}`);
    await onListsChanged();
    say("ok", `Added ${name.trim()} to your SO list. Add their phone and area on the SO checks page.`);
  }

  // ---------- save ----------
  const blocker = !rows.length ? "Nothing to save yet."
    : !live.length ? "Every row is already recorded, so there's nothing new to save."
    : problemRows.length ? `${problemRows.length} row${problemRows.length > 1 ? "s" : ""} need fixing: see the red "Check" column${unknownLocs.length || unknownSOs.length || (type === "COUNT" && !holderLoc) ? " and the yellow box above the table" : ""}.`
    : "";

  async function post(allowDuplicate = false): Promise<void> {
    if (!supabase) return;
    if (blocker) {
      say("err", blocker);
      document.querySelector("tr.bad")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const send = rows.filter((_, i) => !checked[i].excluded);
    const what = type === "COUNT" ? `Set stock at ${holderLoc?.name} to the counted quantities of ${send.length} products?`
      : type === "SO" ? `Save ${send.length} SO report lines?`
      : `Save ${plural(send.length, "row")} of stock ${type === "IN" ? "received" : "sent out"}${nTransfers ? `, including ${plural(nTransfers, "transfer")} between your locations` : ""}?`;
    if (!allowDuplicate && !confirm(`${what}${newProducts ? `\n\n${plural(newProducts, "new product")} will be created.` : ""}${nExcluded ? `\n\n${plural(nExcluded, "row")} already recorded will be skipped.` : ""}`)) return;
    setBusy("Saving…"); setStatus({ kind: "info", text: "Saving…" });
    const clean = send.map(({ include: _, ...r }) => ({ ...r, distributor: r.distributor.trim(), sku: r.sku.trim(), item_name: r.item_name.trim(), retailer: r.retailer.trim(), so: r.so.trim() }));
    const common = { p_source_file: file?.name ?? "manual entry", p_file_hash: file?.hash ?? null, p_allow_duplicate: allowDuplicate };
    const { data, error } = type === "COUNT"
      ? await supabase.rpc("post_stock_count", { p_distributor: holderLoc!.code, p_rows: clean, p_date: date, ...common })
      : type === "SO"
        ? await supabase.rpc("post_so_report", { p_rows: clean, ...common })
        : await supabase.rpc("post_movements", { p_type: type, p_rows: clean, p_holder: holderLoc?.code ?? null, p_reduce_sender: reduceSender, ...common });
    setBusy("");
    if (error) {
      if (error.message.startsWith("DUPLICATE_FILE")) {
        if (confirm(`${error.message.replace("DUPLICATE_FILE: ", "")}.\n\nSaving it again will count it twice. Save anyway?`)) return post(true);
        return say("err", "Not saved: this file was already posted.");
      }
      return say("err", `Save failed: ${error.message}`);
    }
    // Learn from this upload: the column layout and any product matches.
    if (layout && table && layout.headerRow >= 0)
      await supabase.from("import_formats").upsert({ signature: `${mode}:${formatSignature(layout)}`, mapping: layout.mapping, labels: layout.labels, updated_at: new Date().toISOString() });
    for (const a of Object.values(aliasPlan)) await supabase.from("product_aliases").insert({ product_id: a.productId, alias: a.name });

    const skippedNote = nExcluded ? ` ${plural(nExcluded, "row")} already recorded ${nExcluded === 1 ? "was" : "were"} skipped.` : "";
    const msg = type === "COUNT" ? `Stock count saved for ${holderLoc?.name}: ${data.increased} products up, ${data.decreased} down, ${data.unchanged} unchanged. Undo is on the History page.`
      : type === "SO" ? `Saved ${plural(data.posted_rows, "SO report line")}. The SO checks page compares them with distributor stock.`
      : `Saved ${plural(data.posted_rows, "row")}${data.transfers ? `, including ${plural(data.transfers, "transfer")}` : ""}.${skippedNote} Undo is on the History page.`;
    clearAll(); say("ok", msg);
    await onPosted();
  }

  // ---------- layout ----------
  const showLocCol = type !== "COUNT" && type !== "SO" && (layout?.mapping.includes("distributor") || new Set(rows.map(r => r.distributor)).size > 1);
  const cols: (keyof Row)[] = type === "COUNT" ? ["sku", "item_name", "quantity", "unit_price"]
    : type === "SO" ? ["date", "so", "distributor", "retailer", "sku", "item_name", "quantity", "unit_price"]
    : ["date", "reference", ...(showLocCol ? ["distributor" as const] : []), "retailer", "sku", "item_name", "quantity", "unit_price"];
  const COL_LABEL: Record<keyof Row, string> = {
    date: "Date", reference: "Invoice / ref", distributor: type === "SO" ? "Distributor" : "Location", so: "SO",
    retailer: type === "IN" ? "Received from" : type === "OUT" ? "Sent to" : "Retailer",
    sku: "SKU", item_name: "Product (as in file)", quantity: type === "COUNT" ? "Counted qty" : "Qty", unit_price: "Rate",
  };
  const saveLabel = type === "COUNT" ? "Save stock count" : type === "SO" ? "Save SO report" : `Save stock ${type === "IN" ? "received" : "sent out"}`;
  const info = TYPES.find(t => t.id === type)!;
  const locOptions = (skipGodowns: boolean) => KINDS.filter(k => !(skipGodowns && k === "GODOWN")).map(k => <optgroup key={k} label={KIND_PLURAL[k]}>
    {locations.filter(d => d.kind === k).map(d => <option key={d.id} value={d.code}>{d.name} ({d.code})</option>)}</optgroup>);
  const showFixes = rows.length > 0 && (unknownLocs.length > 0 || unknownSOs.length > 0 || unknownParties.length > 0 || (type === "COUNT" && !holderLoc));

  return <>
    <StockDownload locations={locations} products={products} stock={stock} notify={notify} />

    <section className="card upload">
      <div className="rowhead"><div><h2>Upload a file</h2><p>Drop in any stock file. The app works out what it is and whose stock it is; check its guess below.</p></div></div>
      <label className="drop">
        <input type="file" accept={ACCEPT} disabled={!!busy} onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
        <b>{busy || "Choose a file"}</b>
        <small>Your Excel format, any Excel / CSV, Tally exports (Excel, XML, JSON, HTML, TXT, PDF), scanned PDFs, photos, SO daily sheets</small>
      </label>
      <div className="tabs types">{TYPES.map(t => <button key={t.id} className={type === t.id ? "active" : ""} onClick={() => changeType(t.id)}>{t.label}</button>)}</div>
      {detection && file ? <div className={`detect${detection.sure ? "" : " unsure"}`}>
        <b>{detection.sure ? "Read as" : "Best guess"}: {TYPES.find(t => t.id === detection.type)!.label.toLowerCase()}{type !== detection.type ? ` (you changed it to ${info.label.toLowerCase()})` : ""}</b>
        <small>Because {detection.reasons.join("; ")}.{!detection.sure && " If that's wrong, pick the right type above."}</small>
      </div> : null}
      <p className="hint">{info.help}</p>
      {type === "COUNT" && <p className="hint">From Tally: <b>Stock Summary</b> → <b>Alt+F5</b> (Detailed) → <b>Alt+E</b> Export → Excel or XML.</p>}
      <div className="bulk">
        <label>{type === "SO" ? "Distributor for all rows" : "Whose stock"}
          <select value={holderLoc?.code || ""} onChange={e => (e.target.value ? setAll("distributor", e.target.value) : setHolder(""))}>
            <option value="">{holder && !holderLoc ? `"${holder}" — not in your list` : type === "SO" || showLocCol ? "As in each row" : "Choose…"}</option>
            {locOptions(type === "SO")}
          </select></label>
        {type === "SO" && <label>SO for all rows<select value={matchSO(soDefault, officers)?.code || ""} onChange={e => (e.target.value ? setAll("so", e.target.value) : setSoDefault(""))}>
          <option value="">{soDefault && !matchSO(soDefault, officers) ? `"${soDefault}" — not in your list` : "As in each row"}</option>
          {officers.map(o => <option key={o.id} value={o.code}>{o.name} ({o.code})</option>)}</select></label>}
        <label>{type === "COUNT" ? "Stock count date" : "Date for rows with no date in the file"}<input type="date" value={date} onChange={e => setAll("date", e.target.value)} /></label>
      </div>
      {!locations.length && <p className="warn">No locations yet. Add your godown, super stockists and distributors on the Distributors page first.</p>}
      <button className="secondary" onClick={() => setRows(rs => [...rs, { ...emptyRow(), distributor: holder, date, so: soDefault }])}>+ Add row by hand</button>
    </section>

    {table && layout && <section className="card">
      <div className="rowhead"><h2>Columns in {file?.name}</h2>
        {table.sheets.length > 1 && <label className="inline">Sheet <select value={sheet} onChange={e => changeSheet(Number(e.target.value))}>{table.sheets.map((s, i) => <option key={i} value={i}>{s.name}</option>)}</select></label>}
      </div>
      <p className="hint">{savedFormat
        ? <><span className="tag">saved format</span> Columns set the same way as the last file with these headings.</>
        : <>Check what each column is and correct any that are wrong. When you save, the app remembers this setup for every future file with the same headings.</>}</p>
      {file?.heading && <p className="hint">File heading: <b>{file.heading.slice(0, 160)}</b></p>}
      <div className="tablewrap"><table className="map"><tbody>
        <tr>{layout.labels.map((l, i) => <td key={i}><small>{l || `column ${i + 1}`}</small>
          <select value={layout.mapping[i] || "ignore"} onChange={e => changeColumn(i, e.target.value as Field)}>
            {(Object.keys(FIELD_LABELS) as Field[]).map(f => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}
          </select>
          <small className="sample">{cellText(grid[layout.headerRow + Math.max(layout.headerRows, 1)]?.[i]).slice(0, 24)}</small></td>)}</tr>
      </tbody></table></div>
    </section>}

    {(rows.length > 0 || skipped.length > 0) && <section className="card" ref={reviewRef}>
      <div className="rowhead"><h2>Review ({plural(rows.length, "row")}{problemRows.length ? `, ${problemRows.length} need fixing` : ""}{nExcluded ? `, ${nExcluded} already recorded` : ""})</h2>
        <div className="actions"><button className="secondary" onClick={clearAll}>Clear</button>
          <button onClick={() => post()} disabled={!!busy || !rows.length}>{busy === "Saving…" ? "Saving…" : saveLabel}</button></div></div>
      {status && <div className={`status ${status.kind}`}>{status.text}</div>}
      {!status && blocker && rows.length > 0 && <div className="status err">{blocker}</div>}

      {showFixes && <div className="fixbox">
        {(unknownLocs.length > 0 || (type === "COUNT" && !holderLoc)) && <div className="fixgroup">
          <b>{unknownLocs.length ? `Not in your list: ${unknownLocs.map(n => `"${n}"`).join(", ")}` : "Whose stock is this file? Choose above."}</b>
          {canManage && unknownLocs.slice(0, 5).map(name => <div className="fixrow" key={name}>
            <span className="fixname">{name}</span>
            <label>It is the same as…<select value={fix[`loc:${name}`] || ""} onChange={e => setFix({ ...fix, [`loc:${name}`]: e.target.value })}>
              <option value="">choose…</option>{locOptions(type === "SO")}</select></label>
            <button disabled={!fix[`loc:${name}`]} onClick={() => saveLocationAlias(name, fix[`loc:${name}`])}>Save as its other name</button>
            <span className="or">or add as new</span>
            {(type === "SO" ? (["DISTRIBUTOR", "SUPER_STOCKIST"] as Kind[]) : KINDS).map(k => <button key={k} className="secondary small" onClick={() => setAdding({ name, kind: k })}>{KIND_LABEL[k]}</button>)}
          </div>)}
          {!canManage && <p className="hint">Pick the right one in the box above, or ask an HO admin to add this name on the Distributors page.</p>}
        </div>}
        {unknownParties.length > 0 && <div className="fixgroup">
          <b>{unknownParties.length} {type === "OUT" ? "receiver" : "sender"}{unknownParties.length > 1 ? "s aren't" : " isn't"} in your list</b>, so {unknownParties.length > 1 ? "they're" : "it's"} treated as {type === "OUT" ? "a retailer or outside buyer" : "an outside supplier"}. If {unknownParties.length > 1 ? "any is" : "it's"} one of your super stockists or distributors, say which:
          {canManage && unknownParties.slice(0, 8).map(name => <div className="fixrow" key={name}>
            <span className="fixname">{name}</span>
            <label>Same as…<select value={fix[`party:${name}`] || ""} onChange={e => setFix({ ...fix, [`party:${name}`]: e.target.value })}>
              <option value="">choose…</option>{locOptions(false)}</select></label>
            <button disabled={!fix[`party:${name}`]} onClick={() => saveLocationAlias(name, fix[`party:${name}`])}>Save as its other name</button>
            <button className="secondary small" onClick={() => setAdding({ name, kind: "DISTRIBUTOR" })}>Add as new distributor</button>
          </div>)}
          {unknownParties.length > 8 && <small>…and {unknownParties.length - 8} more.</small>}
        </div>}
        {unknownSOs.length > 0 && <div className="fixgroup">
          <b>Sales officers not in your list: {unknownSOs.map(n => `"${n}"`).join(", ")}</b>
          {canManage ? unknownSOs.slice(0, 5).map(name => <div className="fixrow" key={name}>
            <span className="fixname">{name}</span>
            <label>Same SO as…<select value={fix[`so:${name}`] || ""} onChange={e => setFix({ ...fix, [`so:${name}`]: e.target.value })}>
              <option value="">choose…</option>{officers.map(o => <option key={o.id} value={o.id}>{o.name} ({o.code})</option>)}</select></label>
            <button disabled={!fix[`so:${name}`]} onClick={() => saveSOAlias(name, fix[`so:${name}`])}>Save as their other name</button>
            <span className="or">or</span>
            <button className="secondary" onClick={() => addSO(name)}>Add “{name.slice(0, 30)}” as a new SO</button>
          </div>) : <p className="hint">Ask an HO admin to add them on the SO checks page.</p>}
        </div>}
        {adding && <div className="fixgroup">
          <b>New {KIND_LABEL[adding.kind].toLowerCase()}: all fields marked * are required.</b>
          <LocationForm key={`${adding.kind}-${adding.name}`} kind={adding.kind} prefillName={adding.name} locations={locations} onCancel={() => setAdding(null)}
            onSaved={async d => {
              const orig = normName(adding.name);
              const moves = type === "IN" || type === "OUT";
              setRows(rs => rs.map(r => ({ ...r, distributor: normName(r.distributor) === orig ? d.code : r.distributor, retailer: moves && normName(r.retailer) === orig ? d.code : r.retailer })));
              if (normName(holder) === orig) setHolder(d.code);
              setAdding(null); await onListsChanged();
              say("ok", `Added ${d.name} as ${d.code}.`);
            }} />
        </div>}
      </div>}

      {(type === "IN" || type === "OUT") && (nTransfers > 0 || anySenderShort) && <div className="fixbox info">
        <b>{nTransfers} row{nTransfers === 1 ? "" : "s"} move{nTransfers === 1 ? "s" : ""} stock between your own locations.</b>{" "}
        {type === "OUT" ? "Each receiver's stock goes up by the same amount." : "Each sender's stock goes down by the same amount."}
        <label className="inline"><input type="checkbox" checked={!reduceSender} onChange={e => setReduceSender(!e.target.checked)} />
          {" "}Don't reduce the sender's stock; only add it to the receiver</label>
        {anySenderShort && <small>Some senders don't have enough stock in the app. Tick this when their stock isn't in the app yet (for example, before the godown's opening stock is uploaded).</small>}
      </div>}
      {nExcluded > 0 && <p className="hint">{nExcluded} row{nExcluded > 1 ? "s were" : " was"} already recorded from the other side of the transfer, so {nExcluded > 1 ? "they're" : "it's"} skipped. Tick “save anyway” on a row to include it.</p>}
      {newProducts > 0 && <p className="hint">{newProducts} product name{newProducts > 1 ? "s aren't" : " isn't"} in your product list and will be created. If a name is just how this file writes one of your products, pick the product under “Same as”; the app remembers it.</p>}
      <datalist id="products-dl">{products.map(p => <option key={p.id} value={`${p.sku} — ${p.item_name}`} />)}</datalist>
      <div className="tablewrap"><table className="edit"><thead><tr>
        {cols.map(h => <th key={h}>{COL_LABEL[h]}</th>)}
        {type === "COUNT" && <><th>Current</th><th>Change</th></>}
        <th>Same as (your product)</th><th>Check</th><th /></tr></thead>
        <tbody>{rows.map((r, i) => {
          const ck = checked[i];
          if (!ck) return null;
          const diff = r.quantity - ck.cur;
          const plan = aliasPlan[normName(r.item_name)];
          const planned = plan && products.find(p => p.id === plan.productId);
          return <tr key={i} className={ck.excluded ? "skip" : ck.problems.length ? "bad" : ""}>
            {cols.map(k => <td key={k}><input className={k} type={k === "quantity" || k === "unit_price" ? "number" : k === "date" ? "date" : "text"} value={r[k]} onChange={e => updateRow(i, k, e.target.value)} /></td>)}
            {type === "COUNT" && <><td>{fmt(ck.cur)}</td><td className={diff > 0 ? "in" : diff < 0 ? "out" : ""}>{diff > 0 ? "+" : ""}{fmt(diff)}</td></>}
            <td>{ck.p && !plan ? <small>{ck.p.item_name}</small>
              : <input className="match" list="products-dl" placeholder={type === "OUT" || type === "SO" ? "pick your product…" : "new product, or pick…"}
                  defaultValue={planned ? `${planned.sku} — ${planned.item_name}` : ""} onChange={e => matchTo(r.item_name, e.target.value)} />}</td>
            <td className="check">
              {ck.excluded ? <span className="muted">{ck.notes.join("; ")}</span>
                : ck.problems.length ? <><span className="err">{ck.problems.join("; ")}</span>{ck.notes.length > 0 && <small className="muted"> ({ck.notes.join("; ")})</small>}</>
                : <span className="ok">✓ {ck.notes.join("; ") || (plan ? "will remember" : !ck.p && type !== "SO" ? "new product" : "")}</span>}
              {(ck.excluded || r.include) && <label className="inline small"><input type="checkbox" checked={!!r.include} onChange={e => updateRow(i, "include", e.target.checked)} /> save anyway</label>}
            </td>
            <td><button className="del" title="Remove row" aria-label="Remove row" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}>✕</button></td>
          </tr>;
        })}</tbody></table></div>
      {skipped.length > 0 && <div className="skipped">
        <button className="link" onClick={() => setShowSkipped(s => !s)}>{showSkipped ? "▾" : "▸"} Left out ({skipped.length}): totals, group lines, blank quantities</button>
        {showSkipped && <table><tbody>{skipped.map((s, i) => <tr key={i}><td>Line {s.line}</td><td>{s.text}</td><td><small>{s.reason}</small></td>
          <td>{s.row && <button className="secondary small" onClick={() => restore(s)}>Add back</button>}</td></tr>)}</tbody></table>}
      </div>}
      <div className="footer-actions">
        {status && <div className={`status ${status.kind}`}>{status.text}</div>}
        <button onClick={() => post()} disabled={!!busy || !rows.length}>{busy === "Saving…" ? "Saving…" : saveLabel}</button>
      </div>
    </section>}
    {!rows.length && status?.kind === "ok" && <div className="status ok">{status.text}</div>}
  </>;
}
