import { useSyncExternalStore } from "react";

/** A long job the app is working on, shown with a progress bar in the corner until it ends. */
export interface Task { id: number; label: string; done: number; total: number; state: "run" | "ok" | "err"; note: string }
export interface TaskHandle { step: (done: number, total?: number, note?: string) => void; ok: (note?: string) => void; fail: (note: string) => void; cancel: () => void }

let tasks: Task[] = [], next = 1;
const subs = new Set<() => void>();
const emit = () => { subs.forEach(f => f()); title(); };
const set = (id: number, p: Partial<Task>) => { tasks = tasks.map(t => (t.id === id ? { ...t, ...p } : t)); emit(); };
export const dismissTask = (id: number) => { tasks = tasks.filter(t => t.id !== id); emit(); };

/** The browser tab shows how far the running jobs have got, so progress is visible from another tab. */
const base = typeof document !== "undefined" ? document.title : "";
function title() {
  const run = tasks.filter(t => t.state === "run");
  const pct = run.filter(t => t.total > 0).map(t => Math.floor((t.done / t.total) * 100));
  document.title = run.length ? `(${pct.length ? `${Math.min(...pct)}%` : "working"}) ${base}` : base;
}
/** A desktop notification when a job ends while the app isn't in front (only if the browser allows it). */
function tell(label: string, body: string) {
  try { if (document.hidden && "Notification" in window && Notification.permission === "granted") new Notification(label, { body }); } catch { /* notifications blocked */ }
}

/** Starts a job. total 0 means "no count known": the bar runs without a percentage.
 *  quiet: a routine load, shown only if it takes longer than a second, and not announced when it ends quickly. */
export function startTask(label: string, total = 0, quiet = false): TaskHandle {
  const id = next++;
  let ended = false, shown = !quiet, state: Task = { id, label, done: 0, total, state: "run", note: "" };
  const show = () => { if (shown) return; shown = true; tasks = [...tasks, state]; emit(); };
  const upd = (p: Partial<Task>) => { state = { ...state, ...p }; if (shown) set(id, p); };
  if (quiet) window.setTimeout(() => { if (!ended) show(); }, 1000);
  else {
    tasks = [...tasks, state]; emit();
    try { if ("Notification" in window && Notification.permission === "default") Notification.requestPermission(); } catch { /* not supported */ }
  }
  return {
    step: (done, total, note) => { if (!ended) upd({ done, ...(total !== undefined ? { total } : {}), ...(note !== undefined ? { note } : {}) }); },
    ok: note => { if (ended) return; ended = true; if (!shown) return; upd({ state: "ok", done: state.total || 1, total: state.total || 1, note: note ?? "Done." }); if (!quiet) tell(label, note ?? "Done."); window.setTimeout(() => dismissTask(id), quiet ? 3000 : 8000); },
    fail: note => { if (ended) return; ended = true; show(); upd({ state: "err", note }); tell(label, note); },
    cancel: () => { if (ended) return; ended = true; if (shown) dismissTask(id); },
  };
}

/** Runs fn as a job; the job ends with fn's result or its error. */
export async function runTask<T>(label: string, fn: (t: TaskHandle) => Promise<T>, total = 0, done?: (r: T) => string): Promise<T> {
  const t = startTask(label, total);
  try { const r = await fn(t); t.ok(done ? done(r) : undefined); return r; }
  catch (e) { t.fail(e instanceof Error ? e.message : String((e as { message?: string })?.message || e)); throw e; }
}

/** Lets the page breathe between chunks of work so it never freezes. */
export const breathe = () => new Promise<void>(r => window.setTimeout(r, 0));

export function useTasks() {
  return useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f); }; }, () => tasks);
}
