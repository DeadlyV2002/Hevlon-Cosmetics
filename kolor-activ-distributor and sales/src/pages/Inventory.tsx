import { Select, Combo } from "../components/Select";
import { ask } from "../lib/ask";
import { startTask, TaskHandle } from "../lib/tasks";
import { readPrimary, PrimaryRead } from "../lib/primary";
import { matchHolder, nameScore } from "../lib/dsrLink";
import PrimarySales from "../components/PrimarySales";
import SsTally from "../components/SsTally";
import SetAside from "../components/SetAside";
import ReturnStock from "../components/ReturnStock";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Mode, Row, Field, Table, Layout, Skipped, FIELD_LABELS, emptyRow, today, localDate, isValidDate,
  detectLayout, extractRows, titleText, cellText, formatSignature, normName, headingDate,
} from "../lib/parse";
import { readAnyFile, fileHash, ACCEPT } from "../lib/readers";
import { guessProduct } from "../lib/fuzzy";
import { readSheetInfo, SheetInfo } from "../lib/detect";
import { detectFile, Detection, FileType } from "../lib/detect";
import {
  supabase, Distributor, Product, ProductAlias, StockLine, SalesOfficer, Retailer, Kind, KINDS, KIND_LABEL, KIND_PLURAL,
  matchDistributor, matchProduct, matchSO, fetchAll, fmt, plural, errText, proper } from "../lib/supabase";
import StockDownload from "../components/StockDownload";
import MoveStock from "../components/MoveStock";
import LocationForm from "../components/LocationForm";
import { dmy } from "../lib/dates";

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
  /** Tells the app an upload is running (shown next to the menu item), so leaving the page doesn't hide it. */
  onBusy?: (label: string) => void;
}

