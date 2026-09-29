import { Select } from "../components/Select";
import { ask } from "../lib/ask";
import { confirmWithPassword } from "../lib/confirm";
import { useDeferredValue, useMemo, useRef, useState } from "react";
import { editDistance } from "../lib/fuzzy";
import { startTask } from "../lib/tasks";
import * as XLSX from "xlsx";
import { supabase, Distributor, Product, Kind, KINDS, KIND_LABEL, KIND_PLURAL, Retailer, SalesOfficer, StockLine, nextCode, missingFields, matchDistributor, matchSO, cleanPhones, proper, fmt, plural, errText } from "../lib/supabase";
import { readAnyFile, ACCEPT } from "../lib/readers";
import { cellText, normName, Grid } from "../lib/parse";
import { findHeader } from "../lib/sheet";
import { normalizeState } from "../lib/india";
import FilterBar, { Scope, emptyScope, applyScope } from "../components/FilterBar";
import LocationForm, { splitAliases } from "../components/LocationForm";
import Comments from "../components/Comments";
import DeleteLocation from "../components/DeleteLocation";
import Modal from "../components/Modal";
import DistributorReport from "../components/DistributorReport";
import Retailers from "./Retailers";
import { useColumnFilters, Col } from "../components/ColumnFilter";

interface Props {
  locations: Distributor[]; stock: StockLine[]; retailers: Retailer[]; officers: SalesOfficer[]; products?: Product[]; commentCounts: Map<string, number>; canManage: boolean; testingMode: boolean; userId: string;
  onChanged: () => Promise<void>; notify: (m: string) => void;
}

type DField = "status" | "code" | "name" | "company_name" | "owner_name" | "super_stockist" | "ss_town" | "so" | "state" | "region" | "territory" | "phone" | "email" | "aliases";
const D_LABELS: Record<DField | "ignore", string> = {
  ignore: "— ignore —", code: "Code", name: "Name", company_name: "Company name", owner_name: "Owner name", super_stockist: "Super stockist",
  state: "State", region: "Region", territory: "City / area", phone: "Phone", aliases: "Other names",
  ss_town: "Super stockist's town", so: "SO / ASE", email: "Email", status: "Active / dormant",
};
// First match wins, so the specific columns come before plain "name".
const D_RULES: [DField, RegExp][] = [
  ["status", /^(status|active|dormant|active dormant|working|state of account)$/],
  // The DB List sheet: S.No, State, SO/ASE Name, HQ, SS Name, SS Town, DB Name, DB Town, Contact.No, Contact Person, Email.
  ["name", /^(db|distributor|dist)( name)?$/],
  ["so", /^(so|ase|tsi|asm|so ase|sales ?officer|salesman)( name)?$/],
  ["ss_town", /^(ss|super stockist) (town|city|place|area|location)$/],
  ["email", /e ?mail|mail id/],
  ["super_stockist", /super|^ss( name| code)?$|parent|works under|^under$/],
  ["owner_name", /owner|proprietor|contact person|person|partner|director|in ?charge/],
  ["company_name", /company|firm legal|legal name|registered name|business name|gst name/],
  ["phone", /phone|mobile|contact( no| number)?$|whatsapp|cell/],
  ["state", /^state( name)?$/],
  ["region", /region|zone|division|^hq$|head ?quarter/],
  ["territory", /territory|area|city|town|location|district|beat|market|address|place/],
  ["aliases", /alias|other name|also|tally name|name in tally|name in file/],
  ["code", /code|^id$|db no|dist no|^no$/],
  ["name", /name|distributor|dealer|firm|party|^db$|stockist|godown|warehouse/],
];
const TEMPLATE_COLUMNS: Record<Kind, string[]> = {
  DISTRIBUTOR: ["S.No", "State", "SO/ASE Name", "HQ", "SS Name", "SS Town", "DB Name", "DB Town", "Contact.No", "Contact Person", "Email"],
  SUPER_STOCKIST: ["Code", "Super Stockist Name", "Company Name", "Owner Name", "State", "Region", "City / Area", "Phone", "Other Names"],
  GODOWN: ["Code", "Godown Name", "Company Name", "State", "City / Area", "Phone", "Other Names"],
};

interface Preview { file: string; grid: Grid; headerRow: number; labels: string[]; mapping: (DField | "ignore")[] }
type Row = Omit<Distributor, "id" | "created_at"> & { id?: string };
interface ImportRow { status: "new" | "update"; missing: string[]; newSS: string; ssTown: string; newSO: string; row: Row }

