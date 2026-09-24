import { Fragment, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { supabase, Distributor, Kind, KINDS, KIND_LABEL, KIND_PLURAL, StockLine, nextCode, missingFields, matchDistributor, fmt, plural, errText } from "../lib/supabase";
import { readAnyFile } from "../lib/readers";
import { cellText, normName, Grid } from "../lib/parse";
import { findHeader } from "../lib/sheet";
import { normalizeState } from "../lib/india";
import FilterBar, { Scope, emptyScope, applyScope } from "../components/FilterBar";
import LocationForm, { splitAliases } from "../components/LocationForm";
import Comments from "../components/Comments";

interface Props {
  locations: Distributor[]; stock: StockLine[]; commentCounts: Map<string, number>; canManage: boolean; userId: string;
  onChanged: () => Promise<void>; notify: (m: string) => void;
}

type DField = "code" | "name" | "company_name" | "owner_name" | "super_stockist" | "state" | "region" | "territory" | "phone" | "aliases";
const D_LABELS: Record<DField | "ignore", string> = {
  ignore: "— ignore —", code: "Code", name: "Name", company_name: "Company name", owner_name: "Owner name", super_stockist: "Super stockist",
  state: "State", region: "Region", territory: "City / area", phone: "Phone", aliases: "Other names",
};
// First match wins, so the specific columns come before plain "name".
const D_RULES: [DField, RegExp][] = [
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
  DISTRIBUTOR: ["Code", "Distributor Name", "Company Name", "Owner Name", "Super Stockist", "State", "Region", "City / Area", "Phone", "Other Names"],
  SUPER_STOCKIST: ["Code", "Super Stockist Name", "Company Name", "Owner Name", "State", "Region", "City / Area", "Phone", "Other Names"],
  GODOWN: ["Code", "Godown Name", "Company Name", "State", "City / Area", "Phone", "Other Names"],
};

interface Preview { file: string; grid: Grid; headerRow: number; labels: string[]; mapping: (DField | "ignore")[] }
type Row = Omit<Distributor, "id" | "created_at"> & { id?: string };
interface ImportRow { status: "new" | "update"; missing: string[]; newSS: string; row: Row }

export default function Distributors({ locations, stock, commentCounts, canManage, userId, onChanged, notify }: Props) {
  const [tab, setTab] = useState<Kind>("DISTRIBUTOR");
  const [editing, setEditing] = useState<Distributor | null>(null);
  const [scope, setScope] = useState<Scope>(emptyScope("DISTRIBUTOR"));
  const [search, setSearch] = useState("");
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);
  const [openComments, setOpenComments] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [withIncomplete, setWithIncomplete] = useState(false);
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
  const list = applyScope(ofKind, scope).filter(d => (!onlyIncomplete || incomplete(d).length)
    && `${d.code} ${d.name} ${d.company_name || ""} ${d.owner_name || ""} ${d.state || ""} ${d.region || ""} ${d.territory || ""} ${d.phone || ""} ${(d.aliases || []).join(" ")}`.toLowerCase().includes(search.toLowerCase()));
  const nIncomplete = ofKind.filter(d => incomplete(d).length).length;

  async function remove(d: Distributor) {
    if (!supabase) return;
    const n = kids.get(d.id) || 0;
    if (!confirm(`Delete ${d.name} (${d.code})?${n ? `\n\n${n} distributors work under this super stockist; they'll be left without one.` : ""}\n\nIts retailers and comments are deleted with it.`)) return;
    const { error } = await supabase.from("distributors").delete().eq("id", d.id);
    if (error) return show("err", error.code === "23503" ? `${d.name} has stock postings or SO reports, so it can't be deleted. Undo those in History / SO checks first.` : `Delete failed: ${error.message}`);
    show("ok", `Deleted ${d.name}.`); await onChanged();
  }

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
      setWithIncomplete(false);
    } catch (e) { show("err", `Import failed: ${errText(e)}`); }
    finally { setBusy(false); }
  }

  const importRows = useMemo<ImportRow[]>(() => {
    if (!preview) return [];
    const col = (f: DField) => preview.mapping.indexOf(f);
    const aliasCols = preview.mapping.map((m, i) => (m === "aliases" ? i : -1)).filter(i => i >= 0);
    const byCode = new Map(locations.map(d => [d.code.toUpperCase(), d]));
    const byName = new Map(locations.filter(d => d.kind === tab).map(d => [normName(d.name), d]));
    const supers = locations.filter(d => d.kind === "SUPER_STOCKIST");
    const taken: { code: string }[] = [...locations];
    const seen = new Set<string>();
    const out: ImportRow[] = [];
    for (const r of preview.grid.slice(preview.headerRow + 1)) {
      const v = (f: DField) => (col(f) >= 0 ? cellText(r[col(f)]) : "");
      const name = v("name");
      if (!name || /^(total|grand total)$/i.test(name)) continue;
      let code = v("code").toUpperCase();
      const byC = code ? byCode.get(code) : undefined;
      if (byC && byC.kind !== tab) code = ""; // that code belongs to another type
      const existing = (byC && byC.kind === tab ? byC : undefined) || byName.get(normName(name));
      if (!code) code = existing?.code || nextCode(tab, taken);
      if (seen.has(code)) code = nextCode(tab, taken);
      seen.add(code); taken.push({ code });
      const keep = (f: keyof Distributor, val: string) => val || (existing?.[f] as string | null) || null;
      let parent_id = existing?.parent_id || null, newSS = "";
      const ssName = tab === "DISTRIBUTOR" ? v("super_stockist") : "";
      if (ssName) { const ss = matchDistributor(ssName, supers); if (ss) parent_id = ss.id; else { newSS = ssName; parent_id = null; } }
      const row: Row = {
        id: existing?.id, code, kind: tab, name,
        company_name: keep("company_name", v("company_name")), owner_name: keep("owner_name", v("owner_name")),
        state: normalizeState(v("state")) || existing?.state || null, region: keep("region", v("region")), territory: keep("territory", v("territory")),
        phone: keep("phone", v("phone")), parent_id,
        super_stockist: tab === "DISTRIBUTOR" ? ssName || existing?.super_stockist || null : null,
        aliases: [...new Set([...(existing?.aliases || []), ...aliasCols.flatMap(i => splitAliases(cellText(r[i])))])],
      };
      out.push({ status: existing ? "update" : "new", missing: missingFields({ ...row, parent_id: parent_id || newSS }), newSS, row });
    }
    return out;
  }, [preview, locations, tab]);
  const complete = importRows.filter(x => !x.missing.length);
  const toImport = withIncomplete ? importRows : complete;
  const newSupers = [...new Map(toImport.filter(x => x.newSS).map(x => [normName(x.newSS), x.newSS])).values()];

  async function confirmImport() {
    if (!supabase || !toImport.length) return;
    setBusy(true);
    try {
      let created: Distributor[] = [];
      if (newSupers.length) {
        const taken: { code: string }[] = [...locations];
        const payload = newSupers.map(name => {
          const code = nextCode("SUPER_STOCKIST", taken); taken.push({ code });
          const first = toImport.find(x => normName(x.newSS) === normName(name));
          return { code, name, kind: "SUPER_STOCKIST", state: first?.row.state || null, aliases: [] };
        });
        const { data, error } = await supabase.from("distributors").insert(payload).select();
        if (error) throw error;
        created = data as Distributor[];
      }
      const ssId = (n: string) => created.find(c => normName(c.name) === normName(n))?.id || null;
      const rows = toImport.map(x => ({ ...x.row, parent_id: x.newSS ? ssId(x.newSS) : x.row.parent_id }));
      const inserts = rows.filter(r => !r.id).map(({ id: _, ...r }) => r);
      const updates = rows.filter(r => r.id);
      if (inserts.length) { const { error } = await supabase.from("distributors").insert(inserts); if (error) throw error; }
      if (updates.length) { const { error } = await supabase.from("distributors").upsert(updates, { onConflict: "id" }); if (error) throw error; }
      const skipped = importRows.length - toImport.length;
      show("ok", `Imported ${plural(toImport.length, KIND_LABEL[tab].toLowerCase(), KIND_PLURAL[tab].toLowerCase())} (${inserts.length} new, ${updates.length} updated)${created.length ? `, and added ${plural(created.length, "new super stockist")}. Fill in their details on the Super stockists tab` : ""}.${skipped ? ` ${plural(skipped, "row")} with empty fields ${skipped === 1 ? "was" : "were"} skipped.` : ""}`);
      setPreview(null); await onChanged();
    } catch (e: any) {
      show("err", `Import failed: ${e?.code === "42501" ? "only HO admins and state managers can import" : errText(e)}`);
    } finally { setBusy(false); }
  }

  function template() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([TEMPLATE_COLUMNS[tab]]), KIND_PLURAL[tab]);
    XLSX.writeFile(wb, `${KIND_PLURAL[tab].toLowerCase().replace(/ /g, "-")}-import.xlsx`);
  }

  const cols = tab === "GODOWN" ? 12 : 14;
  return <>
    <section className="tabs">
      {KINDS.slice().reverse().map(k => <button key={k} className={tab === k ? "active" : ""} onClick={() => switchTab(k)}>
        {KIND_PLURAL[k]} ({locations.filter(d => d.kind === k).length})</button>)}
    </section>

    {canManage ? <section className="card upload">
      <div className="rowhead"><h2>{editing ? `Edit ${editing.name}` : `Add ${KIND_LABEL[tab].toLowerCase()}`}</h2>
        <div className="actions"><button className="secondary" onClick={template}>Download blank import sheet</button>
          <label className="button secondary">Import from Excel<input hidden type="file" accept=".xlsx,.xls,.xlsm,.ods,.csv" onChange={e => { const x = e.target.files?.[0]; if (x) readImport(x); e.target.value = ""; }} /></label></div></div>
      <p className="hint">Fields marked * are required. Other names are optional: add the spellings used on their Tally reports so their files match automatically.</p>
      <LocationForm key={editing?.id || `new-${tab}`} kind={tab} editing={editing} locations={locations}
        onCancel={editing ? () => setEditing(null) : undefined}
        onSaved={async d => { setEditing(null); notify(`Saved ${d.name}.`); await onChanged(); }} />
      {msg && <div className={`status ${msg.kind}`}>{msg.text}</div>}
    </section> : <p className="notice">Only HO admins and state managers can add or edit {KIND_PLURAL[tab].toLowerCase()}.</p>}

    {preview && <section className="card">
      <div className="rowhead"><h2>Import preview — {preview.file}</h2>
        <div className="actions"><button className="secondary" onClick={() => setPreview(null)}>Cancel</button>
          <button onClick={confirmImport} disabled={busy || !toImport.length}>{busy ? "Importing…" : `Import ${plural(toImport.length, KIND_LABEL[tab].toLowerCase(), KIND_PLURAL[tab].toLowerCase())}`}</button></div></div>
      <p className="hint">Check what each column is. Existing records (same code or name) are updated, and blank cells keep their current values.</p>
      <div className="tablewrap"><table className="map"><tbody><tr>{preview.labels.map((l, i) => <td key={i}><small>{l || `column ${i + 1}`}</small>
        <select value={preview.mapping[i]} onChange={e => setPreview({ ...preview, mapping: preview.mapping.map((m, j) => (j === i ? e.target.value as DField : e.target.value !== "aliases" && m === e.target.value ? "ignore" : m)) })}>
          {(Object.keys(D_LABELS) as (DField | "ignore")[]).filter(k => tab === "DISTRIBUTOR" || k !== "super_stockist").map(k => <option key={k} value={k}>{D_LABELS[k]}</option>)}</select></td>)}</tr></tbody></table></div>
      {!preview.mapping.includes("name") && <p className="warn">Pick which column is the name.</p>}
      {importRows.length > complete.length && <div className="fixbox">
        <b>{importRows.length - complete.length} of {plural(importRows.length, "row")} {importRows.length - complete.length === 1 ? "has" : "have"} empty fields</b> (shown in red). They are skipped unless you include them.
        <label className="inline"><input type="checkbox" checked={withIncomplete} onChange={e => setWithIncomplete(e.target.checked)} /> Import them anyway and fill the gaps later (they'll be marked incomplete)</label>
      </div>}
      {newSupers.length > 0 && <p className="hint">{newSupers.length} super stockist{newSupers.length > 1 ? "s" : ""} in this sheet {newSupers.length > 1 ? "aren't" : "isn't"} in your list and will be added: {newSupers.slice(0, 8).join(", ")}{newSupers.length > 8 ? "…" : ""}. Fill in their details on the Super stockists tab afterwards.</p>}
      <div className="tablewrap"><table><thead><tr><th /><th>Code</th><th>Name</th><th>Company</th>{tab !== "GODOWN" && <th>Owner</th>}{tab === "DISTRIBUTOR" && <th>Super stockist</th>}<th>State</th><th>Region</th><th>City / area</th><th>Phone</th><th>Other names</th><th>Missing</th></tr></thead>
        <tbody>{importRows.slice(0, 500).map((x, i) => <tr key={i} className={x.missing.length ? "bad" : ""}>
          <td><span className={`pill ${x.status === "new" ? "input" : "count"}`}>{x.status}</span></td>
          <td>{x.row.code}</td><td>{x.row.name}</td><td className="wrap">{x.row.company_name}</td>{tab !== "GODOWN" && <td>{x.row.owner_name}</td>}
          {tab === "DISTRIBUTOR" && <td>{x.newSS ? <>{x.newSS} <em className="tag">new</em></> : byId.get(x.row.parent_id || "")?.name}</td>}
          <td>{x.row.state}</td><td>{x.row.region}</td><td>{x.row.territory}</td><td>{x.row.phone}</td><td className="wrap">{x.row.aliases.join(", ")}</td>
          <td className="check">{x.missing.length ? <span className="err">{x.missing.join(", ")}</span> : <span className="ok">✓</span>}</td></tr>)}</tbody></table>
        {importRows.length > 500 && <p className="hint">Showing the first 500 of {importRows.length} rows. All of them are imported.</p>}</div>
    </section>}

    <section className="card">
      <div className="rowhead"><h2>{KIND_PLURAL[tab]} ({list.length}{list.length !== ofKind.length ? ` of ${ofKind.length}` : ""})</h2>
        <div className="actions">
          <input className="search" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} />
          {nIncomplete > 0 && <label className="inline"><input type="checkbox" checked={onlyIncomplete} onChange={e => setOnlyIncomplete(e.target.checked)} /> Only incomplete ({nIncomplete})</label>}
        </div></div>
      <FilterBar locations={locations} value={scope} onChange={setScope} kinds={[tab]} rank={rank} saveKey={`distributors-${tab}`} />
      <div className="tablewrap"><table><thead><tr><th>Code</th><th>{KIND_LABEL[tab]}</th><th>Company</th>{tab !== "GODOWN" && <th>Owner</th>}
        {tab === "DISTRIBUTOR" && <th>Super stockist</th>}<th>State</th><th>Region</th><th>City / area</th><th>Phone</th><th>Other names</th>
        {tab === "SUPER_STOCKIST" && <th>Distributors</th>}<th>Stock units</th><th>Value ₹</th><th>Last movement</th><th>Comments</th>{canManage && <th />}</tr></thead>
        <tbody>{list.map(d => {
          const t = totals.get(d.id), miss = incomplete(d);
          return <Fragment key={d.id}><tr>
            <td>{d.code}</td>
            <td><b>{d.name}</b>{miss.length > 0 && <small className="missing">missing: {miss.join(", ")}</small>}</td>
            <td className="wrap">{d.company_name}</td>{tab !== "GODOWN" && <td>{d.owner_name}</td>}
            {tab === "DISTRIBUTOR" && <td>{byId.get(d.parent_id || "")?.name}</td>}
            <td>{d.state}</td><td>{d.region}</td><td>{d.territory}</td><td>{d.phone}</td><td className="wrap">{(d.aliases || []).join(", ")}</td>
            {tab === "SUPER_STOCKIST" && <td>{kids.get(d.id) || 0}</td>}
            <td>{fmt(t?.units)}</td><td>{fmt(t?.value)}</td><td>{t?.last || "—"}</td>
            <td><button className={`secondary small${openComments === d.id ? " on" : ""}`} aria-expanded={openComments === d.id} onClick={() => setOpenComments(o => (o === d.id ? null : d.id))}>
              💬 {count(d.id)}</button></td>
            {canManage && <td className="actions"><button className="secondary small" onClick={() => { setEditing(d); setMsg(null); scrollTo({ top: 0, behavior: "smooth" }); }}>Edit</button>
              <button className="del" title="Delete" aria-label={`Delete ${d.name}`} onClick={() => remove(d)}>✕</button></td>}
          </tr>
          {openComments === d.id && <tr><td colSpan={cols + (canManage ? 1 : 0)} className="sub">
            <Comments location={d} userId={userId} canManage={canManage} onCount={n => setCounts(c => ({ ...c, [d.id]: n }))} />
          </td></tr>}</Fragment>;
        })}</tbody></table>
        {!list.length && <p className="empty">No {KIND_PLURAL[tab].toLowerCase()}{ofKind.length ? " match" : " yet"}.</p>}</div>
    </section>
  </>;
}
