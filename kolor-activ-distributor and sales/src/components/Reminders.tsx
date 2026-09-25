import { useEffect, useState } from "react";
import { supabase, plural, errText } from "../lib/supabase";

interface Cfg { enabled: boolean; send_day: number; due_day: number; every: number; max_follow_ups: number; email: boolean; whatsapp: boolean; super_stockists: boolean; wa_template: string; wa_language: string }
const DEFAULT: Cfg = { enabled: false, send_day: 1, due_day: 7, every: 3, max_follow_ups: 3, email: true, whatsapp: true, super_stockists: true, wa_template: "stock_update_reminder", wa_language: "en" };
interface Status { location_id: string; code: string; name: string; kind: string; email: string | null; phone: string | null; received_on: string | null; first_sent: string | null; follow_ups: number; last_sent: string | null; last_error: string | null }

const lastMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`; };
const monthName = (p: string) => new Date(`${p}T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
const day = (t: string | null) => (t ? new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "");

/** Monthly stock-update reminders to distributors and super stockists, by email and WhatsApp. */
export default function Reminders({ canEdit }: { canEdit: boolean }) {
  const [cfg, setCfg] = useState<Cfg>(DEFAULT), [saved, setSaved] = useState<Cfg>(DEFAULT);
  const [rows, setRows] = useState<Status[] | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(""), [only, setOnly] = useState<"pending" | "all">("pending");
  const period = lastMonth();

  async function load() {
    if (!supabase) return;
    const [s, st] = await Promise.all([
      supabase.from("app_settings").select("value").eq("key", "reminders").maybeSingle(),
      supabase.rpc("reminder_status", { p_period: period }),
    ]);
    const c = { ...DEFAULT, ...((s.data?.value as Partial<Cfg>) || {}) };
    setCfg(c); setSaved(c);
    if (st.error) setMsg({ kind: "err", text: `Couldn't load reminder status: ${st.error.message}. Run the latest database step (008) in Supabase.` });
    else setRows(st.data as Status[]);
  }
  useEffect(() => { load(); }, []);

  const num = (k: keyof Cfg, lo: number, hi: number) => ({ type: "number", min: lo, max: hi, value: cfg[k] as number, disabled: !canEdit,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setCfg({ ...cfg, [k]: Math.min(hi, Math.max(lo, Number(e.target.value) || lo)) }) });
  const tick = (k: keyof Cfg) => ({ type: "checkbox", checked: cfg[k] as boolean, disabled: !canEdit, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setCfg({ ...cfg, [k]: e.target.checked }) });
  const dirty = JSON.stringify(cfg) !== JSON.stringify(saved);
  const problem = cfg.due_day < cfg.send_day ? "The due day comes before the send day." : !cfg.email && !cfg.whatsapp ? "Pick email, WhatsApp or both." : "";

  async function save() {
    if (!supabase || problem) return;
    setBusy("save");
    const { error } = await supabase.from("app_settings").upsert({ key: "reminders", value: cfg, updated_at: new Date().toISOString() });
    setBusy("");
    if (error) return setMsg({ kind: "err", text: `Not saved: ${error.message}` });
    setSaved(cfg);
    setMsg({ kind: "ok", text: cfg.enabled ? `Reminders are on. The first goes out on day ${cfg.send_day} of each month, with follow-ups every ${cfg.every} days after day ${cfg.due_day}.` : "Reminders are off." });
    load();
  }
  async function sendNow() {
    if (!supabase) return;
    setBusy("send");
    const { data, error } = await supabase.functions.invoke("stock-reminders", { body: {} });
    setBusy("");
    if (error) return setMsg({ kind: "err", text: `Couldn't run the reminder sender: ${errText(error)}. Check it's set up (DEPLOY-STEPS.md, step 1.3g).` });
    const r = data as { sent: number; failed: number; locations: number; note?: string };
    setMsg({ kind: r.failed ? "err" : "ok", text: r.note || (r.locations ? `Sent ${plural(r.sent, "message")} to ${plural(r.locations, "location")}${r.failed ? `; ${plural(r.failed, "message")} failed (see the table)` : ""}.` : "Nobody is due a reminder today.") });
    load();
  }

  const list = (rows || []).filter(r => only === "all" || !r.received_on);
  const received = (rows || []).filter(r => r.received_on).length;
  const noContact = (rows || []).filter(r => !r.email && !r.phone).length;
  return <section className="card">
    <div className="rowhead"><h2>Monthly stock reminders</h2><span className={`pill ${saved.enabled ? "input" : ""}`}>{saved.enabled ? "on" : "off"}</span></div>
    <p>Each month the app asks every distributor{cfg.super_stockists ? " and super stockist" : ""} for last month's closing stock, by email and WhatsApp, then follows up until a file from them is posted. Any stock count or sales file posted for them after the month ends counts as received.</p>
    <div className="formgrid">
      <label>First reminder on day<input {...num("send_day", 1, 28)} /></label>
      <label>Due by day<input {...num("due_day", 1, 28)} /></label>
      <label>Follow up every (days)<input {...num("every", 1, 14)} /></label>
      <label>Follow-ups at most<input {...num("max_follow_ups", 0, 10)} /></label>
      <label>WhatsApp template name <small>approved in WhatsApp Manager</small><input value={cfg.wa_template} disabled={!canEdit} onChange={e => setCfg({ ...cfg, wa_template: e.target.value.trim() })} /></label>
      <label>Template language code<input value={cfg.wa_language} disabled={!canEdit} onChange={e => setCfg({ ...cfg, wa_language: e.target.value.trim() })} /></label>
    </div>
    <div className="actions">
      <label className="inline"><input {...tick("enabled")} /> Send reminders</label>
      <label className="inline"><input {...tick("email")} /> Email</label>
      <label className="inline"><input {...tick("whatsapp")} /> WhatsApp</label>
      <label className="inline"><input {...tick("super_stockists")} /> Include super stockists</label>
    </div>
    <p className="hint reserve">{problem}</p>
    {canEdit ? <div className="actions">
      <button disabled={!dirty || !!problem || busy === "save"} onClick={save}>{busy === "save" ? "Saving…" : "Save reminder settings"}</button>
      <button className="secondary" disabled={!saved.enabled || busy === "send"} onClick={sendNow}>{busy === "send" ? "Sending…" : "Send due reminders now"}</button>
    </div> : <p className="hint">Only HO admins and state managers can change reminders.</p>}
    <div className="reserve">{msg && <div className={`status ${msg.kind}`}>{msg.text}</div>}</div>

    <div className="rowhead"><h3>Stock for {monthName(period)}</h3>
      {rows && <div className="seg" role="group" aria-label="Show"><button className={only === "pending" ? "on" : ""} onClick={() => setOnly("pending")}>Not received ({rows.length - received})</button><button className={only === "all" ? "on" : ""} onClick={() => setOnly("all")}>All ({rows.length})</button></div>}</div>
    {rows && <p className="hint">{plural(received, "location")} of {rows.length} sent it.{noContact ? ` ${plural(noContact, "location")} ${noContact === 1 ? "has" : "have"} no email or phone and can't be reminded.` : ""}</p>}
    {!rows ? <p className="empty">Loading…</p> : list.length ? <div className="tablewrap"><table><thead><tr><th>Code</th><th>Name</th><th>Email</th><th>Phone</th><th>Received</th><th>First reminder</th><th>Follow-ups</th><th>Last problem</th></tr></thead>
      <tbody>{list.map(r => <tr key={r.location_id}><td>{r.code}</td><td>{r.name}{r.kind === "SUPER_STOCKIST" && <em className="tag">SS</em>}</td>
        <td>{r.email || <span className="muted">none</span>}</td><td className="wrap">{r.phone || <span className="muted">none</span>}</td>
        <td>{r.received_on ? <span className="ok">{day(r.received_on)}</span> : <span className="muted">not yet</span>}</td>
        <td>{day(r.first_sent)}</td><td>{r.follow_ups || ""}</td><td className="wrap">{r.last_error ? <span className="err">{r.last_error.slice(0, 120)}</span> : ""}</td></tr>)}</tbody></table></div>
      : <p className="empty">{rows.length ? "Everyone has sent it." : "No distributors yet."}</p>}
  </section>;
}