export default function Distributors({ locations, stock, retailers, officers, products, commentCounts, canManage, testingMode, userId, onChanged, notify }: Props) {
  const [deleting, setDeleting] = useState<Distributor | null>(null);
  const [tab, setTab] = useState<Kind>("DISTRIBUTOR");
  const [editing, setEditing] = useState<Distributor | null>(null);
  const [scope, setScope] = useState<Scope>(emptyScope("DISTRIBUTOR"));
  const [search, setSearch] = useState("");
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);
  const [showStatus, setShowStatus] = useState<"ALL" | "ACTIVE" | "DORMANT">("ALL");
  async function toggleStatus(d: Distributor) {
    if (!supabase) return;
    const next = d.status === "DORMANT" ? "ACTIVE" : "DORMANT";
    if (next === "DORMANT") {
      const r = await confirmWithPassword(`Mark ${d.name} as dormant? Their history stays; they get no stock reminders and can be hidden from lists.`, "Mark Dormant");
      if (r === "cancelled") return;
      if (r === "wrong") return show("err", `${d.name} was not changed: that password isn't right.`);
    } else if (!await ask(`Mark ${d.name} as active again?`, { ok: "Mark Active" })) return;
    const { error } = await supabase.from("distributors").update({ status: next }).eq("id", d.id);
    if (error) return show("err", error.code === "42501" ? "Only HO admins and state managers can change this." : `Not changed: ${error.message}. Run database step 012.`);
    const held = stock.filter(x => x.distributor_id === d.id && Number(x.current_stock) > 0);
    show("ok", `${d.name} is now ${next === "DORMANT" ? "dormant" : "active"}.${next === "DORMANT" && held.length ? ` They still hold ${plural(held.length, "product")} in the app. When it comes back, record it on the Inventory page under Stock Returned To The Godown ("Everything They Hold").` : ""}`); await onChanged();
  }
  const [openComments, setOpenComments] = useState<string | null>(null), [showTree, setShowTree] = useState(false);
  const [report, setReport] = useState<Distributor | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [withIncomplete, setWithIncomplete] = useState(false);
  const [dropMissing, setDropMissing] = useState(false);
  const [queue, setQueue] = useState<File[]>([]);
  function nextImport() { const [f, ...rest] = queue; setQueue(rest); setPreview(null); if (f) readImport(f); }
  const formRef = useRef<HTMLDivElement>(null);
  const toForm = () => setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const show = (kind: "ok" | "err", text: string) => { setMsg({ kind, text }); notify(text); };

  function switchTab(k: Kind) { setTab(k); setScope(emptyScope(k)); setEditing(null); setPreview(null); setOpenComments(null); setMsg(null); setOnlyIncomplete(false); }

  const totals = useMemo(() => {
    const m = new Map<string, { units: number; value: number; last: string }>();
    stock.forEach(s => {
      const t = m.get(s.distributor_id) || { units: 0, value: 0, last: "" };
      t.units += Number(s.current_stock); t.value += Number(s.stock_value);
      if (s.last_movement > t.last) t.last = s.last_movement;
      m.set(s.distributor_id, t);
    });
    return m;
  }, [stock]);
  const rank = useMemo(() => new Map([...totals].map(([k, v]) => [k, v.value])), [totals]);
  const byId = useMemo(() => new Map(locations.map(d => [d.id, d])), [locations]);
  const kids = useMemo(() => {
    const m = new Map<string, number>();
    locations.forEach(d => { if (d.parent_id) m.set(d.parent_id, (m.get(d.parent_id) || 0) + 1); });
    return m;
  }, [locations]);
  const count = (id: string) => counts[id] ?? commentCounts.get(id) ?? 0;
  const incomplete = (d: Distributor) => missingFields(d);

  const ofKind = locations.filter(d => d.kind === tab);
  // Search matches every word typed, in any order, allowing a letter or two off ("balajee" finds Balaji), across names, people, places, phone, SS and SO.
  const words = useMemo(() => { const m = new Map<string, string[]>(); locations.forEach(d => m.set(d.id, normName(`${d.code} ${d.name} ${d.company_name || ""} ${d.owner_name || ""} ${d.state || ""} ${d.region || ""} ${d.territory || ""} ${d.phone || ""} ${d.email || ""} ${(d.aliases || []).join(" ")} ${byId.get(d.parent_id || "")?.name || ""} ${byId.get(d.via_id || "")?.name || ""} ${officers.find(o => o.id === d.so_id)?.name || ""}`).split(" "))); return m; }, [locations, officers, byId]);
  const q = normName(useDeferredValue(search)).split(" ").filter(Boolean);
  // A word of one or two letters must be a whole word ("GA"), longer ones can be part of a word.
  const hit = (d: Distributor) => !q.length || q.every(w => (words.get(d.id) || []).some(x => (w.length <= 2 ? x === w : x.includes(w)) || (w.length >= 5 && x.length >= 4 && editDistance(x.slice(0, w.length + 1), w) <= (w.length >= 8 ? 2 : 1))));
  // Names that start with what was typed come first.
  const rankHit = (d: Distributor) => { const n = normName(d.name), t = q.join(" "); return n === t ? 0 : n.startsWith(t) ? 1 : n.includes(t) ? 2 : 3; };
  const list = applyScope(ofKind, scope).filter(d => (!onlyIncomplete || incomplete(d).length) && (showStatus === "ALL" || (d.status || "ACTIVE") === showStatus) && hit(d))
    .sort((a, b) => (q.length ? rankHit(a) - rankHit(b) : 0));
  const nIncomplete = ofKind.filter(d => incomplete(d).length).length;

  // ---------- Excel import with preview ----------
  async function readImport(f: File) {
    setBusy(true); setMsg(null);
    try {
      const t = await readAnyFile(f);
      const g = t.sheets[0]?.grid || [];
      const h = findHeader(g, D_RULES, "name", "aliases");
      if (!h) throw new Error("Couldn't find a heading row. The sheet needs a Name column and at least one more column such as Company, Owner or Phone.");
      // On the Super stockists and Godowns tabs, "Super Stockist Name" is the record's own name, not its parent.
      if (tab !== "DISTRIBUTOR") h.mapping = h.mapping.map(m => (m !== "super_stockist" ? m : h.mapping.includes("name") ? "ignore" : "name"));
      if (tab !== "DISTRIBUTOR") { const first = h.mapping.indexOf("name"); h.mapping = h.mapping.map((m, i) => (m === "name" && i !== first ? "ignore" : m)); }
      // No plain name column: use the company name.
      if (!h.mapping.includes("name")) { const ci = h.mapping.indexOf("company_name"); if (ci >= 0) h.mapping[ci] = "name"; }
      setPreview({ file: f.name, grid: g, headerRow: h.row, labels: h.labels, mapping: h.mapping });
      setWithIncomplete(false); setDropMissing(false); toForm();
    } catch (e) { show("err", `Import failed: ${errText(e)}`); }
    finally { setBusy(false); }
  }

  const importRows = useMemo<ImportRow[]>(() => {
    if (!preview) return [];
    const col = (f: DField) => preview.mapping.indexOf(f);
    const aliasCols = preview.mapping.map((m, i) => (m === "aliases" ? i : -1)).filter(i => i >= 0);
    const byCode = new Map(locations.map(d => [d.code.toUpperCase(), d]));
    const sameKind = locations.filter(d => d.kind === tab);
    const byNameTown = new Map(sameKind.map(d => [`${normName(d.name)}|${normName(d.territory || "")}`, d]));
    const byName = new Map<string, Distributor[]>(); sameKind.forEach(d => byName.set(normName(d.name), [...(byName.get(normName(d.name)) || []), d]));
    const supers = locations.filter(d => d.kind === "SUPER_STOCKIST");
    const taken: { code: string }[] = [...locations];
    const seen = new Set<string>();
    const out: ImportRow[] = [];
    for (const r of preview.grid.slice(preview.headerRow + 1)) {
      const v = (f: DField) => (col(f) >= 0 ? cellText(r[col(f)]) : "");
      const name = proper(v("name"));
      if (!name || /^(total|grand total)$/i.test(name)) continue;
      let code = v("code").toUpperCase();
      const byC = code ? byCode.get(code) : undefined;
      if (byC && byC.kind !== tab) code = ""; // that code belongs to another type
      const town = proper(v("territory")), named = byName.get(normName(name)) || [];
      const existing = (byC && byC.kind === tab ? byC : undefined) || byNameTown.get(`${normName(name)}|${normName(town)}`)
        || (named.length === 1 && (!town || !named[0].territory || normName(named[0].territory) === normName(town)) ? named[0] : undefined);
      if (!code) code = existing?.code || nextCode(tab, taken);
      if (seen.has(code)) code = nextCode(tab, taken);
      seen.add(code); taken.push({ code });
      const keep = (f: keyof Distributor, val: string) => val || (existing?.[f] as string | null) || null;
      const soName = tab === "DISTRIBUTOR" ? proper(v("so")) : "", so = soName ? matchSO(soName, officers) : undefined;
      let parent_id = existing?.parent_id || null, newSS = "";
      const ssName = tab === "DISTRIBUTOR" ? proper(v("super_stockist")) : "";
      // "Direct", "Company" or "Kolor Activ" in the SS column: the company supplies them itself.
      const isDirect = /^(direct|company|kolor|hevlon|ho|head office|self)/i.test(ssName.trim());
      if (ssName && !isDirect) { const ss = matchDistributor(ssName, supers); if (ss) parent_id = ss.id; else { newSS = ssName; parent_id = null; } }
      if (isDirect) parent_id = null;
      const row: Row = {
        id: existing?.id, code, kind: tab, name,
        // The DB List has no separate company column: the DB name is the company's name.
        company_name: keep("company_name", proper(v("company_name")) || name), owner_name: keep("owner_name", proper(v("owner_name"))),
        state: normalizeState(v("state")) || existing?.state || null, region: keep("region", proper(v("region"))), territory: keep("territory", proper(v("territory"))),
        phone: keep("phone", cleanPhones(col("phone") >= 0 ? r[col("phone")] : "")), email: keep("email", v("email").toLowerCase()), parent_id,
        ...(tab === "DISTRIBUTOR" ? { so_id: so?.id || existing?.so_id || null } : {}),
        super_stockist: tab === "DISTRIBUTOR" ? ssName || existing?.super_stockist || null : null,
        aliases: [...new Set([...(existing?.aliases || []), ...aliasCols.flatMap(i => splitAliases(cellText(r[i])))])],
        ...(tab === "DISTRIBUTOR" ? { direct: isDirect || (!ssName && !!existing?.direct) } : {}),
        status: v("status") ? (/dormant|inactive|closed|drop|left|stop|no/i.test(v("status")) ? "DORMANT" : "ACTIVE") : existing?.status || "ACTIVE",
      };
      out.push({ status: existing ? "update" : "new", missing: missingFields({ ...row, parent_id: parent_id || newSS, direct: !!(row as { direct?: boolean }).direct }), newSS, ssTown: proper(v("ss_town")), newSO: soName && !so ? soName : "", row });
    }
    return out;
  }, [preview, locations, officers, tab]);
  const complete = importRows.filter(x => !x.missing.length);
  const toImport = withIncomplete ? importRows : complete;
  const newSupers = [...new Map(toImport.filter(x => x.newSS).map(x => [normName(x.newSS), x.newSS])).values()];
  const newSOs = [...new Map(toImport.filter(x => x.newSO).map(x => [normName(x.newSO), x.newSO])).values()];
  // The sheet is the master list: records of this type that aren't in it can be removed with the import.
  const inSheet = new Set(importRows.map(x => x.row.id).filter(Boolean));
  const absent = preview ? locations.filter(d => d.kind === tab && !inSheet.has(d.id)) : [];
  const holding = new Set(stock.filter(s => Number(s.current_stock) !== 0).map(s => s.distributor_id));
  const removable = absent.filter(d => !holding.has(d.id) && !locations.some(k => k.parent_id === d.id));

  async function confirmImport() {
    if (!supabase || !toImport.length) return;
    setBusy(true);
    const task = startTask(`Importing ${plural(toImport.length, KIND_LABEL[tab].toLowerCase(), KIND_PLURAL[tab].toLowerCase())}`, 5);
    try {
      let created: Distributor[] = [];
      if (newSupers.length) {
        const taken: { code: string }[] = [...locations];
        const payload = newSupers.map(name => {
          const code = nextCode("SUPER_STOCKIST", taken); taken.push({ code });
          const first = toImport.find(x => normName(x.newSS) === normName(name));
          return { code, name, company_name: name, kind: "SUPER_STOCKIST", state: first?.row.state || null, region: first?.row.region || null, territory: first?.ssTown || null, aliases: [] };
        });
        const { data, error } = await supabase.from("distributors").insert(payload).select();
        if (error) throw error;
        created = data as Distributor[];
      }
      task.step(1, 5, "New super stockists added");
      let createdSOs: SalesOfficer[] = [];
      if (newSOs.length) {
        const taken = officers.map(o => Number(o.code.match(/^SO(\d+)$/i)?.[1] || 0));
        let nextNo = Math.max(0, ...taken);
        const payload = newSOs.map(name => ({ code: `SO${String(++nextNo).padStart(3, "0")}`, name, state: toImport.find(x => normName(x.newSO) === normName(name))?.row.state || null }));
        const { data, error } = await supabase.from("sales_officers").insert(payload).select();
        if (error) throw error;
        createdSOs = data as SalesOfficer[];
      }
      task.step(2, 5, "New SOs added");
      const ssId = (n: string) => created.find(c => normName(c.name) === normName(n))?.id || null;
      const soId = (n: string) => createdSOs.find(c => normName(c.name) === normName(n))?.id || null;
      const rows = toImport.map(x => ({ ...x.row, parent_id: x.newSS ? ssId(x.newSS) : x.row.parent_id, ...(x.newSO ? { so_id: soId(x.newSO) } : {}) }));
      const inserts = rows.filter(r => !r.id).map(({ id: _, ...r }) => r);
      const updates = rows.filter(r => r.id);
      if (inserts.length) { const { error } = await supabase.from("distributors").insert(inserts); if (error) throw error; }
      task.step(3, 5, `${inserts.length} new saved`);
      if (updates.length) { const { error } = await supabase.from("distributors").upsert(updates, { onConflict: "id" }); if (error) throw error; }
      task.step(4, 5, `${updates.length} updated`);
      // Super stockists already in the app pick up their town from the sheet if it was blank.
      for (const [id, town] of new Map(toImport.filter(x => !x.newSS && x.ssTown && x.row.parent_id).map(x => [x.row.parent_id as string, x.ssTown])))
        if (!byId.get(id)?.territory) await supabase.from("distributors").update({ territory: town }).eq("id", id);
      let removed = 0;
      if (dropMissing) for (const d of removable) { const { error } = await supabase.rpc("delete_location", { p_location: d.id }); if (!error) removed++; }
      const skipped = importRows.length - toImport.length;
      show("ok", `Imported ${plural(toImport.length, KIND_LABEL[tab].toLowerCase(), KIND_PLURAL[tab].toLowerCase())} (${inserts.length} new, ${updates.length} updated)${created.length ? `, added ${plural(created.length, "new super stockist")}` : ""}${createdSOs.length ? `, added ${plural(createdSOs.length, "new SO")}` : ""}${removed ? `, removed ${plural(removed, KIND_LABEL[tab].toLowerCase(), KIND_PLURAL[tab].toLowerCase())} not in the sheet` : ""}.${skipped ? ` ${plural(skipped, "row")} with empty fields ${skipped === 1 ? "was" : "were"} skipped.` : ""}`);
      task.ok(`${inserts.length} new, ${updates.length} updated.`);
      setPreview(null); await onChanged(); if (queue.length) nextImport();
    } catch (e: any) {
      task.fail(errText(e));
      show("err", `Import failed: ${e?.code === "42501" ? "only HO admins and state managers can import" : errText(e)}`);
    } finally { setBusy(false); }
  }

  function template() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([TEMPLATE_COLUMNS[tab]]), KIND_PLURAL[tab]);
    XLSX.writeFile(wb, `${KIND_PLURAL[tab].toLowerCase().replace(/ /g, "-")}-import.xlsx`);
  }

  const cols = tab === "GODOWN" ? 13 : tab === "DISTRIBUTOR" ? 16 : 15;
  const dcols: Col<Distributor>[] = [
    { key: "code", label: "Code", value: x => x.code }, { key: "name", label: KIND_LABEL[tab], value: x => x.name },
    { key: "company", label: "Company", value: x => x.company_name },
    ...(tab !== "GODOWN" ? [{ key: "owner", label: "Owner", value: (x: Distributor) => x.owner_name }] : []),
    ...(tab === "DISTRIBUTOR" ? [{ key: "ss", label: "Super Stockist", value: (x: Distributor) => `${x.direct ? "Direct with company" : byId.get(x.parent_id || "")?.name || ""}${x.via_id ? ` (stock via ${byId.get(x.via_id)?.name || "another distributor"})` : ""}` }] : []),
    { key: "state", label: "State", value: x => x.state }, { key: "region", label: "Region", value: x => x.region }, { key: "city", label: "City / Area", value: x => x.territory },
    { key: "phone", label: "Phone", value: x => x.phone }, { key: "email", label: "Email", value: x => x.email },
    ...(tab === "DISTRIBUTOR" ? [{ key: "so", label: "SO", value: (x: Distributor) => officers.find(o => o.id === x.so_id)?.name }] : []),
    { key: "aliases", label: "Other Names", value: x => (x.aliases || []).join(", ") },
    ...(tab === "SUPER_STOCKIST" ? [{ key: "kids", label: "Distributors", value: (x: Distributor) => kids.get(x.id) || 0, num: true }] : []),
    { key: "units", label: "Stock Units", value: x => Math.round(totals.get(x.id)?.units || 0), num: true },
    { key: "value", label: "Value ₹", value: x => Math.round(totals.get(x.id)?.value || 0), num: true },
    { key: "last", label: "Last Movement", value: x => totals.get(x.id)?.last || null },
    { key: "status", label: "Status", value: x => (x.status === "DORMANT" ? "Dormant" : "Active") },
  ];
  const dt = useColumnFilters(list, dcols);
  const commentsFor = openComments ? byId.get(openComments) : undefined;
  const addCard = <div ref={formRef} className="scrollpad">
    {canManage ? <section className="card upload">
      <div className="rowhead"><h2>{editing ? `Edit ${editing.name}` : `Add ${KIND_LABEL[tab].toLowerCase()}`}</h2>
        <div className="actions"><button className="secondary" onClick={template}>{tab === "DISTRIBUTOR" ? "Download DB List template" : "Download blank import sheet"}</button>
          <label className="button secondary">Import from Excel<input hidden type="file" multiple accept={ACCEPT} onChange={e => { const [x, ...rest] = [...(e.target.files || [])]; if (x) { readImport(x); setQueue(rest); } e.target.value = ""; }} /></label></div></div>
      <p className="hint">Fields marked * are required. Other names are optional: add the spellings used on their Tally reports so their files match automatically.</p>
      <LocationForm key={editing?.id || `new-${tab}`} kind={tab} editing={editing} locations={locations} officers={officers}
        onCancel={editing ? () => setEditing(null) : undefined}
        onSaved={async d => { setEditing(null); notify(`Saved ${d.name}.`); await onChanged(); }} />
      {msg && <div className={`status ${msg.kind}`}>{msg.text}</div>}
    </section> : <p className="notice">Only HO admins and state managers can add or edit {KIND_PLURAL[tab].toLowerCase()}.</p>}

    {preview && <section className="card">
      <div className="rowhead"><h2>Import preview — {preview.file}</h2>
        <div className="actions"><button className="secondary" onClick={() => (queue.length ? nextImport() : setPreview(null))}>{queue.length ? `Skip, Next File (${queue.length} Left)` : "Cancel"}</button>
          <button onClick={confirmImport} disabled={busy || !toImport.length}>{busy ? "Importing…" : `Import ${plural(toImport.length, KIND_LABEL[tab].toLowerCase(), KIND_PLURAL[tab].toLowerCase())}`}</button></div></div>
      <p className="hint">Check what each column is. Existing records (same code or name) are updated, and blank cells keep their current values.</p>
      <div className="tablewrap"><table className="map"><tbody><tr>{preview.labels.map((l, i) => <td key={i}><small>{l || `column ${i + 1}`}</small>
        <Select value={preview.mapping[i]} onChange={e => setPreview({ ...preview, mapping: preview.mapping.map((m, j) => (j === i ? e.target.value as DField : e.target.value !== "aliases" && m === e.target.value ? "ignore" : m)) })}>
          {(Object.keys(D_LABELS) as (DField | "ignore")[]).filter(k => tab === "DISTRIBUTOR" || k !== "super_stockist").map(k => <option key={k} value={k}>{D_LABELS[k]}</option>)}</Select></td>)}</tr></tbody></table></div>
      {!preview.mapping.includes("name") && <p className="warn">Pick which column is the name.</p>}
      {importRows.length > complete.length && <div className="fixbox">
        <b>{importRows.length - complete.length} of {plural(importRows.length, "row")} {importRows.length - complete.length === 1 ? "has" : "have"} empty fields</b> (shown in red). They are skipped unless you include them.
        <label className="inline"><input type="checkbox" checked={withIncomplete} onChange={e => setWithIncomplete(e.target.checked)} /> Import them anyway and fill the gaps later (they'll be marked incomplete)</label>
      </div>}
      {newSOs.length > 0 && <p className="hint">{plural(newSOs.length, "SO")} in this sheet will be added to your SO list: {newSOs.slice(0, 8).join(", ")}{newSOs.length > 8 ? "…" : ""}.</p>}
      {absent.length > 0 && <div className="fixbox">
        <b>{plural(absent.length, KIND_LABEL[tab].toLowerCase(), KIND_PLURAL[tab].toLowerCase())} in the app {absent.length === 1 ? "isn't" : "aren't"} in this sheet</b>: {absent.slice(0, 10).map(d => d.name).join(", ")}{absent.length > 10 ? "…" : ""}.
        {removable.length > 0 && <label className="inline"><input type="checkbox" checked={dropMissing} onChange={e => setDropMissing(e.target.checked)} /> Remove {removable.length === absent.length ? "them" : `the ${removable.length} without stock`} with this import</label>}
        {absent.length > removable.length && <p className="hint">{plural(absent.length - removable.length, "of them", "of them")} still {absent.length - removable.length === 1 ? "holds" : "hold"} stock or {absent.length - removable.length === 1 ? "has" : "have"} distributors under {absent.length - removable.length === 1 ? "it" : "them"}; delete {absent.length - removable.length === 1 ? "it" : "them"} from the list below, where you can move the stock first.</p>}
      </div>}
      {newSupers.length > 0 && <p className="hint">{newSupers.length} super stockist{newSupers.length > 1 ? "s" : ""} in this sheet {newSupers.length > 1 ? "aren't" : "isn't"} in your list and will be added: {newSupers.slice(0, 8).join(", ")}{newSupers.length > 8 ? "…" : ""}. Fill in their details on the Super stockists tab afterwards.</p>}
      <div className="tablewrap"><table><thead><tr><th /><th>Code</th><th>Name</th><th>Company</th>{tab !== "GODOWN" && <th>Owner</th>}{tab === "DISTRIBUTOR" && <th>Super stockist</th>}<th>State</th><th>Region</th><th>City / area</th><th>Phone</th><th>Email</th>{tab === "DISTRIBUTOR" && <th>SO</th>}<th>Check</th></tr></thead>
        <tbody>{importRows.slice(0, 500).map((x, i) => <tr key={i} className={x.missing.length ? "bad" : ""}>
          <td><span className={`pill ${x.status === "new" ? "input" : "count"}`}>{x.status}</span></td>
          <td>{x.row.code}</td><td>{x.row.name}</td><td className="wrap">{x.row.company_name}</td>{tab !== "GODOWN" && <td>{x.row.owner_name}</td>}
          {tab === "DISTRIBUTOR" && <td>{x.newSS ? <>{x.newSS} <em className="tag">new</em></> : byId.get(x.row.parent_id || "")?.name}</td>}
          <td>{x.row.state}</td><td>{x.row.region}</td><td>{x.row.territory}</td><td>{x.row.phone}</td><td>{x.row.email}</td>{tab === "DISTRIBUTOR" && <td>{x.newSO ? <>{x.newSO} <em className="tag">new</em></> : officers.find(o => o.id === x.row.so_id)?.name}</td>}
          <td className="check">{x.missing.length ? <span className="err">Needs {x.missing.join(", ")}</span> : <span className="ok">Ready</span>}</td></tr>)}</tbody></table>
        {importRows.length > 500 && <p className="hint">Showing the first 500 of {importRows.length} rows. All of them are imported.</p>}</div>
    </section>}

  </div>;
  const listCard = <>
    <section className="card">
      <div className="rowhead"><h2>{KIND_PLURAL[tab]} ({list.length}{list.length !== ofKind.length ? ` of ${ofKind.length}` : ""})</h2>
        <div className="actions">
          <input className="search" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} />
          <div className="seg" role="group" aria-label="Show">{(["ALL", "ACTIVE", "DORMANT"] as const).map(k => <button key={k} className={showStatus === k ? "on" : ""} onClick={() => setShowStatus(k)}>
            {k === "ALL" ? `All (${ofKind.length})` : k === "ACTIVE" ? `Active (${ofKind.filter(x => x.status !== "DORMANT").length})` : `Dormant (${ofKind.filter(x => x.status === "DORMANT").length})`}</button>)}</div>
          {nIncomplete > 0 && <label className="inline"><input type="checkbox" checked={onlyIncomplete} onChange={e => setOnlyIncomplete(e.target.checked)} /> Only incomplete ({nIncomplete})</label>}
        </div></div>
      <FilterBar locations={locations} value={scope} onChange={setScope} kinds={[tab]} rank={rank} saveKey={`distributors-${tab}`} />
      {tab === "DISTRIBUTOR" && (() => {
        const noSS = ofKind.filter(x => !x.parent_id && !x.direct);
        const away = ofKind.filter(x => { const ss = byId.get(x.parent_id || ""); return ss && ss.state && x.state && normName(ss.state) !== normName(x.state); });
        return (noSS.length > 0 || away.length > 0) && <div className="warn">
          {noSS.length > 0 && <div>{plural(noSS.length, "distributor")} {noSS.length === 1 ? "has" : "have"} no super stockist: {noSS.slice(0, 8).map(x => x.name).join(", ")}{noSS.length > 8 ? "…" : ""}. Edit {noSS.length === 1 ? "it" : "them"} and choose the super stockist, or "Direct with company" if you supply {noSS.length === 1 ? "it" : "them"} yourselves.</div>}
          {away.length > 0 && <div>{plural(away.length, "distributor")} {away.length === 1 ? "is" : "are"} linked to a super stockist in another state, which may be wrong: {away.slice(0, 8).map(x => `${x.name} (${x.state}) → ${byId.get(x.parent_id || "")?.name} (${byId.get(x.parent_id || "")?.state})`).join("; ")}{away.length > 8 ? "…" : ""}.</div>}
        </div>;
      })()}
      {dt.sortBar}
      {dt.active > 0 && <p className="hint">{plural(dt.rows.length, "row")} shown by the column filters. <button className="link" onClick={dt.clear}>Clear Filters</button></p>}
      <div className="tablewrap scrolltable"><table className="nice"><thead><tr>{dcols.map(c => dt.head(c.key))}<th>Comments</th>{canManage && <th />}</tr></thead>
        <tbody>{dt.rows.map(d => {
          const miss = incomplete(d);
          return <tr key={d.id}>{dcols.map(c => <td key={c.key} className={["company", "phone", "aliases"].includes(c.key) ? "wrap" : ""}>
            {c.key === "name" ? <><button className="link strong" onClick={() => setReport(d)}>{d.name}</button>{miss.length > 0 && <small className="missing">missing: {miss.join(", ")}</small>}</>
              : c.key === "status" ? <button role="switch" aria-checked={d.status !== "DORMANT"} className={`switch${d.status === "DORMANT" ? "" : " on"}`} disabled={!canManage} title={canManage ? (d.status === "DORMANT" ? "Dormant: click to make active" : "Active: click to mark dormant (asks for your password)") : undefined} onClick={() => toggleStatus(d)}><i aria-hidden /><span>{d.status === "DORMANT" ? "Dormant" : "Active"}</span></button>
              : c.key === "value" ? fmt(c.value(d)) : c.key === "units" ? fmt(c.value(d)) : c.value(d) ?? ""}</td>)}
            <td><button className="secondary small" onClick={() => setOpenComments(d.id)}>💬 {count(d.id)}</button></td>
            {canManage && <td className="actions"><button className="secondary small" onClick={() => { setEditing(d); setMsg(null); toForm(); }}>Edit</button>
              <button className="del" title="Delete" aria-label={`Delete ${d.name}`} onClick={() => setDeleting(d)}>✕</button></td>}
          </tr>;
        })}</tbody></table>
        {!list.length && <p className="empty">No {KIND_PLURAL[tab].toLowerCase()}{ofKind.length ? " match" : " yet"}.</p>}</div>
    </section>
  </>;
  // Once the list has records it comes first; the add and import form sits below it.
  const listFirst = ofKind.length > 0;
  return <>
    <section className="tabs">
      {KINDS.slice().reverse().map(k => <button key={k} className={tab === k && !showTree ? "active" : ""} onClick={() => { setShowTree(false); switchTab(k); }}>
        {KIND_PLURAL[k]} ({locations.filter(d => d.kind === k).length})</button>)}
      <button className={showTree ? "active" : ""} onClick={() => setShowTree(true)}>Tree View</button>
    </section>

    {showTree ? <Retailers treeOnly retailers={retailers} locations={locations} stock={stock} officers={officers} canManage={canManage} onChanged={onChanged} notify={notify} />
      : listFirst ? <>{listCard}{addCard}</> : <>{addCard}{listCard}</>}
    {commentsFor && <Modal title={`Comments — ${commentsFor.name}`} subtitle={`${commentsFor.code}${commentsFor.territory ? ` · ${commentsFor.territory}` : ""}`} onClose={() => setOpenComments(null)}>
      <Comments location={commentsFor} userId={userId} canManage={canManage} onCount={n => setCounts(c => ({ ...c, [commentsFor.id]: n }))} /></Modal>}
    {report && <DistributorReport location={report} locations={locations} stock={stock} officers={officers} products={products} onClose={() => setReport(null)} />}
    {deleting && <DeleteLocation location={deleting} locations={locations} stock={stock} testingMode={testingMode}
      retailers={retailers.filter(r => r.distributor_id === deleting.id).length} comments={count(deleting.id)}
      onClose={() => setDeleting(null)} onDeleted={async m => { setDeleting(null); if (editing?.id === deleting.id) setEditing(null); show("ok", m); await onChanged(); }} />}
  </>;
}
