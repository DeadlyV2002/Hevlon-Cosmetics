import { Select } from "../components/Select";
import { ask } from "../lib/ask";
import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { supabase, Distributor, Retailer, KIND_LABEL, matchDistributor, validPhone, plural, errText, proper, properOrNull, cleanPhones, StockLine, SalesOfficer, money, fmt } from "../lib/supabase";
import { readAnyFile, ACCEPT } from "../lib/readers";
import { cellText, normName, Grid } from "../lib/parse";
import { findHeader } from "../lib/sheet";
import DateRange, { PRESETS, Range } from "../components/DateRange";
import DistributorReport, { Billing, collectionPct } from "../components/DistributorReport";
import { STATES, normalizeState } from "../lib/india";
import FilterBar, { Scope, emptyScope, applyScope, scopeLabel } from "../components/FilterBar";
import { dmy } from "../lib/dates";

type RField = "name" | "distributor" | "owner_name" | "phone" | "territory" | "code";
const R_LABELS: Record<RField | "ignore", string> = { ignore: "— ignore —", name: "Retailer name", distributor: "Distributor", owner_name: "Owner", phone: "Phone", territory: "Area / beat", code: "Code" };
const R_RULES: [RField, RegExp][] = [
  ["distributor", /distributor|stockist|^db( name| code)?$|dealer/],
  ["owner_name", /owner|proprietor|contact person|person/],
  ["phone", /phone|mobile|contact( no| number)?$|whatsapp|cell/],
  ["territory", /area|beat|route|town|city|locality|location|market|address|village|place/],
  ["code", /code|^id$|outlet id|retailer id/],
  ["name", /retailer|outlet|shop|store|chemist|party|customer|name/],
];
interface Preview { file: string; grid: Grid; headerRow: number; labels: string[]; mapping: (RField | "ignore")[]; forAll: string }
type Form = { name: string; distributor_id: string; owner_name: string; phone: string; territory: string; code: string; state: string; region: string };
const blank: Form = { name: "", distributor_id: "", owner_name: "", phone: "", territory: "", code: "", state: "", region: "" };

const ORDERS = [{ id: "name", label: "Name (A to Z)" }, { id: "billed", label: "Billing (highest first)" }, { id: "best", label: "Collection % (best first)" }, { id: "worst", label: "Collection % (worst first)" }, { id: "stock", label: "Stock value (highest first)" }];
interface Props { retailers: Retailer[]; locations: Distributor[]; stock: StockLine[]; officers: SalesOfficer[]; canManage: boolean; onChanged: () => Promise<void>; notify: (m: string) => void;
  /** Only the state → super stockist → distributor tree (used on the Distributors page). */
  treeOnly?: boolean }

