import { useMemo, useState } from "react";
import { supabase, SalesOfficer, validPhone, cleanPhones, proper, properOrNull, plural, errText } from "../lib/supabase";
import { cellText, normName } from "../lib/parse";
import { similarity } from "../lib/fuzzy";
import { normalizeState } from "../lib/india";
import { readAnyFile } from "../lib/readers";
import { findHeader } from "../lib/sheet";
import { Select, Combo } from "./Select";
import { useColumnFilters, Col } from "./ColumnFilter";
import { splitAliases } from "./LocationForm";

export const DESIGS = ["ASM", "ASE", "SO", "ISR", "SR"];
/** ASM at the top, then ASE, then SOs and in-store/sales reps. */
export const rankOf = (d?: string | null) => (d === "ASM" ? 0 : d === "ASE" ? 1 : 2);
type Form = { name: string; designation: string; manager_id: string; zone: string; hq: string; areas: string; phone: string; aliases: string; active: boolean };
const blank: Form = { name: "", designation: "SO", manager_id: "", zone: "", hq: "", areas: "", phone: "", aliases: "", active: true };
type SField = "name" | "designation" | "zone" | "hq" | "manager" | "areas" | "phone";
const S_RULES: [SField, RegExp][] = [
  ["designation", /desig|post|role|position/], ["manager", /report|manager|senior|under/], ["zone", /state|zone|territory/],
  ["hq", /^hq|head ?quarter|base/], ["areas", /area|beat|town|district|market/], ["phone", /phone|mobile|contact/], ["name", /name|employee|staff/],
];
/** Same person when every word of the shorter name is in the longer one ("Amiya Kumar" and "Amiya Kumar Mohapatra"). */
export function sameName(a: string, b: string) {
  const x = normName(a).split(" ").filter(Boolean), y = normName(b).split(" ").filter(Boolean);
  if (!x.length || !y.length) return false;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  return s.length >= 2 ? s.every(w => l.includes(w)) : s[0] === l[0] && l.length === 1;
}
const nextCode = (list: { code: string }[]) => `SO${String(Math.max(0, ...list.map(o => Number(o.code.match(/^SO(\d+)$/i)?.[1] || 0))) + 1).padStart(3, "0")}`;

