import { useMemo, useState } from "react";
import { ask } from "../lib/ask";
import * as XLSX from "xlsx";
import { supabase, Distributor, Product, Margins, Scheme, schemesOn, marginsOn, matchProduct, fmt, plural, errText } from "../lib/supabase";
import { cellText, parseNum, today } from "../lib/parse";
import { readAnyFile, ACCEPT } from "../lib/readers";
import { dmy } from "../lib/dates";

interface Props {
  products: Product[]; locations: Distributor[]; margins: Margins; schemes: Scheme[];
  canManage: boolean; onChanged: () => Promise<void>; notify: (m: string) => void;
}
type Draft = { ss_rate: string; mrp: string };
type SchemeForm = { id?: string; name: string; starts_on: string; ends_on: string; ss_discount: string; ss_margin: string; distributor_margin: string; all: boolean; applies_to: string[]; note: string };
const emptyScheme = (): SchemeForm => ({ name: "", starts_on: today(), ends_on: today(), ss_discount: "", ss_margin: "", distributor_margin: "", all: true, applies_to: [], note: "" });

/** 126.5 → "126.50"; whole rupees stay whole. */
const rs = (n: number) => `₹${Number.isInteger(Math.round(n * 100) / 100) ? fmt(n) : fmt(n, 2)}`;
const pct = (n: number) => `${fmt(n, 2).replace(/\.?0+$/, "")}%`;
const up = (n: number, p: number) => Math.round(n * (1 + p / 100) * 100) / 100;
const shortDate = (d: string) => dmy(d);

