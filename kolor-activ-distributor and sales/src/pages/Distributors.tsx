import { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { supabase, Distributor, StockLine, fmt, errText } from "../lib/supabase";
import { readAnyFile } from "../lib/readers";
import { cellText, normName, Grid } from "../lib/parse";

interface Props { distributors: Distributor[]; stock: StockLine[]; canManage: boolean; onChanged: () => Promise<void>; notify: (m: string) => void }

type DField = "ignore" | "code" | "name" | "company_name" | "owner_name" | "super_stockist" | "territory" | "phone" | "aliases";
const D_LABELS: Record<DField, string> = {
  ignore: "— ignore —", code: "Code", name: "Distributor name", company_name: "Company name", owner_name: "Owner name",
  super_stockist: "Super stockist", territory: "Territory / area", phone: "Phone", aliases: "Other names",
};
// First match wins, so the specific columns come before plain "name".
const D_RULES: [DField, RegExp][] = [
  ["super_stockist", /super|^ss( name| code)?$|parent|works under|^under$/],
  ["owner_name", /owner|proprietor|contact person|person|partner|director/],
  ["company_name", /company|firm legal|legal name|registered name|business name/],
  ["phone", /phone|mobile|contact( no| number)?$|whatsapp|cell/],
  ["territory", /territory|area|city|state|region|town|location|district|zone|beat|market|pin ?code|pincode|address/],
  ["aliases", /alias|other name|also|tally name|name in tally|name in file/],
  ["code", /code|^id$|db no|dist no|^no$/],
  ["name", /name|distributor|dealer|firm|party|^db$|stockist/],
];
const fieldOf = (label: string): DField => { const l = label.toLowerCase().replace(/[._:#()\-/]+/g, " ").replace(/\s+/g, " ").trim(); if (!l || /^(s ?no|sr ?no|sl ?no|serial|#)$/.test(l)) return "ignore"; for (const [f, re] of D_RULES) if (re.test(l)) return f; return "ignore"; };

type Form = { id?: string; code: string; name: string; company_name: string; owner_name: string; super_stockist: string; territory: string; phone: string; aliases: string };
const blank: Form = { code: "", name: "", company_name: "", owner_name: "", super_stockist: "", territory: "", phone: "", aliases: "" };
const splitAliases = (s: string) => s.split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
const opt = (s: string) => s.trim() || null;

interface Preview { file: string; grid: Grid; headerRow: number; labels: string[]; mapping: DField[] }

export default function Distributors({ distributors, stock, canManage, onChanged, notify }: Props) {
  const [form, setForm] = useState<Form>(blank);
  const [search, setSearch] = useState(""), [superFilter, setSuperFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [formMsg, setFormMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const supers = useMemo(() => [...new Set(distributors.map(d => d.super_stockist?.trim()).filter(Boolean) as string[])].sort(), [distributors]);
  const nextCodeFrom = (list: { code: string }[]) => {
    const nums = list.map(d => Number(d.code.match(/^D(\d+)$/i)?.[1] || 0));
    return Math.max(0, ...nums) + 1;
  };
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

  const show = (kind: "ok" | "err", text: string) => { setFormMsg({ kind, text }); notify(text); };

  async function save() {
    if (!supabase) return;
    const name = form.name.trim();
    if (!name) return show("err", "Enter the distributor's name.");
    const code = (form.code.trim() || `D${String(nextCodeFrom(distributors)).padStart(3, "0")}`).toUpperCase();
    const clash = distributors.find(d => d.id !== form.id && (d.code.toUpperCase() === code || normName(d.name) === normName(name)));
    if (clash) return show("err", `"${clash.name}" (${clash.code}) already exists with that code or name.`);
    const payload = { code, name, company_name: opt(form.company_name), owner_name: opt(form.owner_name), super_stockist: opt(form.super_stockist),
      territory: opt(form.territory), phone: opt(form.phone), aliases: splitAliases(form.aliases) };
    setBusy(true);
    const { error } = form.id
      ? await supabase.from("distributors").update(payload).eq("id", form.id)
      : await supabase.from("distributors").insert(payload);
    setBusy(false);
    if (error) return show("err", error.code === "42501" ? "Only HO admins and state managers can add or edit distributors." : `Save failed: ${error.message}`);
    show("ok", form.id ? `Updated ${name}.` : `Added ${name} as ${code}.`);
    setForm(blank); await onChanged();
  }

  async function remove(d: Distributor) {
    if (!supabase || !confirm(`Delete ${d.name} (${d.code})?`)) return;
    const { error } = await supabase.from("distributors").delete().eq("id", d.id);
    if (error) return show("err", error.code === "23503" ? `${d.name} has stock postings, so it can't be deleted. Undo its postings in History first.` : `Delete failed: ${error.message}`);
    show("ok", `Deleted ${d.name}.`); await onChanged();
  }

  // ---------- Excel import with preview ----------
  async function readImport(f: File) {
    setBusy(true);
    try {
      const t = await readAnyFile(f);
      const g = t.sheets[0]?.grid || [];
      let best = -1, bestScore = 0;
      for (let r = 0; r < Math.min(g.length, 30); r++) {
        const fields = (g[r] || []).map(c => fieldOf(cellText(c)));
        const score = new Set(fields.filter(x => x !== "ignore")).size + (fields.includes("name") ? 2 : 0);
        if (score > bestScore) { bestScore = score; best = r; }
      }
      if (best < 0 || bestScore < 2) throw new Error("Couldn't find a heading row. The sheet needs a column called Name or Distributor Name.");
      const labels = (g[best] || []).map(cellText);
      const mapping = labels.map(fieldOf);
      // One column per field; if there is no plain name column, use the company name.
      const seen = new Set<DField>();
      mapping.forEach((m, i) => { if (m !== "ignore" && m !== "aliases") { if (seen.has(m)) mapping[i] = "ignore"; seen.add(m); } });
      if (!mapping.includes("name")) { const ci = mapping.indexOf("company_name"); if (ci >= 0) mapping[ci] = "name"; }
      setPreview({ file: f.name, grid: g, headerRow: best, labels, mapping });
    } catch (e) { show("err", `Import failed: ${errText(e)}`); }
    finally { setBusy(false); }
  }

  const importRows = useMemo(() => {
    if (!preview) return [];
    const col = (f: DField) => preview.mapping.indexOf(f);
    const aliasCols = preview.mapping.map((m, i) => (m === "aliases" ? i : -1)).filter(i => i >= 0);
    const byCode = new Map(distributors.map(d => [d.code.toUpperCase(), d]));
    const byName = new Map(distributors.map(d => [normName(d.name), d]));
    let n = nextCodeFrom(distributors);
    const seenCodes = new Set<string>();
    return preview.grid.slice(preview.headerRow + 1).map(r => {
      const v = (f: DField) => (col(f) >= 0 ? cellText(r[col(f)]) : "");
      const name = v("name");
      if (!name || /^(total|grand total)$/i.test(name)) return null;
      let code = v("code").toUpperCase();
      const existing = (code && byCode.get(code)) || byName.get(normName(name));
      if (!code) code = existing?.code || `D${String(n++).padStart(3, "0")}`;
      if (seenCodes.has(code)) code = `D${String(n++).padStart(3, "0")}`;
      seenCodes.add(code);
      const keep = (f: keyof Distributor, val: string) => val || (existing?.[f] as string | null) || null;
      return {
        status: existing ? "update" : "new",
        row: {
          code, name, company_name: keep("company_name", v("company_name")), owner_name: keep("owner_name", v("owner_name")),
          super_stockist: keep("super_stockist", v("super_stockist")), territory: keep("territory", v("territory")), phone: keep("phone", v("phone")),
          aliases: [...new Set([...(existing?.aliases || []), ...aliasCols.flatMap(i => splitAliases(cellText(r[i])))])],
        },
      };
    }).filter(Boolean) as { status: string; row: any }[];
  }, [preview, distributors]);

  async function confirmImport() {
    if (!supabase || !importRows.length) return;
    setBusy(true);
    const { error } = await supabase.from("distributors").upsert(importRows.map(x => x.row), { onConflict: "code" });
    setBusy(false);
    if (error) return show("err", `Import failed: ${error.code === "42501" ? "only HO admins and state managers can import distributors" : error.message}`);
    const nNew = importRows.filter(x => x.status === "new").length;
    show("ok", `Imported ${importRows.length} distributors (${nNew} new, ${importRows.length - nNew} updated).`);
    setPreview(null); await onChanged();
  }

  function template() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
      { Code: "D001", "Distributor Name": "Sharma Traders", "Company Name": "Shree Balaji Enterprises Pvt Ltd", "Owner Name": "Ramesh Sharma", "Super Stockist": "North Zone SS", Territory: "Delhi", Phone: "98xxxxxxxx", "Other Names": "STC Delhi; M/S Sharma Traders" },
    ]), "Distributors");
    XLSX.writeFile(wb, "distributors-template.xlsx");
  }

  const list = distributors.filter(d => (!superFilter || (superFilter === "—" ? !d.super_stockist : d.super_stockist === superFilter))
    && `${d.code} ${d.name} ${d.company_name || ""} ${d.owner_name || ""} ${d.super_stockist || ""} ${d.territory || ""} ${(d.aliases || []).join(" ")}`.toLowerCase().includes(search.toLowerCase()));
  const f = (k: keyof Form) => ({ value: form[k] as string, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value }) });

  return <>
    {canManage ? <section className="card upload">
      <div className="rowhead"><h2>{form.id ? `Edit ${form.name}` : "Add distributor"}</h2>
        <div className="actions"><button className="secondary" onClick={template}>Download import template</button>
          <label className="button secondary">Import from Excel<input hidden type="file" accept=".xlsx,.xls,.xlsm,.ods,.csv" onChange={e => { const x = e.target.files?.[0]; if (x) readImport(x); e.target.value = ""; }} /></label></div></div>
      <div className="formgrid">
        <label>Distributor name *<input {...f("name")} placeholder="Sharma Traders" /></label>
        <label>Company name<input {...f("company_name")} placeholder="Shree Balaji Enterprises Pvt Ltd" /></label>
        <label>Owner name<input {...f("owner_name")} placeholder="Ramesh Sharma" /></label>
        <label>Super stockist<input {...f("super_stockist")} list="supers-dl" placeholder="type or pick" /></label>
        <label>Code<input {...f("code")} placeholder={form.id ? "" : `D${String(nextCodeFrom(distributors)).padStart(3, "0")} (automatic)`} /></label>
        <label>Territory<input {...f("territory")} placeholder="Delhi" /></label>
        <label>Phone<input {...f("phone")} /></label>
        <label className="wide">Other names in their files <small>(comma-separated — any other spelling on their Tally reports or sheets)</small>
          <input {...f("aliases")} placeholder="STC Delhi, M/S Sharma Traders" /></label>
      </div>
      <datalist id="supers-dl">{supers.map(s => <option key={s} value={s} />)}</datalist>
      <p className="hint">Uploaded files are matched to a distributor by code, distributor name, company name or any other name. "M/S", "Pvt Ltd", capitals and punctuation are ignored.</p>
      <div className="actions">{form.id && <button className="secondary" onClick={() => { setForm(blank); setFormMsg(null); }}>Cancel</button>}
        <button onClick={save} disabled={busy}>{form.id ? "Save changes" : "Add distributor"}</button>
        {formMsg && <span className={`status inline-status ${formMsg.kind}`}>{formMsg.text}</span>}</div>
    </section> : <p className="notice">Only HO admins and state managers can add or edit distributors.</p>}

    {preview && <section className="card">
      <div className="rowhead"><h2>Import preview — {preview.file}</h2>
        <div className="actions"><button className="secondary" onClick={() => setPreview(null)}>Cancel</button>
          <button onClick={confirmImport} disabled={busy || !importRows.length}>Import {importRows.length} distributors</button></div></div>
      <p className="hint">Check what each column is. Existing distributors (same code, or same name) are updated; blank cells keep their current values.</p>
      <div className="tablewrap"><table className="map"><tbody><tr>{preview.labels.map((l, i) => <td key={i}><small>{l || `column ${i + 1}`}</small>
        <select value={preview.mapping[i]} onChange={e => setPreview({ ...preview, mapping: preview.mapping.map((m, j) => (j === i ? e.target.value as DField : e.target.value !== "aliases" && m === e.target.value ? "ignore" : m)) })}>
          {(Object.keys(D_LABELS) as DField[]).map(k => <option key={k} value={k}>{D_LABELS[k]}</option>)}</select></td>)}</tr></tbody></table></div>
      {!preview.mapping.includes("name") && <p className="warn">Pick which column is the distributor name.</p>}
      <div className="tablewrap"><table><thead><tr><th /><th>Code</th><th>Name</th><th>Company</th><th>Owner</th><th>Super stockist</th><th>Territory</th><th>Phone</th><th>Other names</th></tr></thead>
        <tbody>{importRows.slice(0, 300).map((x, i) => <tr key={i}><td><span className={`pill ${x.status === "new" ? "input" : "count"}`}>{x.status}</span></td>
          <td>{x.row.code}</td><td>{x.row.name}</td><td>{x.row.company_name}</td><td>{x.row.owner_name}</td><td>{x.row.super_stockist}</td><td>{x.row.territory}</td><td>{x.row.phone}</td><td className="wrap">{x.row.aliases.join(", ")}</td></tr>)}</tbody></table></div>
    </section>}

    <section className="card">
      <div className="rowhead"><h2>Distributors ({list.length}{list.length !== distributors.length ? ` of ${distributors.length}` : ""})</h2>
        <div className="actions">
          <select value={superFilter} onChange={e => setSuperFilter(e.target.value)}><option value="">All super stockists</option>{supers.map(s => <option key={s} value={s}>{s}</option>)}<option value="—">No super stockist</option></select>
          <input className="search" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} /></div></div>
      <div className="tablewrap"><table><thead><tr><th>Code</th><th>Distributor</th><th>Company</th><th>Owner</th><th>Super stockist</th><th>Territory</th><th>Phone</th><th>Other names</th><th>Stock units</th><th>Value ₹</th><th>Last movement</th>{canManage && <th />}</tr></thead>
        <tbody>{list.map(d => { const t = totals.get(d.id); return <tr key={d.id}>
          <td>{d.code}</td><td><b>{d.name}</b></td><td className="wrap">{d.company_name}</td><td>{d.owner_name}</td><td>{d.super_stockist}</td><td>{d.territory}</td><td>{d.phone}</td>
          <td className="wrap">{(d.aliases || []).join(", ")}</td><td>{fmt(t?.units)}</td><td>{fmt(t?.value)}</td><td>{t?.last || "—"}</td>
          {canManage && <td className="actions"><button className="secondary small" onClick={() => { setFormMsg(null); setForm({ id: d.id, code: d.code, name: d.name, company_name: d.company_name || "", owner_name: d.owner_name || "", super_stockist: d.super_stockist || "", territory: d.territory || "", phone: d.phone || "", aliases: (d.aliases || []).join(", ") }); scrollTo({ top: 0, behavior: "smooth" }); }}>Edit</button>
            <button className="del" title="Delete" onClick={() => remove(d)}>✕</button></td>}
        </tr>; })}</tbody></table>
        {!list.length && <p className="empty">No distributors{distributors.length ? " match" : " yet"}.</p>}</div>
    </section>
  </>;
}