/** Sales staff: who they are, their post, who they report to, and where they work. */
export default function Staff({ officers, canManage, onChanged, notify }: { officers: SalesOfficer[]; canManage: boolean; onChanged: () => Promise<void>; notify: (m: string) => void }) {
  const [editing, setEditing] = useState<SalesOfficer | null>(null);
  const [form, setForm] = useState<Form>(blank), [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null), [busy, setBusy] = useState(false);
  const byId = useMemo(() => new Map(officers.map(o => [o.id, o])), [officers]);
  const zones = useMemo(() => [...new Set(officers.map(o => o.zone || o.state || "").filter(Boolean))].sort(), [officers]);
  const seniors = officers.filter(o => o.id !== editing?.id && rankOf(o.designation) < rankOf(form.designation));

  async function save() {
    if (!supabase) return;
    const name = proper(form.name);
    if (!name) return setMsg({ kind: "err", text: "Enter the name." });
    const phone = cleanPhones(form.phone);
    if (phone && !validPhone(phone)) return setMsg({ kind: "err", text: "Each phone number needs 8 to 13 digits." });
    const clash = officers.find(o => o.id !== editing?.id && normName(o.name) === normName(name));
    if (clash) return setMsg({ kind: "err", text: `${clash.name} (${clash.code}) is already in the list.` });
    const payload = { name, designation: form.designation, manager_id: form.manager_id || null, zone: properOrNull(form.zone), state: normalizeState(form.zone) || properOrNull(form.zone),
      hq: properOrNull(form.hq), region: properOrNull(form.hq), areas: properOrNull(form.areas), phone: phone || null, aliases: splitAliases(form.aliases), active: form.active };
    setBusy(true);
    const { error } = editing ? await supabase.from("sales_officers").update(payload).eq("id", editing.id) : await supabase.from("sales_officers").insert({ ...payload, code: nextCode(officers) });
    setBusy(false);
    if (error) return setMsg({ kind: "err", text: error.code === "42501" ? "Only HO admins and state managers can change the staff list." : `Save failed: ${error.message}` });
    setMsg({ kind: "ok", text: editing ? `Updated ${name}.` : `Added ${name}.` });
    setEditing(null); setForm(blank); await onChanged();
  }

  // Staff list import: Name, Desig., State/Zone, HQ, and optionally Reports To, Areas, Phone. Several files at once.
  async function importFiles(files: File[]) {
    if (!supabase) return;
    setBusy(true); setMsg(null);
    try {
      const rows: Record<SField, string>[] = [];
      for (const f of files) {
        const g = (await readAnyFile(f)).sheets[0]?.grid || [];
        const h = findHeader(g, S_RULES, "name");
        if (!h) throw new Error(`${f.name}: no heading row with a Name column.`);
        const col = (k: SField) => h.mapping.indexOf(k);
        g.slice(h.row + 1).forEach(r => { const v = (k: SField) => (col(k) >= 0 ? cellText(r[col(k)]).trim() : ""); if (v("name")) rows.push({ name: v("name"), designation: v("designation"), zone: v("zone"), hq: v("hq"), manager: v("manager"), areas: v("areas"), phone: v("phone") }); });
      }
      let added = 0, updated = 0;
      const all = [...officers];
      for (const r of rows) {
        const name = proper(r.name);
        const old = all.find(o => normName(o.name) === normName(name) || (o.aliases || []).some(a => normName(a) === normName(name)))
          ?? all.find(o => sameName(o.name, name) && (!r.zone || !(o.zone || o.state) || [o.zone, o.state].some(z => z && (normName(z).includes(normName(r.zone)) || normName(r.zone).includes(normName(z))))));
        const desig = (r.designation.toUpperCase().match(/ASM|ASE|ISR|SR|SO/) || [old?.designation || "SO"])[0];
        const payload = { name, designation: desig, zone: properOrNull(r.zone) ?? old?.zone ?? null, state: normalizeState(r.zone) || properOrNull(r.zone) || old?.state || null,
          hq: properOrNull(r.hq) ?? old?.hq ?? null, region: properOrNull(r.hq) ?? old?.region ?? null, areas: properOrNull(r.areas) ?? old?.areas ?? null, phone: cleanPhones(r.phone) || old?.phone || null };
        if (old) {
          // Keep the longer spelling as the name and the other as an alias, so DSRs with either spelling match.
          const keep = old.name.length >= name.length ? old.name : name, other = keep === name ? old.name : name;
          const aliases = normName(other) === normName(keep) ? old.aliases || [] : [...new Set([...(old.aliases || []), other])];
          Object.assign(payload, { name: keep, aliases });
          const { error } = await supabase.from("sales_officers").update(payload).eq("id", old.id); if (error) throw error; updated++; Object.assign(old, payload); }
        else { const { data, error } = await supabase.from("sales_officers").insert({ ...payload, code: nextCode(all), aliases: [] }).select().single(); if (error) throw error; all.push(data as SalesOfficer); added++; }
      }
      // Reports-to: a named manager wins; otherwise, where a zone has exactly one ASE (or ASM), the people below report to them.
      let linked = 0;
      for (const r of rows) {
        const me = all.find(o => normName(o.name) === normName(proper(r.name)) || (o.aliases || []).some(a => normName(a) === normName(proper(r.name))));
        if (!me || me.manager_id) continue;
        const named = r.manager ? all.find(o => normName(o.name) === normName(r.manager)) : undefined;
        const zoneMates = all.filter(o => (o.zone || o.state) === (me.zone || me.state) && rankOf(o.designation) < rankOf(me.designation));
        const top = Math.max(...zoneMates.map(o => rankOf(o.designation)), -1);
        const candidates = zoneMates.filter(o => rankOf(o.designation) === top);
        const boss = named || (candidates.length === 1 ? candidates[0] : undefined);
        if (boss && boss.id !== me.id) { const { error } = await supabase.from("sales_officers").update({ manager_id: boss.id }).eq("id", me.id); if (!error) { me.manager_id = boss.id; linked++; } }
      }
      const text = `Staff list: ${plural(added, "person", "people")} added, ${plural(updated, "person", "people")} updated, ${plural(linked, "reporting line")} set.${rows.length ? "" : " No rows found."} Set any missing "reports to" by hand.`;
      setMsg({ kind: "ok", text }); notify(text); await onChanged();
    } catch (e) { setMsg({ kind: "err", text: `Import failed: ${errText(e)}` }); }
    finally { setBusy(false); }
  }

  // Two entries that look like one person (spellings differ a little): offer to merge them.
  const dupes = useMemo(() => {
    const out: [SalesOfficer, SalesOfficer][] = [];
    for (let i = 0; i < officers.length; i++) for (let j = i + 1; j < officers.length; j++) {
      const a = officers[i], b = officers[j];
      if (!(sameName(a.name, b.name) || similarity(a.name, b.name) >= 0.88)) continue;
      const za = a.zone || a.state, zb = b.zone || b.state;
      if (za && zb && !normName(za).includes(normName(zb).split(" ").pop() || "") && !normName(zb).includes(normName(za).split(" ").pop() || "")) continue;
      out.push(a.name.length >= b.name.length ? [a, b] : [b, a]);
    }
    return out;
  }, [officers]);
  async function merge(keep: SalesOfficer, drop: SalesOfficer) {
    if (!supabase || !confirm(`Merge "${drop.name}" into "${keep.name}"? Their daily reports, distributors and team move to ${keep.name}, and "${drop.name}" is kept as another spelling.`)) return;
    const { error } = await supabase.rpc("merge_staff", { p_keep: keep.id, p_drop: drop.id });
    if (error) return setMsg({ kind: "err", text: `Not merged: ${errText(error)}` });
    setMsg({ kind: "ok", text: `Merged ${drop.name} into ${keep.name}.` }); await onChanged();
  }

  const cols: Col<SalesOfficer>[] = [
    { key: "name", label: "Name", value: o => o.name }, { key: "desig", label: "Post", value: o => o.designation },
    { key: "boss", label: "Reports To", value: o => byId.get(o.manager_id || "")?.name }, { key: "zone", label: "Zone", value: o => o.zone || o.state },
    { key: "hq", label: "HQ", value: o => o.hq || o.region }, { key: "areas", label: "Areas", value: o => o.areas }, { key: "phone", label: "Phone", value: o => o.phone },
    { key: "status", label: "Status", value: o => (o.active ? "Working" : "Left") },
  ];
  const t = useColumnFilters(officers, cols);
  const f = (k: keyof Form) => ({ value: String(form[k]), onChange: (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value }) });

  return <section className="card">
    <div className="rowhead"><h2>Sales Team ({officers.length})</h2>
      <div className="actions">{canManage && <><button className="secondary" onClick={() => { setOpen(!open); setEditing(null); setForm(blank); }}>{open ? "Hide Form" : "Add Person"}</button>
        <label className="button secondary">Import Staff List<input hidden type="file" multiple accept=".xlsx,.xls,.csv,.pdf,.docx" onChange={e => { const x = [...(e.target.files || [])]; if (x.length) importFiles(x); e.target.value = ""; }} /></label></>}
        {t.active > 0 && <button className="link" onClick={t.clear}>Clear Filters</button>}</div></div>
    <p className="hint">ASMs lead, ASEs work under them, and SOs (with ISRs and SRs) work under both. The staff list import reads Name, Desig., State or Zone, HQ, and Reports To or Areas if the sheet has them.</p>
    {canManage && (open || editing) && <div className="editor">
      <div className="formgrid">
        <label>Name *<input {...f("name")} /></label>
        <label>Post<Select value={form.designation} onChange={e => setForm({ ...form, designation: e.target.value, manager_id: "" })}>{DESIGS.map(d => <option key={d}>{d}</option>)}</Select></label>
        <label>Reports to<Select value={form.manager_id} onChange={e => setForm({ ...form, manager_id: e.target.value })}>
          <option value="">Nobody</option>{seniors.map(o => <option key={o.id} value={o.id} disabled={!!form.zone && !!(o.zone || o.state) && (o.zone || o.state) !== form.zone}>{o.name} · {o.designation}{o.zone ? ` · ${o.zone}` : ""}</option>)}</Select></label>
        <label>Zone / state<Combo {...f("zone")} options={zones.map(z => ({ value: z }))} /></label>
        <label>HQ<input {...f("hq")} /></label>
        <label>Phone<input {...f("phone")} inputMode="tel" /></label>
        <label className="wide">Areas they cover <small>towns or beats, comma-separated</small><input {...f("areas")} /></label>
        <label className="wide">Other names in their sheets <small>optional</small><input {...f("aliases")} /></label>
        {editing && <label className="inline"><input type="checkbox" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })} /> Still working</label>}
      </div>
      <div className="actions">{editing && <button className="secondary" onClick={() => { setEditing(null); setForm(blank); }}>Cancel</button>}
        <button disabled={busy} onClick={save}>{editing ? "Save Changes" : "Add Person"}</button></div>
    </div>}
    <div className="reserve">{msg && <div className={`status ${msg.kind}`}>{msg.text}</div>}</div>
    {canManage && dupes.length > 0 && <div className="warn">{plural(dupes.length, "pair")} of entries look like the same person:
      <div className="duplist">{dupes.slice(0, 20).map(([a, b]) => <span key={a.id + b.id} className="chip">{b.name} → {a.name}<button className="secondary small" onClick={() => merge(a, b)}>Merge</button></span>)}</div></div>}
    <div className="tablewrap scrolltable"><table className="nice"><thead><tr>{cols.map(c => t.head(c.key))}{canManage && <th />}</tr></thead>
      <tbody>{t.rows.map(o => <tr key={o.id} className={o.active ? "" : "muted"}>{cols.map(c => <td key={c.key} className={c.key === "areas" ? "wrap" : ""}>{c.key === "name" ? <b>{o.name}</b> : c.value(o)}</td>)}
        {canManage && <td><button className="secondary small" onClick={() => { setEditing(o); setOpen(true); setMsg(null); setForm({ name: o.name, designation: o.designation || "SO", manager_id: o.manager_id || "", zone: o.zone || o.state || "", hq: o.hq || o.region || "", areas: o.areas || "", phone: o.phone || "", aliases: (o.aliases || []).join(", "), active: o.active }); }}>Edit</button></td>}</tr>)}</tbody></table>
      {!officers.length && <p className="empty">No staff yet. Import your staff list, or upload a DSR and the people in it are added.</p>}</div>
  </section>;
}