/** What to do about each kind of problem in the review table. */
const FIXES: [RegExp, string][] = [
  [/choose whose stock/, 'pick the distributor or super stockist in "Whose stock" at the top, or add it as new in the yellow box.'],
  [/isn't in your list/, 'in the yellow box, say which of your locations it is (saved as its other name) or add it as new.'],
  [/product missing/, "type the product name in the row, or remove the row with ✕."],
  [/valid date/, "type the date in the Date box (day, month, year)."],
  [/negative quantity/, "stock can't be below zero: correct it in the file or type 0."],
  [/quantity must be more than 0/, "type the quantity, or remove the row with ✕."],
  [/SO .* isn't in your SO list/, "in the yellow box, say which SO it is or add them as a new SO."],
  [/SO missing/, "type the SO's name in the SO column."],
  [/distributor missing/, "type the distributor in the Distributor column, or choose one at the top for all rows."],
  [/product not found|never stocked/, 'pick your product under "Same as".'],
  [/who received it|party missing/, 'type who received it in "Sent to".'],
  [/has only .* in the app/, "upload that location's stock first, or tick \"Don't reduce the sender's stock\" below if their stock isn't in the app yet."],
];
const fixFor = (p: string) => FIXES.find(([re]) => re.test(p))?.[1] || "";
/** A likely location name from a stock file's name: drops "DB", "closing stock", months and dates. */
function nameFromFile(file: string) {
  const words = file.replace(/\.[a-z0-9]+$/i, "").replace(/[_\-.()&]+/g, " ").split(/\s+/).filter(Boolean)
    .filter(w => !/^(db|ss|closing|stocks?|stoks?|stoke|statement|format|report|month|of|and|the|\d+|jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)$/i.test(w));
  return proper(words.join(" "));
}

export default function Inventory({ locations, products, aliases, stock, officers, retailers, canManage, onPosted, onListsChanged, notify, onBusy }: Props) {
  const [type, setType] = useState<FileType>("COUNT");
  const [detection, setDetection] = useState<Detection | null>(null);
  const productOptions = useMemo(() => products.map(p => ({ value: `${p.sku} — ${p.item_name}` })), [products]);
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
  /** A sheet of company billing to super stockists, shown in its own preview. */
  const [primary, setPrimary] = useState<{ read: PrimaryRead; name: string; file: File } | null>(null);
  /** Files put aside to deal with later, so one stuck distributor doesn't hold up the rest. */
  const [aside, setAside] = useState<{ file: File; reason: string }[]>([]);
  const current = useRef<File | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(false), [manual, setManual] = useState(false);
  /** A name for a stock sheet that doesn't name its distributor, from the file name ("DB DITYA COSMETCS JADIA 08-2026" → "Ditya Cosmetcs Jadia"). */
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState<{ name: string; kind: Kind } | null>(null);
  /** Details printed above a closing stock table: DB name, town, SO/ASE, HQ, month, stock date. */
  const [sheetInfo, setSheetInfo] = useState<SheetInfo | null>(null);
  const [pieces, setPieces] = useState(false);
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
    const si = readSheetInfo(g, l.headerRow);
    setSheetInfo(si.name || si.town || si.person || si.hq ? si : null);
    // Quantities in pieces when the quantity heading says so; the choice can be changed before saving.
    setPieces(l.labels.some((lab, i) => l.mapping[i] === "quantity" && /\b(pcs|pieces|piece|nos)\b/.test(lab)) || /\b(in pcs|in pieces|pcs wise)\b/i.test(heading));
    let h = holder, so = soDefault, d = date;
    if (det) { h = det.holder; so = det.so; d = headingDate(`${heading} ${f?.name || ""}`) || today(); }
    setHolder(h); setSoDefault(so); setDate(d);
    if (f) setFile({ ...f, heading });
    else setFile(x => (x ? { ...x, heading } : x));
    setLayout(l); setSavedFormat(saved); setAliasPlan({}); setReduceSender(true); setAdding(null);
    return { l, res: extract(t, sh, l, tp, h, d, so) };
  }

  async function onFile(f: File, notBilling = false) {
    current.current = f; setOnlyProblems(false); setNewName(nameFromFile(f.name));
    setBusy(`Reading ${f.name}…`); setStatus(null);
    try {
      const [t, hash] = await Promise.all([readAnyFile(f, setBusy), fileHash(f)]);
      if (!t.sheets.length) throw new Error("The file is empty.");
      // Company billing to super stockists (SS name, invoice and an item per column) has its own reader.
      const pr = readPrimary(t.sheets, f.name);
      // A sheet with an item per column is billing; one line per item only when most parties are super stockists (not a distributor's own sales register).
      const supersList = locations.filter(l => l.kind === "SUPER_STOCKIST");
      const billing = pr && pr.invoices.length > 0 && (pr.wide ? pr.items.length >= 3 : pr.invoices.filter(i => matchDistributor(i.ss, supersList)).length >= pr.invoices.length / 2);
      if (pr && billing && !notBilling) {
        clearAll(); setPrimary({ read: pr, name: f.name, file: f });
        say("info", `${f.name}: ${plural(pr.invoices.length, "invoice")} of company billing to ${new Set(pr.invoices.map(i => i.ss)).size} super stockists. Check the matches, then save.`);
        return;
      }
      setBusy(`Finding the product table and whose stock ${f.name} is…`); await new Promise(r => setTimeout(r, 0));
      const g = t.sheets[0].grid, l0 = detectLayout(g, "COUNT");
      const det = detectFile(g, l0, titleText(g, l0), f.name, locations, officers);
      // A "DB name" line above the table says whose stock it is; it wins over names found elsewhere in the heading (such as the SO's).
      const info = readSheetInfo(g, l0.headerRow);
      if (info.name && det.type !== "SO") {
        const byInfo = await matchHolder(info.name, info.town, locations);
        const guessed = locations.find(l => l.code === det.holder);
        if (byInfo) { det.holder = byInfo.code; det.reasons = [...det.reasons.filter(r => !/appears in the heading/.test(r)), `the sheet names ${info.name}${info.town ? ` of ${info.town}` : ""}, which is ${byInfo.name}${byInfo.territory ? ` (${byInfo.territory})` : ""}`]; }
        else if (guessed && nameScore(info.name, guessed) < 0.8) { det.holder = ""; det.reasons = [...det.reasons.filter(r => !/appears in the heading/.test(r)), `the sheet names "${info.name}"${info.town ? ` of ${info.town}` : ""}, which isn't in your list yet: choose it or add it below`]; }
      }
      setDetection(det); setType(det.type); setTable(t); setSheet(0);
      setBusy("Reading the rows and matching products and rates…"); await new Promise(r => setTimeout(r, 0));
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
  /** Files chosen together wait here and open one after another. */
  const [queue, setQueue] = useState<File[]>([]);
  /** Which file of the batch is open (for the progress bar), and Save All mode. */
  const [fileNo, setFileNo] = useState(0), [fileTotal, setFileTotal] = useState(0);
  const [auto, setAuto] = useState(false), [autoLog, setAutoLog] = useState<{ file: string; ok: boolean; text: string }[]>([]);
  function nextFile() { if (!queue.length) return; const [f, ...rest] = queue; setQueue(rest); setFileNo(n => n + 1); onFile(f); }
  /** Keeps the open file for later and moves on to the next one in the queue. */
  function setAsideNow(reason: string) {
    const f = current.current;
    if (f) setAside(a => [...a.filter(x => x.file !== f), { file: f, reason }]);
    clearAll(); setPrimary(null);
    if (queue.length) setTimeout(nextFile, 200); else if (auto) { setAuto(false); setFileTotal(0); }
  }
  function openAside(f: File) { setAside(a => a.filter(x => x.file !== f)); onFile(f); }
  function startFiles(list: File[]) { const [f, ...rest] = list; if (!f) return; setQueue(rest); setFileNo(1); setFileTotal(list.length); setAutoLog([]); setAuto(false); onFile(f); }
  // DSR products not yet in the product list (so stock files can match the DSR names and rates).
  const [dsrMissing, setDsrMissing] = useState(0);
  useEffect(() => {
    if (!supabase) return;
    supabase.from("dsr_products").select("name").then(({ data }) => {
      const have = new Set(products.flatMap(p => [normName(p.item_name), normName(p.sku)]));
      setDsrMissing(((data || []) as { name: string }[]).filter(d => !have.has(normName(d.name))).length);
    });
  }, [products]);
  async function addDsrProducts() {
    if (!supabase) return;
    setBusy("dsr");
    const { data, error } = await supabase.rpc("products_from_dsr");
    setBusy("");
    if (error) return say("err", `Couldn't add the DSR products: ${errText(error)}`);
    say("ok", `Added ${plural((data as { added: number }).added, "product")} from the DSR price list. Rows now match by name and rate.`);
    guessed.current = "";
    await onListsChanged();
  }
  function clearAll() { setManual(false); setSheetInfo(null); setTable(null); setLayout(null); setRows([]); setSkipped([]); setFile(null); setDetection(null); setAliasPlan({}); setStatus(null); setAdding(null); setExisting([]); }

  /** "This name in the file = that existing product": applied to every row with the same name and remembered on save. */
  const guessed = useRef("");
  useEffect(() => {
    const key = `${file?.hash || ""}|${rows.length}`;
    if (!rows.length || guessed.current === key) return;
    guessed.current = key;
    const plan: Record<string, { productId: string; name: string }> = {}, sku = new Map<string, string>();
    for (const r of rows) {
      const k = normName(r.item_name);
      if (!k || plan[k] || aliasPlan[k] || matchProduct(r.sku, r.item_name, products, aliases)) continue;
      const g = guessProduct(r.item_name, r.unit_price, products);
      if (g) { plan[k] = { productId: g.id, name: r.item_name }; sku.set(k, g.sku); }
    }
    if (!sku.size) return;
    setAliasPlan(a => ({ ...a, ...plan }));
    setRows(rs => rs.map(r => (sku.has(normName(r.item_name)) ? { ...r, sku: sku.get(normName(r.item_name))! } : r)));
  }, [rows, file?.hash]);

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
      // The file's rate against the product's SS rate (both per dozen when they come from the DSR price list).
      const ss = Number(p?.ss_rate) || 0;
      if (p && ss && r.unit_price > 0 && Math.abs(r.unit_price - ss) > Math.max(0.5, ss * 0.005)) notes.push(`rate ₹${r.unit_price} here, SS rate ₹${ss}`);
      if (type === "COUNT") {
        if (!holderLoc) problems.push("choose whose stock this is (above)");
        if (r.quantity < 0) problems.push("negative quantity");
        const cur = holderLoc && p ? stockMap.get(`${holderLoc.id}|${p.id}`) ?? 0 : 0;
        // Blank or zero in a closing statement: only matters if the app thinks they hold some.
        if (r.quantity === 0 && cur === 0) { excluded = true; notes.push(p ? "none in stock" : "none in stock, not in product list"); }
        return { p, h: holderLoc, cur, problems, notes, excluded, senderShort };
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
          notes.push(`already recorded on ${dmy(existing[i].transaction_date)}${existing[i].reference ? ` (${existing[i].reference})` : ""}`);
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

  // Every problem, grouped, with the rows it's on and what to do about it.
  const problemGroups = useMemo(() => {
    const m = new Map<string, { text: string; fix: string; rows: number[] }>();
    checked.forEach((c, i) => { if (!c || c.excluded) return; c.problems.forEach(p => {
      const key = p.replace(/"[^"]*"/g, '"…"').replace(/[\d,.]+/g, "N");
      const e = m.get(key) || { text: p, fix: fixFor(p), rows: [] };
      e.rows.push(i + 1); m.set(key, e);
    }); });
    return [...m.values()].sort((a, b) => b.rows.length - a.rows.length);
  }, [checked]);
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

  async function post(allowDuplicate = false, quiet = false): Promise<void> {
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
    if (!allowDuplicate && !quiet && !await ask(`${what}${newProducts ? `\n\n${plural(newProducts, "new product")} will be created.` : ""}${nExcluded ? (type === "COUNT" ? `\n\n${plural(nExcluded, "product")} with none in stock ${nExcluded === 1 ? "is" : "are"} left as ${nExcluded === 1 ? "it is" : "they are"}.` : `\n\n${plural(nExcluded, "row")} already recorded will be skipped.`) : ""}`)) return;
    setBusy("Saving…"); setStatus({ kind: "info", text: "Saving…" });
    // Stock is kept in dozens (rates are per dozen): a file in pieces is divided by 12.
    const clean = send.map(({ include: _, ...r }) => ({ ...r, quantity: pieces ? Math.round((r.quantity / 12) * 1000) / 1000 : r.quantity, distributor: r.distributor.trim(), sku: r.sku.trim(), item_name: r.item_name.trim(), retailer: r.retailer.trim(), so: r.so.trim() }));
    const common = { p_source_file: file?.name ?? "manual entry", p_file_hash: file?.hash ?? null, p_allow_duplicate: allowDuplicate || type === "COUNT" };
    const { data, error } = type === "COUNT"
      ? await supabase.rpc("post_stock_count", { p_distributor: holderLoc!.code, p_rows: clean, p_date: date, ...common })
      : type === "SO"
        ? await supabase.rpc("post_so_report", { p_rows: clean, ...common })
        : await supabase.rpc("post_movements", { p_type: type, p_rows: clean, p_holder: holderLoc?.code ?? null, p_reduce_sender: reduceSender, ...common });
    setBusy("");
    if (error) {
      if (error.message.startsWith("DUPLICATE_FILE")) {
        if (quiet) { logAuto(false, "already saved before; skipped so it isn't counted twice"); clearAll(); if (queue.length) setTimeout(nextFile, 200); else setAuto(false); return; }
        if (await ask(`${error.message.replace("DUPLICATE_FILE: ", "")}.\n\nSaving it again will count it twice. Save anyway?`)) return post(true);
        return say("err", "Not saved: this file was already posted.");
      }
      if (quiet) { logAuto(false, `set aside: ${error.message}`); setAsideNow(`save failed: ${error.message}`); return; }
      return say("err", `Save failed: ${error.message}`);
    }
    // Learn from this upload: the column layout and any product matches.
    if (layout && table && layout.headerRow >= 0)
      await supabase.from("import_formats").upsert({ signature: `${mode}:${formatSignature(layout)}`, mapping: layout.mapping, labels: layout.labels, updated_at: new Date().toISOString() });
    for (const a of Object.values(aliasPlan)) await supabase.from("product_aliases").insert({ product_id: a.productId, alias: a.name });

    const skippedNote = nExcluded && type !== "COUNT" ? ` ${plural(nExcluded, "row")} already recorded ${nExcluded === 1 ? "was" : "were"} skipped.` : "";
    const msg = type === "COUNT" ? `Stock count saved for ${holderLoc?.name}: ${data.increased} products up, ${data.decreased} down, ${data.unchanged} unchanged. Undo is on the History page.`
      : type === "SO" ? `Saved ${plural(data.posted_rows, "SO report line")}. The SO checks page compares them with distributor stock.`
      : `Saved ${plural(data.posted_rows, "row")}${data.transfers ? `, including ${plural(data.transfers, "transfer")}` : ""}.${skippedNote} Undo is on the History page.`;
    if (type === "COUNT" && holderLoc && !holderLoc.so_id && sheetInfo?.person) {
      const so = matchSO(sheetInfo.person, officers);
      if (so) await supabase.from("distributors").update({ so_id: so.id }).eq("id", holderLoc.id);
    }
    if (auto) logAuto(true, msg);
    clearAll(); say("ok", queue.length ? `${msg} Opening the next file…` : msg);
    if (queue.length) { setBusy("Opening the next file…"); setTimeout(nextFile, 300); }
    else if (auto) { setAuto(false); setFileTotal(0); }
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
  const posting = useRef(false);
  /** The type, whose-stock and date settings only show once there's a file or rows to work on. */
  const working = manual || !!file || rows.length > 0;
  useEffect(() => { onBusy?.(busy || auto ? (fileTotal > 1 ? `${Math.min(fileNo, fileTotal)}/${fileTotal}` : "…") : ""); }, [busy, auto, fileNo, fileTotal]);
  // Save All shows in the progress panel too, so it can be followed from any page.
  const autoTask = useRef<TaskHandle | null>(null);
  useEffect(() => {
    if (auto && !autoTask.current) autoTask.current = startTask("Saving all stock files", fileTotal);
    if (!auto && autoTask.current) {
      const ok = autoLog.filter(x => x.ok).length, bad = autoLog.filter(x => !x.ok).length;
      const note = `${plural(ok, "file")} saved${bad ? `, ${plural(bad, "file")} need a look on the Inventory page` : ""}.`;
      if (bad) autoTask.current.fail(note); else autoTask.current.ok(note);
      autoTask.current = null;
    }
  }, [auto]);
  useEffect(() => { autoTask.current?.step(autoLog.length, fileTotal, autoLog.length ? `Last: ${autoLog[autoLog.length - 1].file}` : undefined); }, [autoLog.length, fileTotal]);
  function logAuto(ok: boolean, text: string) { setAutoLog(l => [...l, { file: file?.name || "file", ok, text }]); }
  useEffect(() => {
    if (!auto || busy || !file || !rows.length) return;
    if (blocker) {
      // One file that needs a look doesn't hold up the others: it's set aside and the queue carries on.
      logAuto(false, `set aside: ${blocker}`);
      setAsideNow(blocker);
      return;
    }
    // Wait for the rows to settle (products matched by similar name update them), then save once.
    const t = window.setTimeout(() => { if (!posting.current) { posting.current = true; post(false, true).finally(() => { posting.current = false; }); } }, 600);
    return () => window.clearTimeout(t);
  }, [auto, busy, file?.hash, rows, blocker]);
  const saveLabel = type === "COUNT" ? "Save stock count" : type === "SO" ? "Save SO report" : `Save stock ${type === "IN" ? "received" : "sent out"}`;
  const info = TYPES.find(t => t.id === type)!;
  const locOptions = (skipGodowns: boolean) => KINDS.filter(k => !(skipGodowns && k === "GODOWN")).map(k => <optgroup key={k} label={KIND_PLURAL[k]}>
    {locations.filter(d => d.kind === k).map(d => <option key={d.id} value={d.code}>{d.name} ({d.code})</option>)}</optgroup>);
  const showFixes = rows.length > 0 && (unknownLocs.length > 0 || unknownSOs.length > 0 || unknownParties.length > 0 || (type === "COUNT" && !holderLoc));

  return <>
    <StockDownload locations={locations} products={products} stock={stock} notify={notify}>

    {primary && <PrimarySales read={primary.read} fileName={primary.name} locations={locations} products={products} aliases={aliases} canManage={canManage} notify={notify}
      onDone={async ok => { setPrimary(null); if (ok) await onPosted(); if (queue.length) nextFile(); }}
      onReadNormally={() => { const f = primary.file; setPrimary(null); onFile(f, true); }} />}
    <section className="card upload">
      <div className="rowhead"><div><h2>Upload Stock Files</h2><p>Closing stock, stock received or sent, SO daily sheets, or company billing to super stockists. Choose several at once: the app works out what each file is and whose stock it is, and you check before saving.</p></div></div>
      {(busy || auto) && <div className="progress" role="status" aria-live="polite">
        <div className="lbl"><span>{busy || (auto ? "Checking the next file…" : "")}</span>{fileTotal > 1 && <span>File {Math.min(fileNo, fileTotal)} of {fileTotal}{auto ? " · saving all" : ""}</span>}</div>
        <div className="track"><div className={`fill${fileTotal > 1 ? "" : " indet"}`} style={{ width: `${fileTotal > 1 ? Math.round(((fileNo - (busy === "Saving…" ? 0.5 : 1)) / fileTotal) * 100) : 35}%` }} /></div>
        {auto && <button className="link" onClick={() => setAuto(false)}>Stop After This File</button>}
      </div>}
      {autoLog.length > 0 && <details className="rsec"><summary>Save All: {autoLog.filter(x => x.ok).length} saved{autoLog.some(x => !x.ok) ? `, ${autoLog.filter(x => !x.ok).length} need a look` : ""}</summary>
        <div className="rsecbody tablewrap"><table className="nice"><tbody>{autoLog.map((x, i) => <tr key={i}><td>{x.file}</td><td className={`wrap ${x.ok ? "ok" : "err"}`}>{x.text}</td></tr>)}</tbody></table></div></details>}
      <label className="drop">
        <input type="file" multiple accept={ACCEPT} disabled={!!busy || auto || !locations.length} onChange={e => { startFiles([...(e.target.files || [])]); e.target.value = ""; }} />
        <b>{busy || (!locations.length ? "Loading your lists…" : "Choose files")}</b>
        <small>Excel, CSV, Tally exports, PDFs or photos</small>
      </label>
      {!working && <button className="link" onClick={() => setManual(true)}>Enter Stock By Hand</button>}
      {queue.length > 0 && <p className="hint">{queue.length} more {queue.length === 1 ? "file is" : "files are"} waiting: {queue.map(f => f.name).join(", ")}. Each opens after this one is saved. <button className="link" onClick={() => setAsideNow(blocker || "set aside by you")}>Set This One Aside And Open The Next</button></p>}
      {working && <>
      <div className="tabs types">{TYPES.map(t => <button key={t.id} className={type === t.id ? "active" : ""} onClick={() => changeType(t.id)}>{t.label}</button>)}</div>
      {file && rows.length > 0 && type !== "SO" && <div className="unitpick"><b>Quantities in this file are in</b>
        <div className="seg" role="group" aria-label="Quantity unit"><button className={pieces ? "" : "on"} onClick={() => setPieces(false)}>Dozens</button><button className={pieces ? "on" : ""} onClick={() => setPieces(true)}>Pieces</button></div>
        <small>{pieces ? "They are divided by 12 when saved, because stock and rates are kept per dozen." : "Rates are per dozen, so dozens is usual. Choose Pieces if the distributor counted pieces."}</small></div>}
      {sheetInfo && file && <div className="sheetinfo"><b>From the sheet:</b>
        {sheetInfo.name && <span><small>SS / DB</small>{sheetInfo.name}</span>}{sheetInfo.town && <span><small>Town</small>{sheetInfo.town}</span>}
        {sheetInfo.person && <span><small>{sheetInfo.post || "SO"}</small>{sheetInfo.person}</span>}{sheetInfo.hq && <span><small>HQ</small>{sheetInfo.hq}</span>}
        {sheetInfo.month && <span><small>Month</small>{sheetInfo.month}</span>}{sheetInfo.date && <span><small>Stock date</small>{sheetInfo.date}</span>}</div>}
      {detection && file ? <div className={`detect${detection.sure ? "" : " unsure"}`}>
        <b>{detection.sure ? "Read as" : "Best guess"}: {TYPES.find(t => t.id === detection.type)!.label.toLowerCase()}{type !== detection.type ? ` (you changed it to ${info.label.toLowerCase()})` : ""}</b>
        <small>Because {detection.reasons.join("; ")}.{!detection.sure && " If that's wrong, pick the right type above."}</small>
      </div> : null}
      <p className="hint">{info.help}</p>
      {type === "COUNT" && !file && <p className="hint">From Tally: <b>Stock Summary</b> → <b>Alt+F5</b> (Detailed) → <b>Alt+E</b> Export → Excel or XML.</p>}
      <div className="bulk">
        <label>{type === "SO" ? "Distributor for all rows" : "Whose stock"}
          <Select value={holderLoc?.code || ""} onChange={e => (e.target.value ? setAll("distributor", e.target.value) : setHolder(""))}>
            <option value="">{holder && !holderLoc ? `"${holder}" — not in your list` : type === "SO" || showLocCol ? "As in each row" : "Choose…"}</option>
            {locOptions(type === "SO")}
          </Select></label>
        {type === "SO" && <label>SO for all rows<Select value={matchSO(soDefault, officers)?.code || ""} onChange={e => (e.target.value ? setAll("so", e.target.value) : setSoDefault(""))}>
          <option value="">{soDefault && !matchSO(soDefault, officers) ? `"${soDefault}" — not in your list` : "As in each row"}</option>
          {officers.map(o => <option key={o.id} value={o.code}>{o.name} ({o.code})</option>)}</Select></label>}
        <label>{type === "COUNT" ? "Stock count date" : "Date for rows with no date in the file"}<input type="date" value={date} onChange={e => setAll("date", e.target.value)} /></label>
      </div>
      {!locations.length && <p className="warn">No locations yet. Add your godown, super stockists and distributors on the Distributors page first.</p>}
      <button className="secondary" onClick={() => setRows(rs => [...rs, { ...emptyRow(), distributor: holder, date, so: soDefault }])}>+ Add Row By Hand</button>
      </>}
    </section>

    {table && layout && <section className="card">
      <div className="rowhead"><h2>Columns in {file?.name}</h2>
        {table.sheets.length > 1 && <label className="inline">Sheet <Select value={sheet} onChange={e => changeSheet(Number(e.target.value))}>{table.sheets.map((s, i) => <option key={i} value={i}>{s.name}</option>)}</Select></label>}
      </div>
      <p className="hint">{savedFormat
        ? <><span className="tag">saved format</span> Columns set the same way as the last file with these headings.</>
        : <>Check what each column is and correct any that are wrong. When you save, the app remembers this setup for every future file with the same headings.</>}</p>
      {file?.heading && <p className="hint">File heading: <b>{file.heading.slice(0, 160)}</b></p>}
      <div className="tablewrap"><table className="map"><tbody>
        <tr>{layout.labels.map((l, i) => <td key={i}><small>{l || `column ${i + 1}`}</small>
          <Select value={layout.mapping[i] || "ignore"} onChange={e => changeColumn(i, e.target.value as Field)}>
            {(Object.keys(FIELD_LABELS) as Field[]).map(f => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}
          </Select>
          <small className="sample">{cellText(grid[layout.headerRow + Math.max(layout.headerRows, 1)]?.[i]).slice(0, 24)}</small></td>)}</tr>
      </tbody></table></div>
    </section>}

    {(rows.length > 0 || skipped.length > 0) && <section className="card" ref={reviewRef}>
      <div className="rowhead"><h2>Review ({plural(rows.length, "row")}{problemRows.length ? `, ${problemRows.length} need fixing` : ""}{nExcluded ? (type === "COUNT" ? `, ${nExcluded} with none in stock` : `, ${nExcluded} already recorded`) : ""})</h2>
        <div className="actions"><button className="secondary" onClick={clearAll}>Clear</button>
          <button className="secondary" title="Keep this file for later and carry on with the rest" onClick={() => setAsideNow(blocker || "set aside by you")}>Set Aside For Later</button>
          <button onClick={() => post()} disabled={!!busy || !rows.length}>{busy === "Saving…" ? "Saving…" : saveLabel}</button>
        {queue.length > 0 && <button className="secondary" disabled={!!busy || auto} onClick={() => setAuto(true)}>Save All {queue.length + 1} Files</button>}</div></div>
      {status && <div className={`status ${status.kind}`}>{status.text}</div>}
      {!status && blocker && rows.length > 0 && <div className="status err">{blocker}</div>}
      {canManage && newProducts > 0 && dsrMissing > 0 && (type === "COUNT" || type === "IN") && <div className="warn">{plural(newProducts, "product name")} in this file {newProducts === 1 ? "isn't" : "aren't"} in your product list, and {plural(dsrMissing, "DSR product")} {dsrMissing === 1 ? "hasn't" : "haven't"} been added yet. Add the DSR products first so the names match instead of creating new ones.
        <button className="secondary small" disabled={busy === "dsr"} onClick={addDsrProducts}>{busy === "dsr" ? "Adding…" : "Add DSR Products"}</button></div>}

      {showFixes && <div className="fixbox">
        {(unknownLocs.length > 0 || (type === "COUNT" && !holderLoc)) && <div className="fixgroup">
          <b>{unknownLocs.length ? `Not in your list: ${unknownLocs.map(n => `"${n}"`).join(", ")}` : sheetInfo?.name ? `"${sheetInfo.name}"${sheetInfo.town ? ` in ${sheetInfo.town}` : ""} isn't in your list. Choose it above if it's listed under another name, or add it.` : "Whose stock is this file? Choose above."}</b>
          {canManage && !unknownLocs.length && type === "COUNT" && !sheetInfo?.name && <div className="fixrow">
            <span className="fixname">This sheet doesn't say whose stock it is. From the file name it looks like</span>
            <input className="newname" value={newName} onChange={e => setNewName(e.target.value)} aria-label="Name for the new location" />
            <span className="or">add it as a new</span>
            {(["DISTRIBUTOR", "SUPER_STOCKIST"] as Kind[]).map(k => <button key={k} className="secondary small" disabled={!newName.trim()} onClick={() => setAdding({ name: newName.trim(), kind: k })}>{KIND_LABEL[k]}</button>)}
            <span className="or">or pick it in "Whose stock" above, or</span><button className="secondary small" onClick={() => setAsideNow("whose stock isn't known")}>Set Aside</button></div>}
          {canManage && !unknownLocs.length && type === "COUNT" && sheetInfo?.name && <div className="fixrow"><span className="fixname">{sheetInfo.name}</span>
            <label>It is the same as…<Select value={fix[`loc:${sheetInfo.name}`] || ""} onChange={e => setFix({ ...fix, [`loc:${sheetInfo.name}`]: e.target.value })}>
              <option value="">choose…</option>{locOptions(false)}</Select></label>
            <button disabled={!fix[`loc:${sheetInfo.name}`]} onClick={() => { saveLocationAlias(sheetInfo.name, fix[`loc:${sheetInfo.name}`]); setAll("distributor", fix[`loc:${sheetInfo.name}`]); }}>Save As Its Other Name</button>
            <span className="or">or add as new</span>
            {(["DISTRIBUTOR", "SUPER_STOCKIST"] as Kind[]).map(k => <button key={k} className="secondary small" onClick={() => setAdding({ name: sheetInfo.name, kind: k })}>{KIND_LABEL[k]}</button>)}</div>}
          {canManage && unknownLocs.slice(0, 5).map(name => <div className="fixrow" key={name}>
            <span className="fixname">{name}</span>
            <label>It is the same as…<Select value={fix[`loc:${name}`] || ""} onChange={e => setFix({ ...fix, [`loc:${name}`]: e.target.value })}>
              <option value="">choose…</option>{locOptions(type === "SO")}</Select></label>
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
            <label>Same as…<Select value={fix[`party:${name}`] || ""} onChange={e => setFix({ ...fix, [`party:${name}`]: e.target.value })}>
              <option value="">choose…</option>{locOptions(false)}</Select></label>
            <button disabled={!fix[`party:${name}`]} onClick={() => saveLocationAlias(name, fix[`party:${name}`])}>Save as its other name</button>
            <button className="secondary small" onClick={() => setAdding({ name, kind: "DISTRIBUTOR" })}>Add as new distributor</button>
          </div>)}
          {unknownParties.length > 8 && <small>…and {unknownParties.length - 8} more.</small>}
        </div>}
        {unknownSOs.length > 0 && <div className="fixgroup">
          <b>Sales officers not in your list: {unknownSOs.map(n => `"${n}"`).join(", ")}</b>
          {canManage ? unknownSOs.slice(0, 5).map(name => <div className="fixrow" key={name}>
            <span className="fixname">{name}</span>
            <label>Same SO as…<Select value={fix[`so:${name}`] || ""} onChange={e => setFix({ ...fix, [`so:${name}`]: e.target.value })}>
              <option value="">choose…</option>{officers.map(o => <option key={o.id} value={o.id}>{o.name} ({o.code})</option>)}</Select></label>
            <button disabled={!fix[`so:${name}`]} onClick={() => saveSOAlias(name, fix[`so:${name}`])}>Save as their other name</button>
            <span className="or">or</span>
            <button className="secondary" onClick={() => addSO(name)}>Add “{name.slice(0, 30)}” as a new SO</button>
          </div>) : <p className="hint">Ask an HO admin to add them on the SO checks page.</p>}
        </div>}
        {adding && <div className="fixgroup">
          <b>New {KIND_LABEL[adding.kind].toLowerCase()}: all fields marked * are required.</b>
          <LocationForm key={`${adding.kind}-${adding.name}`} kind={adding.kind} prefillName={adding.name} locations={locations} officers={officers} onCancel={() => setAdding(null)}
            prefill={sheetInfo && normName(sheetInfo.name) === normName(adding.name) ? { territory: proper(sheetInfo.town), region: proper(sheetInfo.hq), so_id: matchSO(sheetInfo.person, officers)?.id || "" } : undefined}
            onSaved={async d => {
              const orig = normName(adding.name);
              const moves = type === "IN" || type === "OUT";
              setRows(rs => rs.map(r => ({ ...r, distributor: normName(r.distributor) === orig ? d.code : r.distributor, retailer: moves && normName(r.retailer) === orig ? d.code : r.retailer })));
              if (normName(holder) === orig || (type === "COUNT" && !holderLoc)) setHolder(d.code);
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
      {nExcluded > 0 && <p className="hint">{type === "COUNT" ? <>{plural(nExcluded, "product")} in the sheet {nExcluded > 1 ? "have" : "has"} none in stock and {nExcluded > 1 ? "aren't" : "isn't"} in stock here either, so {nExcluded > 1 ? "they're" : "it's"} left as {nExcluded > 1 ? "they are" : "it is"}. Tick “save anyway” on a row to record a zero.</> : <>{nExcluded} row{nExcluded > 1 ? "s were" : " was"} already recorded from the other side of the transfer, so {nExcluded > 1 ? "they're" : "it's"} skipped. Tick “save anyway” on a row to include it.</>}</p>}
      {newProducts > 0 && <p className="hint">{newProducts} product name{newProducts > 1 ? "s aren't" : " isn't"} in your product list and will be created. If a name is just how this file writes one of your products, pick the product under “Same as”; the app remembers it.</p>}
      {problemGroups.length > 0 && <div className="errsum">
        <div className="rowhead"><b>{plural(problemRows.length, "row")} need fixing before this file can be saved</b>
          <label className="inline"><input type="checkbox" checked={onlyProblems} onChange={e => setOnlyProblems(e.target.checked)} /> Show only rows that need fixing</label></div>
        {problemGroups.map(g => <div key={g.text} className="errgroup"><span className="err">{g.text}</span>
          <small className="muted"> · {g.rows.length === 1 ? "row" : "rows"} {g.rows.slice(0, 15).join(", ")}{g.rows.length > 15 ? ` and ${g.rows.length - 15} more` : ""}</small>
          {g.fix && <div className="fixhint">How to fix: {g.fix}</div>}</div>)}
        <div className="fixhint">Can't fix it now? Press Set Aside For Later: the file waits in the Set Aside list and the rest carry on.</div>
      </div>}
      <div className="tablewrap"><table className="edit"><thead><tr><th>#</th>
        {cols.map(h => <th key={h}>{COL_LABEL[h]}</th>)}
        {type === "COUNT" && <><th>Current</th><th>Change</th></>}
        <th>Same as (your product)</th><th>Check</th><th /></tr></thead>
        <tbody>{rows.map((r, i) => {
          const ck = checked[i];
          if (!ck || (onlyProblems && (ck.excluded || !ck.problems.length))) return null;
          const diff = r.quantity - ck.cur;
          const plan = aliasPlan[normName(r.item_name)];
          const planned = plan && products.find(p => p.id === plan.productId);
          return <tr key={i} className={ck.excluded ? "skip" : ck.problems.length ? "bad" : ""}>
            <td className="rownum">{i + 1}</td>
            {cols.map(k => <td key={k}><input className={k} type={k === "quantity" || k === "unit_price" ? "number" : k === "date" ? "date" : "text"} value={r[k]} onChange={e => updateRow(i, k, e.target.value)} /></td>)}
            {type === "COUNT" && <><td>{fmt(ck.cur)}</td><td className={diff > 0 ? "in" : diff < 0 ? "out" : ""}>{diff > 0 ? "+" : ""}{fmt(diff)}</td></>}
            <td>{ck.p && !plan ? <small>{ck.p.item_name}</small>
              : <Combo className="match" options={productOptions} placeholder={type === "OUT" || type === "SO" ? "pick your product…" : "new product, or pick…"}
                  defaultValue={planned ? `${planned.sku} — ${planned.item_name}` : ""} onChange={e => matchTo(r.item_name, e.target.value)} />}</td>
            <td className="check">
              {ck.excluded ? <span className="muted">{ck.notes.join("; ")}</span>
                : ck.problems.length ? <><span className="err">{ck.problems.join("; ")}</span>{ck.notes.length > 0 && <small className="muted"> ({ck.notes.join("; ")})</small>}
                  {ck.problems.map(p => fixFor(p)).filter(Boolean).slice(0, 1).map(t => <small key={t} className="fixhint">{t}</small>)}</>
                : <span className="ok">{ck.notes.join("; ") || (plan ? "Ready, will remember" : !ck.p && type !== "SO" ? "Ready, new product" : "Ready")}</span>}
              {(ck.excluded || r.include) && <label className="inline small"><input type="checkbox" checked={!!r.include} onChange={e => updateRow(i, "include", e.target.checked)} /> save anyway</label>}
            </td>
            <td><button className="del" title="Remove row" aria-label="Remove row" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}>✕</button></td>
          </tr>;
        })}</tbody></table></div>
      {skipped.length > 0 && <div className="skipped">
        <button className="link" onClick={() => setShowSkipped(s => !s)}>{showSkipped ? "▾" : "▸"} Left out ({skipped.length}): totals, group lines, blank quantities</button>
        {showSkipped && <div className="tablewrap"><table className="skiptable"><tbody>{skipped.map((s, i) => <tr key={i}><td>Line {s.line}</td><td className="wrap">{s.text}</td><td><small>{s.reason}</small></td>
          <td className="act">{s.row && <button className="secondary small" onClick={() => restore(s)}>Add Back</button>}</td></tr>)}</tbody></table></div>}
      </div>}
      <div className="footer-actions">
        {status && <div className={`status ${status.kind}`}>{status.text}</div>}
        <button onClick={() => post()} disabled={!!busy || !rows.length}>{busy === "Saving…" ? "Saving…" : saveLabel}</button>
      </div>
    </section>}
    {!rows.length && status?.kind === "ok" && <div className="status ok">{status.text}</div>}
    {aside.length > 0 && <SetAside files={aside} onOpen={openAside} onRemove={f => setAside(a => a.filter(x => x.file !== f))} />}
    <SsTally locations={locations} products={products} refresh={stock} />
    </StockDownload>
    {canManage && <ReturnStock locations={locations} products={products} stock={stock} onSaved={onPosted} notify={notify} />}
    {canManage && <MoveStock locations={locations} products={products} stock={stock} onMoved={onPosted} notify={notify} />}
  </>;
}
