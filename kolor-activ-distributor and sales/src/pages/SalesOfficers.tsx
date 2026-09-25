import { useEffect, useState } from "react";
import { supabase, SalesOfficer, fmt, errText } from "../lib/supabase";

interface Report { id: string; created_at: string; source_file: string | null; lines: number; units: number; from_date: string | null; to_date: string | null; so_names: string | null }

/** SO sales sheets uploaded on the Inventory page (with undo). The staff list itself is on the SO Reports page. */
export default function SalesOfficers({ officers, canManage, onChanged, notify }: { officers: SalesOfficer[]; canManage: boolean; onChanged: () => Promise<void>; notify: (m: string) => void }) {
  const [reports, setReports] = useState<Report[]>([]);
  async function loadReports() {
    if (!supabase) return;
    const { data, error } = await supabase.from("so_report_summary").select("*").order("created_at", { ascending: false }).limit(100);
    if (!error) setReports(data as Report[]);
  }
  useEffect(() => { loadReports(); }, [officers]);
  async function undo(r: Report) {
    if (!supabase || !confirm(`Remove this SO report (${r.lines} lines from ${r.source_file || "manual entry"})?`)) return;
    const { error } = await supabase.rpc("delete_so_report", { p_report: r.id });
    if (error) return notify(`Undo failed: ${errText(error)}`);
    notify("SO report removed."); await loadReports(); await onChanged();
  }
  return <section className="card">
    <div className="rowhead"><h2>SO Sales Sheets Uploaded</h2><button className="secondary" onClick={loadReports}>Refresh</button></div>
    <p className="hint">SO sheets uploaded on the Inventory page, used for the checks above.{canManage ? " Remove takes a sheet out of every check." : ""} The sales team list is on the SO Reports page.</p>
    <div className="tablewrap"><table><thead><tr><th>Uploaded</th><th>File</th><th>SO(s)</th><th>Dates</th><th>Lines</th><th>Units</th>{canManage && <th />}</tr></thead>
      <tbody>{reports.map(r => <tr key={r.id}><td>{new Date(r.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</td>
        <td className="wrap">{r.source_file}</td><td className="wrap">{r.so_names}</td><td>{r.from_date}{r.to_date && r.to_date !== r.from_date ? ` to ${r.to_date}` : ""}</td>
        <td>{r.lines}</td><td>{fmt(r.units)}</td>{canManage && <td><button className="secondary small" onClick={() => undo(r)}>Remove</button></td>}</tr>)}</tbody></table>
      {!reports.length && <p className="empty">No SO sheets uploaded yet.</p>}</div>
  </section>;
}
