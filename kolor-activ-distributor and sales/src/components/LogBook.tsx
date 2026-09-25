import { useEffect, useState } from "react";
import { supabase, fetchAll, errText } from "../lib/supabase";
import { useColumnFilters, Col } from "./ColumnFilter";

interface Session { id: string; user_id: string; email: string | null; started_at: string; last_seen: string; active_seconds: number; user_agent: string | null }

/** Records this sign-in, then every minute notes whether someone was actually using the app. */
export function useSessionLog(userId: string | undefined, email: string | undefined) {
  useEffect(() => {
    if (!supabase || !userId) return;
    let id = "", last = Date.now();
    const seen = () => { last = Date.now(); };
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"];
    events.forEach(e => window.addEventListener(e, seen, { passive: true }));
    supabase.from("user_sessions").insert({ email: email || null, user_agent: navigator.userAgent.slice(0, 300) }).select("id").single()
      .then(({ data }) => { id = (data as { id: string } | null)?.id || ""; });
    const t = window.setInterval(() => {
      if (!id) return;
      const active = document.visibilityState === "visible" && Date.now() - last < 60000 ? 60 : 0;
      supabase!.rpc("touch_session", { p_id: id, p_active: active }).then(() => {});
    }, 60000);
    return () => { window.clearInterval(t); events.forEach(e => window.removeEventListener(e, seen)); };
  }, [userId]);
}

const dur = (s: number) => (s < 60 ? `${Math.round(s)} sec` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);
const device = (ua: string | null) => {
  const u = ua || "";
  const os = /Android/i.test(u) ? "Android" : /iPhone|iPad/i.test(u) ? "iPhone / iPad" : /Windows/i.test(u) ? "Windows" : /Mac OS/i.test(u) ? "Mac" : /Linux/i.test(u) ? "Linux" : "Other";
  const br = /Edg\//.test(u) ? "Edge" : /Chrome\//.test(u) ? "Chrome" : /Firefox\//.test(u) ? "Firefox" : /Safari\//.test(u) ? "Safari" : "Browser";
  return `${br} on ${os}`;
};

/** Who signed in, when, for how long, and how much of that time they were actually using the app. */
export default function LogBook() {
  const [rows, setRows] = useState<Session[] | null>(null), [err, setErr] = useState("");
  useEffect(() => {
    if (!supabase) return;
    fetchAll<Session>((a, b) => supabase!.from("user_sessions").select("*").order("started_at", { ascending: false }).order("id").range(a, b))
      .then(r => setRows(r.slice(0, 3000))).catch(e => setErr(`Couldn't load the log book: ${errText(e)}. Run the latest database step (010) in Supabase.`));
  }, []);
  const len = (s: Session) => Math.max(0, (Date.parse(s.last_seen) - Date.parse(s.started_at)) / 1000);
  const cols: Col<Session>[] = [
    { key: "who", label: "User", value: s => s.email }, { key: "day", label: "Date", value: s => s.started_at.slice(0, 10) },
    { key: "start", label: "Signed In", value: s => new Date(s.started_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) },
    { key: "end", label: "Last Seen", value: s => new Date(s.last_seen).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" }) },
    { key: "len", label: "Open For", value: s => Math.round(len(s) / 60), num: true },
    { key: "active", label: "Actively Used", value: s => Math.round(s.active_seconds / 60), num: true },
    { key: "share", label: "Active %", value: s => (len(s) > 60 ? Math.min(100, Math.round((s.active_seconds / len(s)) * 100)) : null), num: true },
    { key: "device", label: "Device", value: s => device(s.user_agent) },
  ];
  const t = useColumnFilters(rows || [], cols);
  return <section className="card">
    <div className="rowhead"><h2>Log Book</h2>{t.active > 0 && <button className="link" onClick={t.clear}>Clear Filters</button>}</div>
    <p className="hint">Every sign-in, how long the app stayed open, and how much of that time someone was clicking, typing or scrolling in it. A low active share means the app was left open in the background.</p>
    {err && <div className="status err">{err}</div>}
    {rows && (rows.length ? <div className="tablewrap"><table><thead><tr>{cols.map(c => t.head(c.key))}</tr></thead>
      <tbody>{t.rows.map(s => { const share = cols[6].value(s) as number | null; return <tr key={s.id} className={share !== null && share < 20 ? "flagged" : ""}>
        <td>{s.email}</td><td>{s.started_at.slice(0, 10)}</td><td>{cols[2].value(s)}</td><td>{cols[3].value(s)}</td><td>{dur(len(s))}</td><td>{dur(s.active_seconds)}</td>
        <td>{share === null ? "—" : `${share}%`}</td><td>{device(s.user_agent)}</td></tr>; })}</tbody></table></div>
      : <p className="empty">No sign-ins recorded yet.</p>)}
  </section>;
}
