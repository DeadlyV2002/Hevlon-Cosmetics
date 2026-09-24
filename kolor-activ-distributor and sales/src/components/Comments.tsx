import { useEffect, useState } from "react";
import { supabase, Distributor, errText } from "../lib/supabase";

interface Comment { id: string; body: string; author_id: string | null; author_email: string | null; created_at: string }

/** Notes on one location. Anyone signed in can add; authors and managers can delete. */
export default function Comments({ location, userId, canManage, onCount }: { location: Distributor; userId: string; canManage: boolean; onCount: (n: number) => void }) {
  const [list, setList] = useState<Comment[] | null>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!supabase) return;
    const { data, error } = await supabase.from("distributor_comments").select("id,body,author_id,author_email,created_at")
      .eq("distributor_id", location.id).order("created_at", { ascending: false });
    if (error) { setErr(`Could not load comments: ${error.message}`); setList([]); return; }
    setList(data as Comment[]); onCount(data.length);
  }
  useEffect(() => { load(); }, [location.id]);

  async function post() {
    if (!supabase || !text.trim()) return;
    setBusy(true); setErr("");
    const { error } = await supabase.from("distributor_comments").insert({ distributor_id: location.id, body: text.trim() });
    setBusy(false);
    if (error) return setErr(`Could not save: ${errText(error)}`);
    setText(""); await load();
  }
  async function remove(c: Comment) {
    if (!supabase || !confirm("Delete this comment?")) return;
    const { data, error } = await supabase.from("distributor_comments").delete().eq("id", c.id).select("id");
    if (error || !data?.length) return setErr(error ? `Could not delete: ${error.message}` : "Only the author or an HO admin / state manager can delete this.");
    await load();
  }

  return <div className="comments">
    <div className="commentform">
      <textarea value={text} onChange={e => setText(e.target.value)} rows={2} placeholder={`Add a comment about ${location.name}`}
        onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) post(); }} />
      <button onClick={post} disabled={busy || !text.trim()}>{busy ? "Saving…" : "Add comment"}</button>
    </div>
    {err && <p className="status err">{err}</p>}
    {list === null ? <p className="hint">Loading…</p> : !list.length ? <p className="empty">No comments yet.</p>
      : <ul className="commentlist">{list.map(c => <li key={c.id}>
        <p>{c.body}</p>
        <small>{c.author_email || "someone"} · {new Date(c.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
          {(c.author_id === userId || canManage) && <button className="link danger" onClick={() => remove(c)}>Delete</button>}</small>
      </li>)}</ul>}
  </div>;
}
