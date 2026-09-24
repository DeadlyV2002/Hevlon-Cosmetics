import { useEffect, useState } from "react";
import { supabase, SalesOfficer, validPhone, fmt, errText } from "../lib/supabase";
import { normName } from "../lib/parse";
import { STATES, normalizeState } from "../lib/india";
import { splitAliases } from "../components/LocationForm";

interface Report { id: string; created_at: string; source_file: string | null; lines: number; units: number; from_date: string | null; to_date: string | null; so_names: string | null }
type Form = { name: string; phone: string; state: string; region: string; aliases: string; active: boolean };
const blank: Form = { name: "", phone: "", state: "", region: "", aliases: "", active: true };

/** The SO list and the SO reports uploaded so far (with undo). */
export default function SalesOfficers({ officers, canManage, onChanged, notify }: { officers: SalesOfficer[]; canManage: boolean; onChanged: () => Promise<void>; notify: (m: string) => void }) {
  const [editing, setEditing] = useState<SalesOfficer | null>(null);
  const [form, setForm] = useState<Form>(blank);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [reports, setReports] = useState<Report[]>([]);

  async function loadReports() {
    if (!supabase) return;
    const { data, error } = await supabase.from("so_report_summary").select("*").order("created_at", { ascending: false }).limit(100);
    if (!error) setReports(data as Report[]);
  }
  useEffect(() => { loadReports(); }, [officers]);

  async function save() {
    if (!supabase) return;
    const name = form.name.trim();
    if (!name) return setMsg({ kind: "err", text: "Enter the SO's name." });
    if (form.phone.trim() && !validPhone(form.phone)) return setMsg({ kind: "err", text: "The phone number needs 8 to 13 digits." });
    const clash = officers.find(o => o.id !== editing?.id && normName(o.name) === normName(name));
    if (clash) return setMsg({ kind: "err", text: `${clash.name} (${clash.code}) is already in the list.` });
    const payload = { name, phone: form.phone.trim() || null, state: normalizeState(form.state) || null, region: form.region.trim() || null, aliases: splitAliases(form.aliases), active: form.active };
    const code = editing?.code || `SO${String(Math.max(0, ...officers.map(o => Number(o.code.match(/^SO(\d+)$/i)?.[1] || 0))) + 1).padStart(3, "0")}`;
    const { error } = editing ? await supabase.from("sales_officers").update(payload).eq("id", editing.id) : await supabase.from("sales_officers").insert({ ...payload, code });
    if (error) return setMsg({ kind: "err", text: error.code === "42501" ? "Only HO admins and state managers can change the SO list." : `Save failed: ${error.message}` });
    setMsg({ kind: "ok", text: editing ? `Updated ${name}.` : `Added ${name} as ${code}.` });
    setEditing(null); setForm(blank); await onChanged();
  }
  async function undo(r: Report) {
    if (!supabase || !confirm(`Remove this SO report (${r.lines} lines from ${r.source_file || "manual entry"})?`)) return;
    const { error } = await supabase.rpc("delete_so_report", { p_report: r.id });
    if (error) return notify(`Undo failed: ${errText(error)}`);
    notify("SO report removed."); await loadReports(); await onChanged();
  }
  const f = (k: keyof Form) => ({ value: String(form[k]), onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value }) });

  return <>
    <section className="card">
      <div className="rowhead"><h2>Sales officers ({officers.length})</h2></div>
      {canManage && <>
        <div className="formgrid">
          <label>SO name *<input {...f("name")} /></label>
          <label>Phone<input {...f("phone")} inputMode="tel" /></label>
          <label>State<select {...f("state")}><option value="">Choose…</option>{STATES.map(s => <option key={s} value={s}>{s}</option>)}</select></label>
          <label>Region / HQ<input {...f("region")} /></label>
          <label className="wide">Other names in their sheets <small>(optional, comma-separated)</small><input {...f("aliases")} /></label>
          {editing && <label className="inline"><input type="checkbox" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })} /> Still working</label>}
        </div>
        <div className="actions">{editing && <button className="secondary" onClick={() => { setEditing(null); setForm(blank); }}>Cancel</button>}
          <button onClick={save}>{editing ? "Save changes" : "Add SO"}</button>
          {msg && <span className={`status inline-status ${msg.kind}`}>{msg.text}</span>}</div>
      </>}
      <div className="tablewrap"><table><thead><tr><th>Code</th><th>Name</th><th>Phone</th><th>State</th><th>Region / HQ</th><th>Other names</th><th>Status</th>{canManage && <th />}</tr></thead>
        <tbody>{officers.map(o => <tr key={o.id} className={o.active ? "" : "muted"}><td>{o.code}</td><td><b>{o.name}</b></td><td>{o.phone}</td><td>{o.state}</td><td>{o.region}</td>
          <td className="wrap">{(o.aliases || []).join(", ")}</td><td>{o.active ? "working" : "left"}</td>
          {canManage && <td><button className="secondary small" onClick={() => { setEditing(o); setMsg(null); setForm({ name: o.name, phone: o.phone || "", state: o.state || "", region: o.region || "", aliases: (o.aliases || []).join(", "), active: o.active }); }}>Edit</button></td>}</tr>)}</tbody></table>
        {!officers.length && <p className="empty">No SOs yet. Add them here, or upload an SO sheet on the Inventory page and add the names it finds.</p>}</div>
    </section>

    <section className="card">
      <div className="rowhead"><h2>SO reports uploaded</h2><button className="secondary" onClick={loadReports}>Refresh</button></div>
      <p className="hint">Upload SO daily sheets on the Inventory page; they show up here.{canManage ? " Remove takes a report out of every check." : ""}</p>
      <div className="tablewrap"><table><thead><tr><th>Uploaded</th><th>File</th><th>SO(s)</th><th>Dates</th><th>Lines</th><th>Units</th>{canManage && <th />}</tr></thead>
        <tbody>{reports.map(r => <tr key={r.id}><td>{new Date(r.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</td>
          <td className="wrap">{r.source_file}</td><td className="wrap">{r.so_names}</td><td>{r.from_date}{r.to_date && r.to_date !== r.from_date ? ` to ${r.to_date}` : ""}</td>
          <td>{r.lines}</td><td>{fmt(r.units)}</td>{canManage && <td><button className="secondary small" onClick={() => undo(r)}>Remove</button></td>}</tr>)}</tbody></table>
        {!reports.length && <p className="empty">No SO reports yet.</p>}</div>
    </section>
  </>;
}