export default function Pricing({ products, locations, margins, schemes, canManage, onChanged, notify }: Props) {
  const day = today();
  const ssList = locations.filter(l => l.kind === "SUPER_STOCKIST");
  const ssName = (id: string) => ssList.find(s => s.id === id)?.name || "Deleted super stockist";
  const running = schemesOn(schemes, day);
  const now = marginsOn(margins, schemes, day);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const say = (kind: "ok" | "err", text: string) => { setMsg({ kind, text }); notify(text); };
  const [busy, setBusy] = useState("");

  // ---------- margins ----------
  const [m, setM] = useState({ ss: String(margins.ss), distributor: String(margins.distributor) });
  const mDirty = Number(m.ss) !== margins.ss || Number(m.distributor) !== margins.distributor;
  const mBad = [m.ss, m.distributor].some(v => v.trim() === "" || isNaN(Number(v)) || Number(v) < 0 || Number(v) >= 100);
  async function saveMargins() {
    if (!supabase || mBad) return;
    setBusy("margins");
    const { error } = await supabase.from("app_settings").upsert({ key: "margins", value: { ss: Number(m.ss), distributor: Number(m.distributor) }, updated_at: new Date().toISOString() });
    setBusy("");
    if (error) return say("err", `Margins weren't saved: ${error.message}`);
    say("ok", `Standard margins saved: super stockists ${pct(Number(m.ss))}, distributors ${pct(Number(m.distributor))}.`);
    await onChanged();
  }
  const ex = 100, exD = up(ex, Number(m.ss) || 0), exR = up(exD, Number(m.distributor) || 0);

  // ---------- schemes ----------
  const [form, setForm] = useState<SchemeForm | null>(null);
  const status = (s: Scheme) => (s.ends_on < day ? "Ended" : s.starts_on > day ? "Upcoming" : "Running");
  const covers = (s: Scheme) => (!s.applies_to?.length ? "All super stockists" : s.applies_to.map(ssName).join(", "));
  function edit(s: Scheme) {
    setForm({ id: s.id, name: s.name, starts_on: s.starts_on, ends_on: s.ends_on, ss_discount: Number(s.ss_discount) ? String(Number(s.ss_discount)) : "",
      ss_margin: s.ss_margin === null ? "" : String(Number(s.ss_margin)), distributor_margin: s.distributor_margin === null ? "" : String(Number(s.distributor_margin)),
      all: !s.applies_to?.length, applies_to: s.applies_to || [], note: s.note || "" });
  }
  const pctOk = (v: string) => v.trim() === "" || (!isNaN(Number(v)) && Number(v) >= 0 && Number(v) < 100);
  const formProblem = !form ? "" : !form.name.trim() ? "Give the scheme a name."
    : !form.starts_on || !form.ends_on ? "Pick both dates." : form.ends_on < form.starts_on ? "The end date is before the start date."
    : ![form.ss_discount, form.ss_margin, form.distributor_margin].every(pctOk) ? "Percentages must be between 0 and 99.99."
    : !Number(form.ss_discount) && form.ss_margin.trim() === "" && form.distributor_margin.trim() === "" ? "Set a discount or a margin; otherwise the scheme changes nothing."
    : !form.all && !form.applies_to.length ? "Pick at least one super stockist, or choose all of them." : "";
  async function saveScheme() {
    if (!supabase || !form || formProblem) return;
    const row = {
      name: form.name.trim(), starts_on: form.starts_on, ends_on: form.ends_on, ss_discount: Number(form.ss_discount) || 0,
      ss_margin: form.ss_margin.trim() === "" ? null : Number(form.ss_margin), distributor_margin: form.distributor_margin.trim() === "" ? null : Number(form.distributor_margin),
      applies_to: form.all ? null : form.applies_to, note: form.note.trim() || null,
    };
    setBusy("scheme");
    const { error } = form.id ? await supabase.from("schemes").update(row).eq("id", form.id) : await supabase.from("schemes").insert(row);
    setBusy("");
    if (error) return say("err", `The scheme wasn't saved: ${error.message}`);
    say("ok", `Saved “${row.name}”, ${shortDate(row.starts_on)} to ${shortDate(row.ends_on)}.`);
    setForm(null);
    await onChanged();
  }
  async function removeScheme(s: Scheme) {
    if (!supabase || !await ask(`Delete the scheme “${s.name}”? Charts that valued dispatches with its discount will use the full SS rate instead.`)) return;
    setBusy("scheme");
    const { error } = await supabase.from("schemes").delete().eq("id", s.id);
    setBusy("");
    if (error) return say("err", `The scheme wasn't deleted: ${error.message}`);
    say("ok", `Deleted “${s.name}”.`);
    await onChanged();
  }

  // ---------- product prices ----------
  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map());
  const [q, setQ] = useState(""), [onlyMissing, setOnlyMissing] = useState(false);
  const val = (p: Product, f: keyof Draft) => drafts.get(p.id)?.[f] ?? (p[f] === null ? "" : String(Number(p[f])));
  const setVal = (p: Product, f: keyof Draft, v: string) => setDrafts(prev => {
    const n = new Map(prev), d = { ss_rate: val(p, "ss_rate"), mrp: val(p, "mrp"), [f]: v };
    const same = (x: string, y: number | null) => (x.trim() === "" ? y === null : Number(x) === Number(y));
    if (same(d.ss_rate, p.ss_rate) && same(d.mrp, p.mrp)) n.delete(p.id); else n.set(p.id, d);
    return n;
  });
  const missing = products.filter(p => !Number(p.ss_rate));
  const [pstatus, setPstatus] = useState<"ALL" | "ACTIVE" | "DORMANT">("ALL");
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return products.filter(p => (!onlyMissing || !Number(p.ss_rate)) && (pstatus === "ALL" || (p.status || "ACTIVE") === pstatus) && (!t || p.item_name.toLowerCase().includes(t) || p.sku.toLowerCase().includes(t)));
  }, [products, q, onlyMissing, pstatus]);
  /** Dormant products stay listed: distributors still return old stock of them. */
  async function setStatus(p: Product) {
    if (!supabase) return;
    const next = p.status === "DORMANT" ? "ACTIVE" : "DORMANT";
    const { error } = await supabase.rpc("set_product_status", { p_ids: [p.id], p_status: next });
    if (error) return say("err", `Not changed: ${errText(error)}. Run database step 012.`);
    say("ok", `${p.item_name} is now ${next === "DORMANT" ? "dormant (kept in the list for returns and old stock)" : "active"}.`);
    await onChanged();
  }
  const badDraft = [...drafts.values()].some(d => [d.ss_rate, d.mrp].some(v => v.trim() !== "" && (isNaN(Number(v)) || Number(v) < 0)));
  async function savePrices() {
    if (!supabase || !drafts.size || badDraft) return;
    setBusy("prices");
    const failed: string[] = [];
    for (const [id, d] of drafts) {
      const { error } = await supabase.from("products").update({ ss_rate: d.ss_rate.trim() === "" ? null : Number(d.ss_rate), mrp: d.mrp.trim() === "" ? null : Number(d.mrp) }).eq("id", id);
      if (error) failed.push(`${products.find(p => p.id === id)?.item_name}: ${error.message}`);
    }
    setBusy("");
    const done = drafts.size - failed.length;
    if (failed.length) say("err", `Saved ${plural(done, "product")}; ${plural(failed.length, "product")} failed. ${failed.slice(0, 3).join("; ")}`);
    else say("ok", `Saved prices for ${plural(done, "product")}. Stock values now use the new SS rates.`);
    setDrafts(new Map());
    await onChanged();
  }
  /** The DSR price list (SS rate per dozen for every product) becomes the product list. */
  async function fromDsr() {
    if (!supabase) return;
    setBusy("dsr");
    const { data, error } = await supabase.rpc("products_from_dsr");
    setBusy("");
    if (error) return say("err", `Couldn't add the DSR products: ${errText(error)}. Upload a DSR on the SO Reports page first, and run database step 011.`);
    const r = data as { added: number; rated: number };
    say("ok", r.added || r.rated ? `Added ${plural(r.added, "product")} from the DSR price list${r.rated ? ` and set the SS rate of ${plural(r.rated, "listed product")}` : ""}. Quantities for these are in dozens.` : "Every DSR product is already in the product list.");
    await onChanged();
  }
  function fillFromPurchase() {
    setDrafts(prev => {
      const n = new Map(prev);
      for (const p of missing) if (p.purchase_rate > 0 && !n.get(p.id)?.ss_rate) n.set(p.id, { ss_rate: String(p.purchase_rate), mrp: val(p, "mrp") });
      return n;
    });
  }
  function download() {
    const rows = products.map(p => ({ SKU: p.sku, Product: p.item_name, "SS rate": Number(p.ss_rate) || "", MRP: Number(p.mrp) || "", "Last purchase rate": p.purchase_rate || "" }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Prices");
    XLSX.writeFile(wb, `price-list-${day}.xlsx`);
  }
  /** Reads every sheet of every chosen file (Excel, CSV, PDF, Word…) that has an SS rate or MRP column. */
  async function upload(files: File[]) {
    let n = 0; const unknown: string[] = [], unused: string[] = [];
    const next = new Map(drafts);
    for (const file of files) {
      try {
        for (const sh of (await readAnyFile(file)).sheets) {
          const grid = sh.grid;
          const hi = grid.findIndex(r => r.some(c => /\bss\b|mrp/i.test(cellText(c))));
          if (hi < 0) { unused.push(`${file.name} › ${sh.name}`); continue; }
          const head = grid[hi].map(c => cellText(c).toLowerCase());
          const col = (re: RegExp) => head.findIndex(h => re.test(h));
          const cSku = col(/sku|code/), cName = col(/product|item|name/), cSs = col(/\bss\b/), cMrp = col(/mrp/);
          for (const r of grid.slice(hi + 1)) {
            const sku = cSku >= 0 ? cellText(r[cSku]) : "", name = cName >= 0 ? cellText(r[cName]) : "";
            if (!sku && !name) continue;
            const p = matchProduct(sku, name, products);
            if (!p) { unknown.push(name || sku); continue; }
            const ss = cSs >= 0 ? parseNum(r[cSs]) : null, mrp = cMrp >= 0 ? parseNum(r[cMrp]) : null;
            if (ss === null && mrp === null) continue;
            const cur = next.get(p.id) || { ss_rate: val(p, "ss_rate"), mrp: val(p, "mrp") };
            next.set(p.id, { ss_rate: ss !== null ? String(ss) : cur.ss_rate, mrp: mrp !== null ? String(mrp) : cur.mrp });
            n++;
          }
        }
      } catch (e) { unused.push(`${file.name} (${errText(e)})`); }
    }
    setDrafts(next);
    say(n ? "ok" : "err", `${n ? `Read prices for ${plural(n, "product")}. Check them below, then press Save prices.` : "No prices were read."}${unknown.length ? ` ${plural(unknown.length, "row")} didn't match a product: ${unknown.slice(0, 5).join(", ")}${unknown.length > 5 ? "…" : ""}.` : ""}${unused.length ? ` Not used (no SS rate or MRP column): ${unused.join(", ")}.` : ""}`);
  }

  /** "gives North Star a 2% billing discount and sets the distributor margin to 18%" */
  function effect(s: Scheme) {
    const who = s.applies_to?.length ? s.applies_to.map(ssName).join(", ") : "all super stockists";
    const parts = [
      Number(s.ss_discount) ? `gives ${who} a ${pct(Number(s.ss_discount))} billing discount` : "",
      s.ss_margin !== null ? `sets the super stockist margin to ${pct(Number(s.ss_margin))}` : "",
      s.distributor_margin !== null ? `sets the distributor margin to ${pct(Number(s.distributor_margin))}` : "",
    ].filter(Boolean);
    const scope = !Number(s.ss_discount) && s.applies_to?.length ? ` for ${who}` : "";
    return `${s.name} ${parts.join(" and ")}${scope}, until ${shortDate(s.ends_on)}.`;
  }
  return <>
    {msg && <div className={`status ${msg.kind}`}>{msg.text}</div>}

    <section className="card">
      <div className="rowhead"><h2>Margins</h2>{running.length > 0 && <span className="pill count">{plural(running.length, "scheme")} running today</span>}</div>
      <p>Stock everywhere in the app is valued at the <b>SS rate</b>, the price you bill super stockists. Super stockists add their margin when they bill distributors, and distributors add theirs when they sell to retailers. Retailers sell anywhere up to MRP.</p>
      <div className="formgrid">
        <label>Super stockist margin (%)<input inputMode="decimal" value={m.ss} disabled={!canManage} onChange={e => setM({ ...m, ss: e.target.value })} /></label>
        <label>Distributor margin (%)<input inputMode="decimal" value={m.distributor} disabled={!canManage} onChange={e => setM({ ...m, distributor: e.target.value })} /></label>
      </div>
      <p className="hint">At these margins, a product with an SS rate of {rs(ex)} goes to distributors at {rs(exD)} and to retailers at {rs(exR)}.</p>
      {(now.ss !== margins.ss || now.distributor !== margins.distributor) && <p className="warn">A scheme covering every super stockist is running today, so the prices below use {pct(now.ss)} for super stockists and {pct(now.distributor)} for distributors.</p>}
      {running.map(s => <p key={s.id} className="hint">Running today: {effect(s)}</p>)}
      {canManage ? <button disabled={!mDirty || mBad || busy === "margins"} onClick={saveMargins}>{busy === "margins" ? "Saving…" : "Save margins"}</button>
        : <p className="hint">Only HO admins and state managers can change margins.</p>}
      <p className="hint reserve">{mBad ? "Margins must be numbers from 0 to 99.99." : ""}</p>
    </section>

    <section className="card">
      <div className="rowhead"><h2>Schemes</h2>{canManage && !form && <button onClick={() => setForm(emptyScheme())}>Add scheme</button>}</div>
      <p>A scheme runs between two dates. It can give super stockists a billing discount (say 2% for paying in advance) and can change either margin for that period. Where schemes overlap, the biggest discount applies, and the scheme that started last sets the margins.</p>
      {form && <div className="editor">
        <h3>{form.id ? "Edit scheme" : "New scheme"}</h3>
        <div className="formgrid">
          <label className="wide">Name<input value={form.name} placeholder="Festive prepay" onChange={e => setForm({ ...form, name: e.target.value })} /></label>
          <label>From<input type="date" value={form.starts_on} onChange={e => setForm({ ...form, starts_on: e.target.value })} /></label>
          <label>To<input type="date" value={form.ends_on} onChange={e => setForm({ ...form, ends_on: e.target.value })} /></label>
          <label>Billing discount to super stockists (%)<input inputMode="decimal" value={form.ss_discount} placeholder="0" onChange={e => setForm({ ...form, ss_discount: e.target.value })} /></label>
          <label>Super stockist margin (%) <small>blank keeps {pct(margins.ss)}</small><input inputMode="decimal" value={form.ss_margin} onChange={e => setForm({ ...form, ss_margin: e.target.value })} /></label>
          <label>Distributor margin (%) <small>blank keeps {pct(margins.distributor)}</small><input inputMode="decimal" value={form.distributor_margin} onChange={e => setForm({ ...form, distributor_margin: e.target.value })} /></label>
          <label className="wide">Note<input value={form.note} placeholder="Paid before billing" onChange={e => setForm({ ...form, note: e.target.value })} /></label>
        </div>
        <div className="actions wrap">
          <label className="inline"><input type="radio" checked={form.all} onChange={() => setForm({ ...form, all: true })} /> All super stockists</label>
          <label className="inline"><input type="radio" checked={!form.all} onChange={() => setForm({ ...form, all: false })} /> Only these:</label>
        </div>
        {!form.all && (ssList.length ? <div className="actions wrap">{ssList.map(s => <label key={s.id} className="inline"><input type="checkbox" checked={form.applies_to.includes(s.id)}
          onChange={e => setForm({ ...form, applies_to: e.target.checked ? [...form.applies_to, s.id] : form.applies_to.filter(x => x !== s.id) })} /> {s.name}</label>)}</div>
          : <p className="hint">No super stockists yet. Add them on the Distributors page.</p>)}
        <p className="hint reserve">{formProblem}</p>
        <div className="actions"><button disabled={!!formProblem || busy === "scheme"} onClick={saveScheme}>{busy === "scheme" ? "Saving…" : "Save scheme"}</button>
          <button className="secondary" onClick={() => setForm(null)}>Cancel</button></div>
      </div>}
      {schemes.length ? <div className="tablewrap"><table><thead><tr><th>Scheme</th><th>Dates</th><th>Covers</th><th>Discount</th><th>SS margin</th><th>Distributor margin</th><th>Status</th>{canManage && <th />}</tr></thead>
        <tbody>{schemes.map(s => <tr key={s.id}>
          <td>{s.name}{s.note && <div className="muted">{s.note}</div>}</td>
          <td>{shortDate(s.starts_on)} to {shortDate(s.ends_on)}</td>
          <td>{covers(s)}</td>
          <td>{Number(s.ss_discount) ? pct(Number(s.ss_discount)) : "none"}</td>
          <td>{s.ss_margin === null ? <span className="muted">standard</span> : pct(Number(s.ss_margin))}</td>
          <td>{s.distributor_margin === null ? <span className="muted">standard</span> : pct(Number(s.distributor_margin))}</td>
          <td><span className={`pill ${status(s) === "Running" ? "input" : status(s) === "Upcoming" ? "count" : ""}`}>{status(s)}</span></td>
          {canManage && <td><button className="secondary small" onClick={() => edit(s)}>Edit</button> <button className="secondary small" disabled={busy === "scheme"} onClick={() => removeScheme(s)}>Delete</button></td>}
        </tr>)}</tbody></table></div>
        : <p className="muted">No schemes yet.</p>}
    </section>

    <section className="card">
      <div className="rowhead"><h2>Product prices</h2>
        <div className="actions wrap">{canManage && <button className="secondary" disabled={busy === "dsr"} onClick={fromDsr}>{busy === "dsr" ? "Adding…" : "Add DSR Products"}</button>}<button className="secondary" onClick={download}>Download price list</button>
          {canManage && <label className="filebtn">Upload price list<input type="file" multiple accept={ACCEPT} hidden onChange={e => { const f = [...(e.target.files || [])]; if (f.length) upload(f); e.target.value = ""; }} /></label>}</div></div>
      <p>The SS rate is set automatically the first time a godown dispatch to a super stockist carries a rate. Change it here when your price list changes. Distributor and retailer prices use today's margins; schemes for particular super stockists aren't included.</p>
      {missing.length > 0 && <p className="warn">{plural(missing.length, "product")} {missing.length === 1 ? "has" : "have"} no SS rate and {missing.length === 1 ? "is" : "are"} valued at the last purchase rate for now.
        {canManage && <> <button className="secondary" onClick={fillFromPurchase}>Use purchase rate as SS rate</button></>}</p>}
      <div className="actions wrap">
        <input placeholder="Search products" value={q} onChange={e => setQ(e.target.value)} className="pricing-search" />
        <label className="inline"><input type="checkbox" checked={onlyMissing} onChange={e => setOnlyMissing(e.target.checked)} /> Only products without an SS rate</label>
        <div className="seg" role="group" aria-label="Show">{(["ALL", "ACTIVE", "DORMANT"] as const).map(k => <button key={k} className={pstatus === k ? "on" : ""} onClick={() => setPstatus(k)}>
          {k === "ALL" ? `All (${products.length})` : k === "ACTIVE" ? `Active (${products.filter(p => p.status !== "DORMANT").length})` : `Dormant (${products.filter(p => p.status === "DORMANT").length})`}</button>)}</div>
      </div>
      {products.length ? <div className="tablewrap scrolltable"><table className="edit nice"><thead><tr><th>SKU</th><th>Product</th><th>Status</th><th>Last purchase rate</th><th>SS rate / dozen</th><th>To distributor / dozen</th><th>To retailer / dozen</th><th>MRP / piece</th><th>MRP ÷ SS rate</th></tr></thead>
        <tbody>{shown.map(p => {
          const ss = Number(val(p, "ss_rate")) || 0, mrp = Number(val(p, "mrp")) || 0;
          const d = up(ss, now.ss), r = up(d, now.distributor);
          return <tr key={p.id} className={drafts.has(p.id) ? "changed" : undefined}>
            <td>{p.sku}</td><td>{p.item_name}</td>
            <td><button className={`statuspill ${p.status === "DORMANT" ? "dormant" : "active"}`} disabled={!canManage} onClick={() => setStatus(p)} title={canManage ? "Click to change" : undefined}>{p.status === "DORMANT" ? "Dormant" : "Active"}</button></td>
            <td>{p.purchase_rate ? rs(p.purchase_rate) : <span className="muted">none</span>}</td>
            <td><input inputMode="decimal" aria-label={`SS rate for ${p.item_name}`} value={val(p, "ss_rate")} disabled={!canManage} placeholder="not set" onChange={e => setVal(p, "ss_rate", e.target.value)} /></td>
            <td>{ss ? rs(d) : ""}</td>
            <td>{ss ? rs(r) : ""}{ss && mrp && r > mrp * 12 ? <div className="err">above MRP ({rs(mrp * 12)} a dozen)</div> : null}</td>
            <td><input inputMode="decimal" aria-label={`MRP for ${p.item_name}`} value={val(p, "mrp")} disabled={!canManage} placeholder="not set" onChange={e => setVal(p, "mrp", e.target.value)} /></td>
            <td>{ss && mrp ? `${fmt((mrp * 12) / ss, 1)}×` : ""}</td>
          </tr>;
        })}</tbody></table></div>
        : <p className="muted">No products yet. They're added when stock is uploaded.</p>}
      {shown.length === 0 && products.length > 0 && <p className="muted">No products match.</p>}
      {canManage && <div className="actions">
        <button disabled={!drafts.size || badDraft || busy === "prices"} onClick={savePrices}>{busy === "prices" ? "Saving…" : drafts.size ? `Save prices (${plural(drafts.size, "product")})` : "Save prices"}</button>
        {drafts.size > 0 && <button className="secondary" onClick={() => setDrafts(new Map())}>Discard changes</button>}
        <span className="hint reserve">{badDraft ? "Prices must be numbers of 0 or more." : ""}</span>
      </div>}
      {msg && <div className={`status ${msg.kind}`}>{msg.text}</div>}
    </section>
  </>;
}

