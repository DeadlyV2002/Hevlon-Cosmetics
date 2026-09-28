import { useEffect, useRef, useState } from "react";
import { Alert, Ctx, loadAlerts } from "../lib/insights";
import { usePlace } from "./Select";

/** The bell in the header: things that need a look, worked out whenever the data changes. */
export default function AlertsBell({ ctx, version, onPick }: { ctx: Ctx; version: number; onPick: (a: Alert) => void }) {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null), btn = useRef<HTMLButtonElement>(null);
  // Placed inside the window whatever its size (in a split screen the bell can sit on the left).
  const pos = usePlace(btn, open, 12, 520, 320);
  useEffect(() => {
    if (!version) return;
    let live = true;
    loadAlerts(ctx).then(a => { if (live) setAlerts(a); }).catch(() => { if (live) setAlerts([]); });
    return () => { live = false; };
  }, [version]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const high = alerts?.filter(a => a.level === "high").length || 0;
  const n = alerts?.length || 0;
  return <div className="bell" ref={ref}>
    <button ref={btn} className={`secondary bellbtn${high ? " high" : n ? " some" : ""}`} aria-expanded={open} onClick={() => setOpen(o => !o)}
      aria-label={alerts === null ? "Checking for alerts" : `${n} alerts${high ? `, ${high} urgent` : ""}`}>
      <span aria-hidden>🔔</span>{n > 0 && <span className="bellcount">{n}</span>}
    </button>
    {open && pos.left !== undefined && <div className="bellpanel" style={{ ...pos, width: Math.min(420, window.innerWidth - 16), left: Math.max(8, Math.min(Number(pos.left) + Number(pos.width) - Math.min(420, window.innerWidth - 16), window.innerWidth - Math.min(420, window.innerWidth - 16) - 8)) }} role="dialog" aria-label="Alerts">
      <div className="rowhead"><b>Needs a look</b><small className="muted">{alerts === null ? "checking…" : n ? `${n} alert${n === 1 ? "" : "s"}` : "all clear"}</small></div>
      {alerts !== null && !n && <p className="empty">Nothing unusual in your data right now.</p>}
      <ul>{alerts?.map(a => <li key={a.id}>
        <button className="alertrow" onClick={() => { setOpen(false); onPick(a); }}>
          <span className={`sev ${a.level}`} aria-label={a.level === "high" ? "Urgent" : "Worth a look"}>{a.level === "high" ? "▲" : "●"}</span>
          <span>{a.text}</span>
        </button></li>)}</ul>
    </div>}
  </div>;
}
