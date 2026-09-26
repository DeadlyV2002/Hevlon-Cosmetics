import { Select, Combo } from "./Select";
import { useState } from "react";
import { supabase, Distributor, Kind, KIND_LABEL, SalesOfficer, nextCode, missingFields, validPhone, validEmail, cleanPhones, proper, properOrNull, errText } from "../lib/supabase";
import { STATES, normalizeState } from "../lib/india";
import { normName } from "../lib/parse";

type Form = { code: string; name: string; company_name: string; owner_name: string; parent_id: string; state: string; region: string; territory: string; phone: string; aliases: string; email: string; so_id: string };
const toForm = (d?: Distributor | null, name = ""): Form => ({
  code: d?.code || "", name: d?.name || name, company_name: d?.company_name || "", owner_name: d?.owner_name || "", parent_id: d?.parent_id || "",
  state: d?.state || "", region: d?.region || "", territory: d?.territory || "", phone: d?.phone || "", aliases: (d?.aliases || []).join(", "), email: d?.email || "", so_id: d?.so_id || "",
});
export const splitAliases = (s: string) => s.split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
const uniq = (xs: (string | null)[]) => [...new Set(xs.map(x => (x || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

interface Props {
  kind: Kind;
  /** The record being edited; leave out to add a new one. The parent should key this form by the record's id. */
  editing?: Distributor | null;
  prefillName?: string;
  /** Other details to start with, such as the town and SO read from an uploaded sheet. */
  prefill?: Partial<Form>;
  locations: Distributor[];
  officers?: SalesOfficer[];
  onSaved: (d: Distributor, isNew: boolean) => void | Promise<void>;
  onCancel?: () => void;
}

export default function LocationForm({ kind, editing, prefillName, prefill, locations, officers = [], onSaved, onCancel }: Props) {
  const [form, setForm] = useState<Form>(() => ({ ...toForm(editing, prefillName), ...(editing ? {} : Object.fromEntries(Object.entries(prefill || {}).filter(([, v]) => v))) }));
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const supers = locations.filter(l => l.kind === "SUPER_STOCKIST").sort((a, b) => `${a.state} ${a.name}`.localeCompare(`${b.state} ${b.name}`));
  const regions = uniq(locations.filter(l => !form.state || l.state === form.state).map(l => l.region));
  const noun = KIND_LABEL[kind].toLowerCase();
  const f = (k: keyof Form) => ({ value: form[k], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value }) });

  /** A super stockist fits the chosen state and region if it sits there or already supplies a distributor there. */
  const fitsArea = (x?: Distributor) => !!x && (!form.state || x.state === form.state) && (!form.region.trim() || (x.region || "").toLowerCase() === form.region.trim().toLowerCase());
  const servesArea = (s: Distributor) => (!form.state && !form.region.trim()) || fitsArea(s) || locations.some(x => x.parent_id === s.id && fitsArea(x)) || s.id === form.parent_id;
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
      kind, name: proper(form.name), company_name: properOrNull(form.company_name), owner_name: properOrNull(form.owner_name),
      parent_id: kind === "DISTRIBUTOR" ? form.parent_id || null : null, super_stockist: kind === "DISTRIBUTOR" ? ss?.name || null : null,
      state: normalizeState(form.state) || null, region: properOrNull(form.region), territory: properOrNull(form.territory), phone: t(cleanPhones(form.phone)), aliases: splitAliases(form.aliases),
      email: t(form.email.toLowerCase()), ...(kind === "DISTRIBUTOR" ? { so_id: form.so_id || null } : {}),
    };
    const missing = missingFields(payload);
    if (missing.length) return setMsg({ kind: "err", text: `Fill in: ${missing.join(", ")}.` });
    if (payload.phone && !validPhone(payload.phone)) return setMsg({ kind: "err", text: "Each phone number needs 8 to 13 digits. Separate two numbers with a comma." });
    if (payload.email && !validEmail(payload.email)) return setMsg({ kind: "err", text: "The email address doesn't look right." });
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
        <Select value={form.parent_id} onChange={e => pickSuper(e.target.value)}>
          <option value="">{supers.length ? "Choose…" : "Add super stockists first"}</option>
          {supers.map(s => <option key={s.id} value={s.id} disabled={!servesArea(s)}>{s.name}{s.state ? ` · ${s.state}` : ""}</option>)}
        </Select></label>}
      <label>State *<Select {...f("state")}>
        <option value="">Choose…</option>
        {form.state && !STATES.includes(form.state) && <option value={form.state}>{form.state}</option>}
        {STATES.map(s => <option key={s} value={s}>{s}</option>)}</Select></label>
      <label>Region{kind === "DISTRIBUTOR" ? " *" : ""}<Combo {...f("region")} options={regions.map(r => ({ value: r }))} /></label>
      <label>City / area *<input {...f("territory")} /></label>
      <label>Phone{kind === "GODOWN" ? "" : " *"} <small>a second number is optional; add it after a comma</small><input {...f("phone")} inputMode="tel" /></label>
      <label>Email <small>for stock reminders</small><input {...f("email")} type="email" /></label>
      {kind === "DISTRIBUTOR" && <label>SO / ASE<Select value={form.so_id} onChange={e => setForm({ ...form, so_id: e.target.value })}>
        <option value="">None</option>{officers.map(o => <option key={o.id} value={o.id}>{o.name}{o.state ? ` · ${o.state}` : ""}</option>)}</Select></label>}
      <label>Code<input {...f("code")} placeholder={editing ? "" : `${nextCode(kind, locations)} (automatic)`} /></label>
      <label className="wide">Other names in their files <small>(optional, comma-separated: other spellings on their Tally reports or sheets)</small>
        <input {...f("aliases")} /></label>
    </div>
    <div className="actions">
      {onCancel && <button className="secondary" onClick={onCancel}>Cancel</button>}
      <button onClick={save} disabled={busy}>{busy ? "Saving…" : editing ? "Save changes" : `Add ${noun}`}</button>
    </div>
    <div className="reserve">{msg && <span className={`status inline-status ${msg.kind}`}>{msg.text}</span>}</div>
  </div>;
}
