import { dismissTask, useTasks } from "../lib/tasks";
import { fmt } from "../lib/supabase";

/** Every long job, with its progress, in the corner of the screen on every page. */
export default function Tasks() {
  const tasks = useTasks();
  if (!tasks.length) return null;
  return <div className="tasks" aria-live="polite">{tasks.map(t => {
    const pct = t.total > 0 ? Math.min(100, (t.done / t.total) * 100) : null;
    return <div key={t.id} className={`task ${t.state}`}>
      <div className="task-top"><b>{t.state === "ok" ? "✓ " : t.state === "err" ? "⚠ " : ""}{t.label}</b>
        <span>{t.state === "run" ? (pct === null ? "Working…" : `${fmt(t.done)} of ${fmt(t.total)}`) : t.state === "ok" ? "Finished" : "Stopped"}</span>
        {t.state !== "run" && <button className="x" aria-label="Close" onClick={() => dismissTask(t.id)}>✕</button>}</div>
      <div className={`task-bar${pct === null && t.state === "run" ? " endless" : ""}`}><i style={{ width: `${pct === null ? (t.state === "run" ? 35 : 100) : pct}%` }} /></div>
      {t.note && <small>{t.note}</small>}
    </div>;
  })}</div>;
}
