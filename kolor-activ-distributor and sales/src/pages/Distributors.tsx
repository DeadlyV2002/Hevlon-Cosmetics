import { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { supabase, Distributor, StockLine, fmt, errText } from "../lib/supabase";
import { readAnyFile } from "../lib/readers";
import { cellText, normName } from "../lib/parse";

interface Props { distributors: Distributor[]; stock: StockLine[]; canManage: boolean; onChanged: () => Promise<void>; notify: (m: string) => void }
type Form = { id?: string; code: string; name: string; territory: string; phone: string; aliases: string };
const blank: Form = { code: "", name: "", territory: "", phone: "", aliases: "" };

const splitAliases = (s: string) => s.split(/[,;\n]/).map(x => x.trim()).filter(Boolean);

export default function Distributors({ distributors, stock, canManage, onChanged, notify }: Props) {
  const [form, setForm] = useState<Form>(blank);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);

  const nextCode = () => {
    const nums = distributors.map(d => Number(d.code.match(/^D(\d+)$/i)?.[1] || 0));
    return `D${String(Math.max(0, ...nums) + 1).padStart(3, "0")}`;
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

  async function save() {
    if (!supabase) return;
    const name = form.name.trim();
    if (!name) return notify("Enter the distributor's name.");
    const code = (form.code.trim() || nextCode()).toUpperCase();
    const clash = distributors.find(d => d.id !== form.id && (d.code.toUpperCase() === code || normName(d.name) === normName(name)));
    if (clash) return notify(`"${clash.name}" (${clash.code}) already exists with that code or name.`);
    const payload = { code, name, territory: form.territory.trim() || null, phone: form.phone.trim() || null, aliases: splitAliases(form.aliases) };
    setBusy(true);
    const { error } = form.id
      ? await supabase.from("distributors").update(payload).eq("id", form.id)
      : await supabase.from("distributors").insert(payload);
    setBusy(false);
    if (error) return notify(error.code === "42501" ? "Only HO admins and state managers can add or edit distributors." : `Save failed: ${error.message}`);
    notify(form.id ? `Updated ${name}.` : `Added ${name} as ${code}.`);
    setForm(blank); await onChanged();
  }

  async function remove(d: Distributor) {
    if (!supabase || !confirm(`Delete ${d.name} (${d.code})?`)) return;
    const { error } = await supabase.from("distributors").delete().eq("id", d.id);
    if (error) return notify(error.code === "23503" ? `${d.name} has stock postings, so it can't be deleted. Undo its postings in History first.` : `Delete failed: ${error.message}`);
    notify(`Deleted ${d.name}.`); await onChanged();
  }

  async function importFile(f: File) {
    if (!supabase) return;
    setBusy(true);
    try {
      const t = await readAnyFile(f);
      const g = t.sheets[0]?.grid || [];
      const hr = g.findIndex(r => r.some(c => /name|distributor/i.test(cellText(c))));
      if (hr < 0) throw new Error('Need a column called "Name" (and optionally Code, Territory, Phone, Other names).');
      const h = g[hr].map(c => cellText(c).toLowerCase());
      const col = (re: RegExp) => h.findIndex(x => re.test(x));
      const cName = col(/^(distributor )?name$|^distributor$|party|firm/), cCode = col(/code/), cTerr = col(/territory|state|city|area|region/), cPhone = col(/phone|mobile|contact/), cAlias = col(/alias|other|also|tally/);
      if (cName < 0) throw new Error('No "Name" column found.');
      let n = Number(nextCode().slice(1));
      const existing = new Map(distributors.map(d => [normName(d.name), d]));
      const rows = g.slice(hr + 1).map(r => {
        const name = cellText(r[cName]); if (!name) return null;
        const old = existing.get(normName(name));
        const code = (cellText(r[cCode]) || old?.code || `D${String(n++).padStart(3, "0")}`).toUpperCase();
        return { code, name, territory: cellText(r[cTerr]) || old?.territory || null, phone: cellText(r[cPhone]) || old?.phone || null,
          aliases: [...new Set([...(old?.aliases || []), ...splitAliases(cellText(r[cAlias]))])] };
      }).filter(Boolean) as any[];
      if (!rows.length) throw new Error("No distributor rows found.");
      const { error } = await supabase.from("distributors").upsert(rows, { onConflict: "code" });
      if (error) throw error;
      notify(`Imported ${rows.length} distributors.`); await onChanged();
    } catch (e) { notify(`Import failed: ${errText(e)}`); }
    finally { setBusy(false); }
  }

  function template() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ Code: "D001", Name: "Sharma Traders", Territory: "Delhi", Phone: "", "Other names": "M/S Sharma Traders Pvt Ltd; STC Delhi" }]), "Distributors");
    XLSX.writeFile(wb, "distributors-template.xlsx");
  }

  const list = distributors.filter(d => `${d.code} ${d.name} ${d.territory || ""} ${(d.aliases || []).join(" ")}`.toLowerCase().includes(search.toLowerCase()));

  return <>
    {canManage ? <section className="card upload">
      <div className="rowhead"><h2>{form.id ? `Edit ${form.name}` : "Add distributor"}</h2>
        <div className="actions"><button className="secondary" onClick={template}>Import template</button>
          <label className="button secondary">Import from Excel<input hidden type="file" accept=".xlsx,.xls,.csv" onChange={e => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ""; }} /></label></div></div>
      <div className="formgrid">
        <label>Name *<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Sharma Traders" /></label>
        <label>Code<input value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} placeholder={form.id ? "" : `${nextCode()} (automatic)`} /></label>
        <label>Territory<input value={form.territory} onChange={e => setForm({ ...form, territory: e.target.value })} placeholder="Delhi" /></label>
        <label>Phone<input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></label>
        <label className="wide">Other names in their files <small>(comma-separated — e.g. the company name printed on their Tally reports)</small>
          <input value={form.aliases} onChange={e => setForm({ ...form, aliases: e.target.value })} placeholder="M/S Sharma Traders Pvt Ltd, STC Delhi" /></label>
      </div>
      <p className="hint">Files are matched to a distributor by code, name or any of the other names. "M/S", "Pvt Ltd", capitals and punctuation are ignored, so "SHARMA TRADERS PVT. LTD." matches "Sharma Traders".</p>
      <div className="actions">{form.id && <button className="secondary" onClick={() => setForm(blank)}>Cancel</button>}
        <button onClick={save} disabled={busy}>{form.id ? "Save changes" : "Add distributor"}</button></div>
    </section> : <p className="notice">Only HO admins and state managers can add or edit distributors.</p>}

    <section className="card">
      <div className="rowhead"><h2>Distributors ({distributors.length})</h2><input className="search" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} /></div>
      <div className="tablewrap"><table><thead><tr><th>Code</th><th>Name</th><th>Other names</th><th>Territory</th><th>Phone</th><th>Stock units</th><th>Stock value ₹</th><th>Last movement</th>{canManage && <th />}</tr></thead>
        <tbody>{list.map(d => { const t = totals.get(d.id); return <tr key={d.id}>
          <td>{d.code}</td><td><b>{d.name}</b></td><td className="wrap">{(d.aliases || []).join(", ")}</td><td>{d.territory}</td><td>{d.phone}</td>
          <td>{fmt(t?.units)}</td><td>{fmt(t?.value)}</td><td>{t?.last || "—"}</td>
          {canManage && <td className="actions"><button className="secondary small" onClick={() => { setForm({ id: d.id, code: d.code, name: d.name, territory: d.territory || "", phone: d.phone || "", aliases: (d.aliases || []).join(", ") }); scrollTo({ top: 0, behavior: "smooth" }); }}>Edit</button>
            <button className="del" title="Delete" onClick={() => remove(d)}>✕</button></td>}
        </tr>; })}</tbody></table>
        {!list.length && <p className="empty">No distributors yet.</p>}</div>
    </section>
  </>;
}
