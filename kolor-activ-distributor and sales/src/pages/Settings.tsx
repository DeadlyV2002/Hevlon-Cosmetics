import { useState } from "react";
import { supabase, Role, plural, errText } from "../lib/supabase";

const ROLE_LABEL: Record<Role, string> = { HO_ADMIN: "HO admin", STATE_MANAGER: "State manager", DISTRIBUTOR_MANAGER: "Distributor manager", SALESMAN: "Salesman" };

interface Props { role: Role | null; testingMode: boolean; onTestingMode: (on: boolean) => void; onChanged: () => Promise<void>; notify: (m: string) => void }

export default function Settings({ role, testingMode, onTestingMode, onChanged, notify }: Props) {
  const admin = role === "HO_ADMIN", manager = admin || role === "STATE_MANAGER";
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const say = (kind: "ok" | "err", text: string) => { setMsg({ kind, text }); notify(text); };

  async function setTesting(on: boolean) {
    if (!supabase) return;
    if (!on && !confirm("Turn testing mode off? Clearing all data won't be possible until an HO admin turns it back on.")) return;
    setBusy("mode");
    const { error } = await supabase.from("app_settings").upsert({ key: "testing_mode", value: on, updated_at: new Date().toISOString() });
    setBusy("");
    if (error) return say("err", `Couldn't change testing mode: ${error.message}`);
    onTestingMode(on);
    say("ok", on ? "Testing mode is on." : "Testing mode is off. The app is treated as live.");
  }
  async function clearAll() {
    if (!supabase || word !== "DELETE") return;
    if (!confirm("Delete every godown, super stockist, distributor, retailer, product, posting, SO and SO report? Logins stay.")) return;
    setBusy("clear");
    const { data, error } = await supabase.rpc("clear_all_data", { p_confirm: word });
    setBusy(""); setWord("");
    if (error) return say("err", `Nothing was cleared: ${errText(error)}`);
    const r = data as { deleted_locations: number; deleted_lines: number };
    say("ok", `Cleared all data: ${plural(r.deleted_locations, "location")} and ${plural(r.deleted_lines, "stock line")}. You can start fresh.`);
    await onChanged();
  }
  async function unusedProducts() {
    if (!supabase) return;
    setBusy("products");
    const { data, error } = await supabase.rpc("delete_unused_products");
    setBusy("");
    if (error) return say("err", `Couldn't delete products: ${errText(error)}`);
    say("ok", data ? `Deleted ${plural(Number(data), "product")} that no stock line or SO report used.` : "Every product is still in use; nothing was deleted.");
    await onChanged();
  }

  return <>
    {msg && <div className={`status ${msg.kind}`}>{msg.text}</div>}
    <section className="card"><h2>Team &amp; access</h2>
      <p>Your role: <b>{role ? ROLE_LABEL[role] : "unknown"}</b>. HO admins and state managers can add, edit and delete godowns, super stockists, distributors, retailers and SOs, move stock, and undo postings. Everyone signed in can upload stock and SO reports.</p>
      <ol><li>Supabase → Authentication → Users → <b>Add user</b> → Create new user (tick “Auto Confirm User”).</li>
        <li>Set their role in the <code>profiles</code> table (HO_ADMIN, STATE_MANAGER, DISTRIBUTOR_MANAGER or SALESMAN).</li></ol>
    </section>

    <section className={`card${testingMode ? " testing" : ""}`}>
      <div className="rowhead"><h2>Testing mode</h2><span className={`pill ${testingMode ? "count" : "input"}`}>{testingMode ? "on" : "off: live"}</span></div>
      <p>While testing mode is on, HO admins can wipe all data here and start again. Turn it off once you start entering real data; deleting single distributors, postings and SO reports keeps working either way.</p>
      {admin ? <button className={testingMode ? "secondary" : ""} disabled={busy === "mode"} onClick={() => setTesting(!testingMode)}>{testingMode ? "Turn testing mode off" : "Turn testing mode on"}</button>
        : <p className="hint">Only HO admins can change this.</p>}
    </section>

    {admin && testingMode && <section className="card danger-zone">
      <h2>Clear all data</h2>
      <p>Deletes every godown, super stockist, distributor, retailer, product, stock posting, SO and SO report. Logins, roles and dashboards stay. This can't be undone.</p>
      <div className="actions wrap"><label className="inline">Type DELETE to confirm <input value={word} onChange={e => setWord(e.target.value)} aria-label="Type DELETE to confirm" /></label>
        <button className="danger" disabled={word !== "DELETE" || busy === "clear"} onClick={clearAll}>{busy === "clear" ? "Clearing…" : "Clear all data"}</button></div>
    </section>}

    {manager && <section className="card">
      <h2>Unused products</h2>
      <p>Products stay in the list after the postings that created them are undone or their distributor is deleted. This removes the ones no stock line or SO report uses.</p>
      <button className="secondary" disabled={busy === "products"} onClick={unusedProducts}>{busy === "products" ? "Deleting…" : "Delete unused products"}</button>
    </section>}
  </>;
}