export default function Retailers({ retailers, locations, stock, officers, canManage, onChanged, notify, treeOnly }: Props) {
  const [scope, setScope] = useState<Scope>(emptyScope());
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"tree" | "table">("tree");
  const [openDist, setOpenDist] = useState<string | null>(null);
  /** Super stockist branches the user opened; their distributor cards are only built when open. */
  const [openSS, setOpenSS] = useState<Set<string>>(new Set());
  const [queue, setQueue] = useState<File[]>([]);
  function nextImport() { const [f, ...rest] = queue; setQueue(rest); setPreview(null); if (f) readImport(f); }
  /** Search boxes on each state and super stockist branch. */
  const [bq, setBq] = useState<Record<string, string>>({});
  const hits = (d: Distributor, t?: string) => !t || `${d.name} ${d.code} ${d.territory || ""} ${d.owner_name || ""} ${d.company_name || ""}`.toLowerCase().includes(t.toLowerCase());
  const searchBox = (key: string, what: string) => <input className="branchsearch" placeholder={`Search ${what}…`} value={bq[key] || ""} aria-label={`Search ${what}`}
    onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()} onKeyUp={e => e.preventDefault()} onChange={e => setBq({ ...bq, [key]: e.target.value })} />;
  const [report, setReport] = useState<Distributor | null>(null);
  const [order, setOrder] = useState("name");
  const [range, setRange] = useState<Range>(() => PRESETS.find(p => p.id === "fy")!.range());
  const [bills, setBills] = useState<Billing[]>([]);
  useEffect(() => {
    if (!supabase) return;
    supabase.rpc("billing_summary", { p_from: range.from, p_to: range.to }).then(({ data }) => setBills((data || []) as Billing[]));
  }, [range.from, range.to]);
  // Retailer counts only mean something once retailers are loaded; until then the tree shows distributors.
  const hasRetailers = !treeOnly && retailers.length > 0;
  const billMap = useMemo(() => new Map(bills.map(b => [`${b.party_type}|${b.party_id}`, b])), [bills]);
  const billOf = (id: string, t = "LOCATION") => billMap.get(`${t}|${id}`);
  const pctOf = (id: string, t = "LOCATION") => collectionPct(billOf(id, t));
  const stockVal = useMemo(() => { const m = new Map<string, number>(); stock.forEach(s => m.set(s.distributor_id, (m.get(s.distributor_id) || 0) + Number(s.stock_value || 0))); return m; }, [stock]);
  const stockOf = (id: string) => stockVal.get(id) || 0;
  const rankBy = (a: Distributor, b: Distributor) => {
    const by = (f: (d: Distributor) => number | null, dir: 1 | -1) => { const x = f(a), y = f(b); return x === null ? (y === null ? 0 : 1) : y === null ? -1 : (x - y) * dir; };
    const v = order === "stock" ? by(d => stockOf(d.id), -1) : order === "billed" ? by(d => Number(billOf(d.id)?.billed || 0), -1)
      : order === "best" ? by(d => pctOf(d.id), -1) : order === "worst" ? by(d => pctOf(d.id), 1) : 0;
    return v || a.name.localeCompare(b.name);
  };
  const [editing, setEditing] = useState<Retailer | null>(null);
  const [form, setForm] = useState<Form>(blank);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const show = (kind: "ok" | "err", text: string) => { setMsg({ kind, text }); notify(text); };

  const sellers = useMemo(() => locations.filter(l => l.kind !== "GODOWN"), [locations]);
  const byId = useMemo(() => new Map(locations.map(d => [d.id, d])), [locations]);
  const inScope = applyScope(sellers, scope);
  const scopeIds = new Set(inScope.map(d => d.id));
  const q = search.toLowerCase();
  const list = retailers.filter(r => scopeIds.has(r.distributor_id || "")
    && `${r.name} ${r.code || ""} ${r.territory || ""} ${r.owner_name || ""} ${r.phone || ""} ${byId.get(r.distributor_id || "")?.name || ""}`.toLowerCase().includes(q));

  // State → super stockist → distributor → retailers. Retailers sold to directly by a super stockist sit under the SS itself.
  const tree = useMemo(() => {
    const byDist = new Map<string, Retailer[]>();
    list.forEach(r => byDist.set(r.distributor_id || "", [...(byDist.get(r.distributor_id || "") || []), r]));
    const dists = inScope.filter(d => (treeOnly ? (q || d.kind === "SUPER_STOCKIST" ? byDist.has(d.id) || d.kind === "SUPER_STOCKIST" : true) : byDist.has(d.id)));
    const states = new Map<string, Map<string, Distributor[]>>();
    dists.forEach(d => {
      const st = d.state || "No state";
      const ss = d.kind === "SUPER_STOCKIST" ? d.id : d.parent_id || "";
      if (!states.has(st)) states.set(st, new Map());
      const m = states.get(st)!;
      m.set(ss, [...(m.get(ss) || []), d]);
    });
    return { states: [...states.entries()].sort((a, b) => a[0].localeCompare(b[0])), byDist };
  }, [list, inScope, q, treeOnly]);

  function edit(r: Retailer) {
    setEditing(r); setMsg(null);
    setForm({ name: r.name, distributor_id: r.distributor_id || "", owner_name: r.owner_name || "", phone: r.phone || "", territory: r.territory || "", code: r.code || "", state: r.state || "", region: r.region || "" });
    scrollTo({ top: 0, behavior: "smooth" });
  }
  async function save() {
    if (!supabase) return;
    const name = proper(form.name);
    if (!name || !form.distributor_id) return show("err", "Enter the retailer's name and choose their distributor.");
    if (form.phone.trim() && !validPhone(form.phone)) return show("err", "The phone number needs 8 to 13 digits.");
    const clash = retailers.find(r => r.id !== editing?.id && r.distributor_id === form.distributor_id && normName(r.name) === normName(name));
    if (clash) return show("err", `${clash.name} is already listed under this distributor.`);
    const t = (s: string) => s.trim() || null;
    const payload = { name, distributor_id: form.distributor_id, owner_name: properOrNull(form.owner_name), phone: t(cleanPhones(form.phone)), territory: properOrNull(form.territory), code: t(form.code),
      state: normalizeState(form.state) || properOrNull(form.state), region: properOrNull(form.region) };
    setBusy(true);
    const { error } = editing ? await supabase.from("retailers").update(payload).eq("id", editing.id) : await supabase.from("retailers").insert(payload);
    setBusy(false);
    if (error) return show("err", error.code === "42501" ? "Only HO admins and state managers can add or edit retailers." : `Save failed: ${error.message}`);
    show("ok", editing ? `Updated ${name}.` : `Added ${name}.`);
    setEditing(null); setForm(blank); await onChanged();
  }
  async function remove(r: Retailer) {
    if (!supabase || !await ask(`Delete retailer ${r.name}?`)) return;
    const { error } = await supabase.from("retailers").delete().eq("id", r.id);
    if (error) return show("err", error.code === "23503" ? `${r.name} appears in stock postings, so it can't be deleted.` : `Delete failed: ${error.message}`);
    show("ok", `Deleted ${r.name}.`); await onChanged();
  }

  // ---------- import ----------
  async function readImport(f: File) {
    setBusy(true); setMsg(null);
    try {
      const t = await readAnyFile(f);
      const g = t.sheets[0]?.grid || [];
      const h = findHeader(g, R_RULES, "name");
      if (!h) throw new Error("Couldn't find a heading row. The sheet needs a Retailer / Outlet name column and at least one more column.");
      setPreview({ file: f.name, grid: g, headerRow: h.row, labels: h.labels, mapping: h.mapping, forAll: "" });
    } catch (e) { show("err", `Import failed: ${errText(e)}`); }
    finally { setBusy(false); }
  }
  const importRows = useMemo(() => {
    if (!preview) return [];
    const col = (f: RField) => preview.mapping.indexOf(f);
    const existing = new Map(retailers.map(r => [`${r.distributor_id}|${normName(r.name)}`, r]));
    const seen = new Set<string>();
    return preview.grid.slice(preview.headerRow + 1).map(r => {
      const v = (f: RField) => (col(f) >= 0 ? cellText(r[col(f)]) : "");
      const name = proper(v("name"));
      if (!name || /^(total|grand total)$/i.test(name)) return null;
      const distText = v("distributor");
      const d = distText ? matchDistributor(distText, sellers) : sellers.find(s => s.id === preview.forAll);
      const key = `${d?.id}|${normName(name)}`;
      const dup = seen.has(key); seen.add(key);
      const old = d ? existing.get(key) : undefined;
      const keep = (f: keyof Retailer, val: string) => val || (old?.[f] as string | null) || null;
      return {
        problem: !d ? (distText ? `distributor "${distText}" not in your list` : "no distributor") : dup ? "listed twice in the sheet" : "",
        status: old ? "update" : "new", distName: d?.name || distText,
        row: { id: old?.id, name, distributor_id: d?.id || null, owner_name: keep("owner_name", proper(v("owner_name"))), phone: keep("phone", cleanPhones(v("phone"))), territory: keep("territory", proper(v("territory"))), code: keep("code", v("code")) },
      };
    }).filter(Boolean) as { problem: string; status: string; distName: string; row: Partial<Retailer> & { name: string } }[];
  }, [preview, retailers, sellers]);
  const good = importRows.filter(x => !x.problem);

  async function confirmImport() {
    if (!supabase || !good.length) return;
    setBusy(true);
    try {
      const inserts = good.filter(x => !x.row.id).map(({ row: { id: _, ...r } }) => r);
      const updates = good.filter(x => x.row.id).map(x => x.row);
      if (inserts.length) { const { error } = await supabase.from("retailers").insert(inserts); if (error) throw error; }
      if (updates.length) { const { error } = await supabase.from("retailers").upsert(updates, { onConflict: "id" }); if (error) throw error; }
      show("ok", `Imported ${plural(good.length, "retailer")} (${inserts.length} new, ${updates.length} updated).${importRows.length > good.length ? ` ${plural(importRows.length - good.length, "row")} skipped: see the reasons in the preview.` : ""}`);
      setPreview(null); await onChanged(); if (queue.length) nextImport();
    } catch (e: any) { show("err", `Import failed: ${e?.code === "42501" ? "only HO admins and state managers can import retailers" : errText(e)}`); }
    finally { setBusy(false); }
  }

  function exportList() {
    const rows = list.map(r => {
      const d = byId.get(r.distributor_id || ""), ss = d?.kind === "SUPER_STOCKIST" ? d : byId.get(d?.parent_id || "");
      return { Retailer: r.name, Code: r.code || "", Owner: r.owner_name || "", Phone: r.phone || "", "Area / beat": r.territory || "", Distributor: d?.name || "", "Distributor code": d?.code || "", "Super stockist": ss?.name || "", State: d?.state || "", Region: d?.region || "", "First seen": String(r.created_at || "").slice(0, 10) };
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, rows.length ? XLSX.utils.json_to_sheet(rows) : XLSX.utils.aoa_to_sheet([["No retailers in this selection."]]), "Retailers");
    XLSX.writeFile(wb, `retailers-${scopeLabel(sellers, scope).toLowerCase().replace(/[^a-z0-9]+/g, "-")}.xlsx`);
  }

  const f = (k: keyof Form) => ({ value: form[k], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value }) });
  const retailerTable = (rs: Retailer[]) => <table className="inner"><thead><tr><th>Retailer</th><th>Code</th><th>Owner</th><th>Phone</th><th>Area / beat</th><th>Billed</th><th>Paid</th><th>Collection %</th><th>First seen</th>{canManage && <th />}</tr></thead>
    <tbody>{[...rs].sort((a, b) => a.name.localeCompare(b.name)).map(r => { const rb = billOf(r.id, "RETAILER"), rp = pctOf(r.id, "RETAILER"); return <tr key={r.id}><td>{r.name}</td><td>{r.code}</td><td>{r.owner_name}</td><td>{r.phone}</td><td>{r.territory}</td>
      <td>{rb ? money(rb.billed) : "—"}</td><td>{rb ? money(rb.collected) : "—"}</td><td>{rp === null ? "—" : <span className={`pctbar${rp < 50 ? " low" : rp < 80 ? " mid" : " good"}`}>{fmt(rp)}%</span>}</td>
      <td>{dmy(r.created_at)}</td>
      {canManage && <td className="actions"><button className="secondary small" onClick={() => edit(r)}>Edit</button><button className="del" aria-label={`Delete ${r.name}`} onClick={() => remove(r)}>✕</button></td>}</tr>; })}</tbody></table>;

  return <>
    {!treeOnly && canManage && <section className="card upload">
      <div className="rowhead"><h2>{editing ? `Edit ${editing.name}` : "Add retailer"}</h2>
        <label className="button secondary">Import from Excel<input hidden type="file" multiple accept={ACCEPT} onChange={e => { const [x, ...rest] = [...(e.target.files || [])]; if (x) { readImport(x); setQueue(rest); } e.target.value = ""; }} /></label></div>
      <div className="formgrid">
        <label>Retailer name *<input {...f("name")} /></label>
        <label>Distributor *<Select value={form.distributor_id} onChange={e => { const d = byId.get(e.target.value); setForm({ ...form, distributor_id: e.target.value, state: form.state || d?.state || "", region: form.region || d?.region || "" }); }}><option value="">Choose…</option>
          {(["DISTRIBUTOR", "SUPER_STOCKIST"] as const).map(k => <optgroup key={k} label={k === "DISTRIBUTOR" ? "Distributors" : "Super stockists (selling direct)"}>
            {sellers.filter(s => s.kind === k).map(s => <option key={s.id} value={s.id}>{s.name} ({s.code}){s.territory ? ` · ${s.territory}` : ""}</option>)}</optgroup>)}</Select></label>
        <label>Owner<input {...f("owner_name")} /></label>
        <label>Phone<input {...f("phone")} inputMode="tel" /></label>
        <label>State <small>where the shop is</small><Select value={form.state} onChange={e => setForm({ ...form, state: e.target.value })}><option value="">Choose…</option>
          {form.state && !STATES.includes(form.state) && <option value={form.state}>{form.state}</option>}{STATES.map(s => <option key={s} value={s}>{s}</option>)}</Select></label>
        <label>Region <small>its own, if not the distributor's</small><input {...f("region")} /></label>
        <label>Area / beat<input {...f("territory")} /></label>
        <label>Code<input {...f("code")} /></label>
      </div>
      <div className="actions">{editing && <button className="secondary" onClick={() => { setEditing(null); setForm(blank); }}>Cancel</button>}
        <button onClick={save} disabled={busy}>{editing ? "Save changes" : "Add retailer"}</button>
        {msg && <span className={`status inline-status ${msg.kind}`}>{msg.text}</span>}</div>
      <p className="hint">Retailers are also added automatically when a distributor's sales file names a new one. The import reads columns such as Retailer / Outlet name, Distributor, Owner, Mobile and Beat.</p>
    </section>}

    {!treeOnly && preview && <section className="card">
      <div className="rowhead"><h2>Import preview — {preview.file}</h2>
        <div className="actions"><button className="secondary" onClick={() => (queue.length ? nextImport() : setPreview(null))}>{queue.length ? `Skip, Next File (${queue.length} Left)` : "Cancel"}</button>
          <button onClick={confirmImport} disabled={busy || !good.length}>{busy ? "Importing…" : `Import ${plural(good.length, "retailer")}`}</button></div></div>
      <div className="tablewrap"><table className="map"><tbody><tr>{preview.labels.map((l, i) => <td key={i}><small>{l || `column ${i + 1}`}</small>
        <Select value={preview.mapping[i]} onChange={e => setPreview({ ...preview, mapping: preview.mapping.map((m, j) => (j === i ? e.target.value as RField : m === e.target.value ? "ignore" : m)) })}>
          {(Object.keys(R_LABELS) as (RField | "ignore")[]).map(k => <option key={k} value={k}>{R_LABELS[k]}</option>)}</Select></td>)}</tr></tbody></table></div>
      {!preview.mapping.includes("distributor") && <label className="inline">No distributor column. They all work under:
        <Select value={preview.forAll} onChange={e => setPreview({ ...preview, forAll: e.target.value })}><option value="">choose…</option>
          {sellers.map(s => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}</Select></label>}
      <div className="tablewrap"><table><thead><tr><th /><th>Retailer</th><th>Distributor</th><th>Owner</th><th>Phone</th><th>Area / beat</th><th>Code</th><th>Check</th></tr></thead>
        <tbody>{importRows.slice(0, 500).map((x, i) => <tr key={i} className={x.problem ? "bad" : ""}><td><span className={`pill ${x.status === "new" ? "input" : "count"}`}>{x.status}</span></td>
          <td>{x.row.name}</td><td>{x.distName}</td><td>{x.row.owner_name}</td><td>{x.row.phone}</td><td>{x.row.territory}</td><td>{x.row.code}</td>
          <td className="check">{x.problem ? <span className="err">{x.problem}</span> : <span className="ok">Ready</span>}</td></tr>)}</tbody></table></div>
      {importRows.some(x => x.problem.startsWith("distributor")) && <p className="hint">Rows whose distributor isn't recognised are skipped. Add the distributor, or its spelling as an "other name", on the Distributors page, then import again.</p>}
    </section>}

    <section className="card">
      <div className="rowhead"><h2>{treeOnly ? "Distributor Tree" : `Retailers (${list.length}${list.length !== retailers.length ? ` of ${retailers.length}` : ""})`}</h2>
        {!treeOnly && <div className="actions">
          <div className="seg" role="group" aria-label="View"><button className={view === "tree" ? "on" : ""} onClick={() => setView("tree")}>Tree</button><button className={view === "table" ? "on" : ""} onClick={() => setView("table")}>Table</button></div>
          <input className="search" placeholder="Search retailers…" value={search} onChange={e => setSearch(e.target.value)} />
          <button className="secondary" onClick={exportList} disabled={!list.length}>Export to Excel</button></div>}</div>
      {treeOnly && <p className="hint">Every distributor by state and super stockist, with stock, billing and collection. Click a name for its report.</p>}
      {!treeOnly && !retailers.length && <p className="empty">No retailers yet. Add them above or import a list. The distributor tree is on the Distributors page.</p>}
      <FilterBar locations={locations} value={scope} onChange={setScope} kinds={["DISTRIBUTOR", "SUPER_STOCKIST"]} saveKey="retailers" />
      {(treeOnly || view === "tree") && <div className="rt-sort">
        <label className="inline">Order distributors by <Select value={order} onChange={e => setOrder(e.target.value)} aria-label="Order distributors by">
          {ORDERS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</Select></label>
        <DateRange value={range} onChange={setRange} />
        <small className="muted">Billing and collection over this period.</small>
      </div>}
      {treeOnly || view === "tree" ? <div className="rtree">
        {tree.states.map(([state, supers]) => {
          const all = [...supers.values()].flat(), n = all.reduce((a, d) => a + (tree.byDist.get(d.id)?.length || 0), 0);
          return <details key={state} className="rt-state" open>
            <summary><h3>{state}</h3><span className="rt-badge">{plural(supers.size, "super stockist")}</span><span className="rt-badge">{plural(all.filter(d => d.kind === "DISTRIBUTOR").length, "distributor")}</span>
              {hasRetailers && <span className="rt-badge">{plural(n, "retailer")}</span>}{searchBox(`st:${state}`, `${state} distributors`)}</summary>
            <div className="rt-branch">
              {[...supers.entries()].filter(([ssId, ds]) => !bq[`st:${state}`] || (byId.get(ssId) && hits(byId.get(ssId)!, bq[`st:${state}`])) || ds.some(d => hits(d, bq[`st:${state}`]))).sort((a, b) => (byId.get(a[0])?.name || "~").localeCompare(byId.get(b[0])?.name || "~")).map(([ssId, dists]) => {
                const ss = byId.get(ssId), m = dists.reduce((a, d) => a + (tree.byDist.get(d.id)?.length || 0), 0), ssPct = ss ? pctOf(ss.id) : null;
                const ordered = dists.filter(d => (hits(d, bq[`st:${state}`]) || (ss && hits(ss, bq[`st:${state}`]))) && hits(d, bq[`ss:${ssId}`])).sort((a, b) => (a.kind === "SUPER_STOCKIST" ? -1 : b.kind === "SUPER_STOCKIST" ? 1 : rankBy(a, b)));
                const ssKey = `${state}|${ssId}`, ssOpen = openSS.has(ssKey) || !!bq[`st:${state}`] || !!q;
                return <details key={ssId || "none"} className="rt-ss" open={ssOpen} onToggle={e => { const o = (e.currentTarget as HTMLDetailsElement).open; if (o !== ssOpen) setOpenSS(x => { const n = new Set(x); o ? n.add(ssKey) : n.delete(ssKey); return n; }); }}>
                  <summary><span className="kind">SS</span>{ss ? <button className="link strong" onClick={e => { e.preventDefault(); setReport(ss); }}>{ss.name}</button> : <b>No super stockist</b>}{ss?.territory && <small>{ss.territory}</small>}
                    <span className="rt-badge">{plural(dists.filter(d => d.kind === "DISTRIBUTOR").length, "distributor")}</span>
                    {hasRetailers && <span className="rt-badge">{plural(m, "retailer")}</span>}
                    {ssPct !== null && <span className={`pctbar${ssPct < 50 ? " low" : ssPct < 80 ? " mid" : " good"}`} title="Collection %">{fmt(ssPct)}% collected</span>}{searchBox(`ss:${ssId}`, "distributors")}</summary>
                  {ssOpen && <div className="rt-dists">{ordered.map(d => {
                    const rs = [...(tree.byDist.get(d.id) || [])].sort((a, b) => a.name.localeCompare(b.name)), open = openDist === d.id, p = pctOf(d.id), b = billOf(d.id);
                    return <div key={d.id} className={`rt-dist${open ? " open" : ""}`}>
                      <button className="rt-distbtn" onClick={() => setReport(d)} title="Open report">
                        <b>{d.kind === "SUPER_STOCKIST" ? `Sold direct by ${d.name}` : d.name}</b>
                        {hasRetailers ? <span className="rt-count">{rs.length}<small>{rs.length === 1 ? "retailer" : "retailers"}</small></span>
                          : <span className={`rt-count${p === null ? " none" : p < 50 ? " low" : p < 80 ? " mid" : " good"}`}>{p === null ? "—" : `${fmt(p)}%`}<small>collected</small></span>}
                        <small>{[d.territory, d.owner_name, d.phone].filter(Boolean).join(" · ") || d.code}</small>
                      </button>
                      <div className="rt-stats"><span className="rt-badge">Stock {money(stockOf(d.id))}</span>{b && <span className="rt-badge">Billed {money(b.billed)}</span>}{b && <span className="rt-badge">Paid {money(b.collected)}</span>}</div>
                      {hasRetailers && rs.length > 0 && !open && <div className="rt-chips">{rs.slice(0, 4).map(x => <span key={x.id} className="rt-chip">{x.name}</span>)}
                        <button className="rt-chip more" onClick={() => setOpenDist(d.id)}>{rs.length > 4 ? `+${rs.length - 4} More` : "Show Retailers"}</button></div>}
                      {open && <><div className="tablewrap">{retailerTable(rs)}</div><button className="link" onClick={() => setOpenDist(null)}>Hide Retailers</button></>}
                    </div>;
                  })}</div>}
                </details>;
              })}
            </div>
          </details>;
        })}
        {!tree.states.length && (treeOnly || retailers.length > 0) && <p className="empty">No distributors match.</p>}
      </div> : <div className="tablewrap"><table><thead><tr><th>Retailer</th><th>Code</th><th>Distributor</th><th>Super stockist</th><th>State</th><th>Region</th><th>Area / beat</th><th>Owner</th><th>Phone</th><th>First seen</th>{canManage && <th />}</tr></thead>
        <tbody>{list.slice(0, 2000).map(r => {
          const d = byId.get(r.distributor_id || ""), ss = d?.kind === "SUPER_STOCKIST" ? d : byId.get(d?.parent_id || "");
          return <tr key={r.id}><td>{r.name}</td><td>{r.code}</td><td>{d?.name}</td><td>{ss?.name}</td><td>{d?.state}</td><td>{d?.region}</td><td>{r.territory}</td><td>{r.owner_name}</td><td>{r.phone}</td>
            <td>{dmy(r.created_at)}</td>
            {canManage && <td className="actions"><button className="secondary small" onClick={() => edit(r)}>Edit</button><button className="del" aria-label={`Delete ${r.name}`} onClick={() => remove(r)}>✕</button></td>}</tr>;
        })}</tbody></table>
        {list.length > 2000 && <p className="hint">Showing 2,000 of {list.length}. Narrow the filters or export to Excel for all of them.</p>}
        {!list.length && <p className="empty">No retailers match.</p>}</div>}
    </section>
    {report && <DistributorReport location={report} locations={locations} stock={stock} officers={officers} onClose={() => setReport(null)} />}
  </>;
}
