// Questions asked inside the page instead of the browser's confirm()/prompt() pop-ups, which some
// windows (embedded browsers, some phones) block or answer "no" to without showing anything.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Req { kind: "confirm" | "text"; message: string; ok: string; danger: boolean; placeholder: string; resolve: (v: any) => void }
type Opts = { ok?: string; danger?: boolean; placeholder?: string };
let push: ((r: Req) => void) | null = null;

/** Yes/no question. Resolves true when the user presses the OK button. */
export const ask = (message: string, o: Opts = {}) =>
  new Promise<boolean>(resolve => (push ? push({ kind: "confirm", message, ok: o.ok || "OK", danger: !!o.danger, placeholder: "", resolve }) : resolve(window.confirm(message))));
/** Asks for a line of text. Resolves null when cancelled. */
export const askText = (message: string, o: Opts = {}) =>
  new Promise<string | null>(resolve => (push ? push({ kind: "text", message, ok: o.ok || "OK", danger: false, placeholder: o.placeholder || "", resolve }) : resolve(window.prompt(message))));

/** Mount once near the top of the app. */
export function AskHost() {
  const [queue, setQueue] = useState<Req[]>([]);
  const [text, setText] = useState("");
  const okRef = useRef<HTMLButtonElement>(null), inRef = useRef<HTMLInputElement>(null);
  useEffect(() => { push = r => setQueue(q => [...q, r]); return () => { push = null; }; }, []);
  const cur = queue[0];
  useEffect(() => { if (cur) { setText(""); setTimeout(() => (cur.kind === "text" ? inRef.current : okRef.current)?.focus(), 0); } }, [cur]);
  if (!cur) return null;
  const done = (v: boolean) => { cur.resolve(cur.kind === "text" ? (v ? text : null) : v); setQueue(q => q.slice(1)); };
  return createPortal(<div className="overlay askroot" onClick={e => { if (e.target === e.currentTarget) done(false); }}
    onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); done(false); } }}>
    <div className="overlaypanel dialog ask" role="alertdialog" aria-modal="true" aria-label="Please confirm">
      <p className="askmsg">{cur.message}</p>
      {cur.kind === "text" && <input ref={inRef} value={text} placeholder={cur.placeholder} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && text.trim()) done(true); }} />}
      <div className="actions askbtns">
        <button className="secondary" onClick={() => done(false)}>Cancel</button>
        <button ref={okRef} className={cur.danger ? "danger" : ""} disabled={cur.kind === "text" && !text.trim()} onClick={() => done(true)}>{cur.ok}</button>
      </div>
    </div>
  </div>, document.body);
}
