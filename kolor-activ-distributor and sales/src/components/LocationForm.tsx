import { useState } from "react";
import { supabase, Distributor, Kind, KIND_LABEL, nextCode, missingFields, validPhone, errText } from "../lib/supabase";
import { STATES, normalizeState } from "../lib/india";
import { normName } from "../lib/parse";

type Form = { code: string; name: string; company_name: string; owner_name: string; parent_id: string; state: string; region: string; territory: string; phone: string; aliases: string };
const toForm = (d?: Distributor | null, name = ""): Form => ({
  code: d?.code || "", name: d?.name || name, company_name: d?.company_name || "", owner_name: d?.owner_name || "", parent_id: d?.parent_id || "",
  state: d?.state || "", region: d?.region || "", territory: d?.territory || "", phone: d?.phone || "", aliases: (d?.aliases || []).join(", "),
});
export const splitAliases = (s: string) => s.split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
const uniq = (xs: (string | null)[]) => [...new Set(xs.map(x => (x || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

interface Props {
  kind: Kind;
  /** The record being edited; leave out to add a new one. The parent should key this form by the record's id. */
  editing?: Distributor | null;
  prefillName?: string;
  locations: Distributor[];
  onSaved: (d: Distributor, isNew: boolean) => void | Promise<void>;
  onCancel?: () => void;
}

export default function LocationForm({ kind, editing, prefillName, locations, onSaved, onCancel }: Props) {
  const [form, setForm] = useState<Form>(() => toForm(editing, prefillName));
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const supers = locations.filter(l => l.kind === "SUPER_STOCKIST").sort((a, b) => `${a.state} ${a.name}`.localeCompare(`${b.state} ${b.name}`));
  const regions = uniq(locations.filter(l => !form.state || l.state === form.state).map(l => l.region));
  const noun = KIND_LABEL[kind].toLowerCase();
  const f = (k: keyof Form) => ({ value: form[k], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value }) });

  function pickSuper(id: string) {
    const ss = supers.find(s => s.id === id);
    // A new distributor usually sits in its super stockist's state and region.
    setForm({ ...form, parent_id: id, state: form.state || ss?.state || "", region: form.region || ss?.region || "" });
  }

  async function save() {
    if (!supabase) return;
    const t = (s: string) => s.trim() || null;
    const ss = supers.find(s => s.id === form.parent_id);
    const payload = {
      kind, name: form.name.trim(), company_name: t(form.company_name), owner_name: t(form.owner_name),
      parent_id: kind === "DISTRIBUTOR" ? form.parent_id || null : null, super_stockist: kind === "DISTRIBUTOR" ? ss?.name || null : null,
      state: normalizeState(form.state) || null, region: t(form.region), territory: t(form.territory), phone: t(form.phone), aliases: splitAliases(form.aliases),
    };
    const missing = missingFields(payload);
    if (missing.length) return setMsg({ kind: "err", text: `Fill in: ${missing.join(", ")}.` });
    if (payload.phone && !validPhone(payload.phone)) return setMsg({ kind: "err", text: "The phone number needs 8 to 13 digits." });
    const code = (form.code.trim() || editing?.code || nextCode(kind, locations)).toUpperCase();
    const clash = locations.find(d => d.id !== editing?.id && (d.code.toUpperCase() === code || normName(d.name) === normName(payload.name)));
    if (clash) return setMsg({ kind: "err", text: `"${clash.name}" (${clash.code}) already has that code or name.` });
    setBusy(true);
    const { data, error } = editing
      ? await supabase.from("distributors").update({ ...payload, code }).eq("id", editing.id).select().single()
      : await supabase.from("distributors").insert({ ...payload, code }).select().single();
    setBusy(false);
    if (error) return setMsg({ kind: "err", text: error.code === "42501" ? "Only HO admins and state managers can add or edit these." : `Save failed: ${errText(error)}` });
    setMsg({ kind: "ok", text: editing ? `Updated ${payload.name}.` : `Added ${payload.name} as ${code}.` });
    if (!editing) setForm(toForm(null));
    await onSaved(data as Distributor, !editing);
  }

  return <div className="locform">
    <div className="formgrid">
      <label>{KIND_LABEL[kind]} name *<input {...f("name")} /></label>
      <label>{kind === "GODOWN" ? "Company (your Tally company name) *" : "Company name *"}<input {...f("company_name")} /></label>
      {kind !== "GODOWN" && <label>Owner name *<input {...f("owner_name")} /></label>}
      {kind === "DISTRIBUTOR" && <label>Super stockist *
        <select value={form.parent_id} onChange={e => pickSuper(e.target.value)}>
          <option value="">{supers.length ? "Choose…" : "Add super stockists first"}</option>
          {supers.map(s => <option key={s.id} value={s.id}>{s.name}{s.state ? ` · ${s.state}` : ""}</option>)}
        </select></label>}
      <label>State *<select {...f("state")}>
        <option value="">Choose…</option>
        {form.state && !STATES.includes(form.state) && <option value={form.state}>{form.state}</option>}
        {STATES.map(s => <option key={s} value={s}>{s}</option>)}</select></label>
      <label>Region{kind === "DISTRIBUTOR" ? " *" : ""}<input {...f("region")} list={`regions-${kind}`} />
        <datalist id={`regions-${kind}`}>{regions.map(r => <option key={r} value={r} />)}</datalist></label>
      <label>City / area *<input {...f("territory")} /></label>
      <label>Phone{kind === "GODOWN" ? "" : " *"}<input {...f("phone")} inputMode="tel" /></label>
      <label>Code<input {...f("code")} placeholder={editing ? "" : `${nextCode(kind, locations)} (automatic)`} /></label>
      <label className="wide">Other names in their files <small>(optional, comma-separated: other spellings on their Tally reports or sheets)</small>
        <input {...f("aliases")} /></label>
    </div>
    <div className="actions">
      {onCancel && <button className="secondary" onClick={onCancel}>Cancel</button>}
      <button onClick={save} disabled={busy}>{busy ? "Saving…" : editing ? "Save changes" : `Add ${noun}`}</button>
      {msg && <span className={`status inline-status ${msg.kind}`}>{msg.text}</span>}
    </div>
  </div>;
}
