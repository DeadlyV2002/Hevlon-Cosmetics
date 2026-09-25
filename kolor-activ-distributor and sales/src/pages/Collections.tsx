import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { supabase, Distributor, KIND_LABEL, StockLine, SalesOfficer, fetchAll, matchDistributor, fmt, money, plural, errText } from "../lib/supabase";
import { PRESETS, Range } from "../components/DateRange";
import DateRange from "../components/DateRange";
import FilterBar, { Scope, emptyScope, applyScope } from "../components/FilterBar";
import { Select } from "../components/Select";
import { useColumnFilters, Col } from "../components/ColumnFilter";
import DistributorReport, { Billing } from "../components/DistributorReport";
import { readAnyFile, ACCEPT } from "../lib/readers";
import { findHeader } from "../lib/sheet";
import { cellText, parseNum, toISODate, today, Grid } from "../lib/parse";

interface Payment { id: string; payer_id: string | null; payer_retailer_id: string | null; payee_id: string | null; paid_on: string; amount: number; mode: string | null; reference: string | null; note: string | null; source_file: string | null }
interface Props { locations: Distributor[]; stock: StockLine[]; officers: SalesOfficer[]; canManage: boolean; onChanged: () => Promise<void>; notify: (m: string) => void }
type PField = "date" | "payer" | "payee" | "amount" | "mode" | "reference" | "note";
const P_RULES: [PField, RegExp][] = [
  ["payee", /paid to|payee|received by|^to$/], ["payer", /paid by|payer|party|^from$|distributor|super stockist|stockist|^name$|customer|ledger/],
  ["date", /date|paid on|dated/], ["amount", /amount|amt|received|credit|value|rs/], ["mode", /mode|via|payment type/],
  ["reference", /ref|utr|cheque|chq|txn|transaction|voucher/], ["note", /note|remark|narration/],
];
const MODES = ["NEFT / RTGS", "UPI", "Cheque", "Cash", "Adjustment", "Other"];
const COMPANY = "Kolor Activ (company)";
const n = (x: unknown) => Number(x) || 0;
const daysSince = (d: string | null) => (d ? Math.round((Date.parse(today()) - Date.parse(d.slice(0, 10))) / 864e5) : null);

interface Row { loc: Distributor; ss: string; billed: number; collected: number; pct: number | null; owed: number; lastBill: string | null; lastPay: string | null; flag: string }

export default function Collections({ locations, stock, officers, canManage, onChanged, notify }: Props) {
  const [range, setRange] = useState<Range>(() => PRESETS.find(p => p.id === "fy")?.range() || PRESETS[0].range());
  const [scope, setScope] = useState<Scope>(emptyScope());
  const [bills, setBills] = useState<Billing[]>([]), [pays, setPays] = useState<Payment[]>([]);
  const [reload, setReload] = useState(0), [err, setErr] = useState("");
  const [report, setReport] = useState<Distributor | null>(null);
  const parties = useMemo(() => locations.filter(l => l.kind !== "GODOWN"), [locations]);
  const byId = useMemo(() => new Map(locations.map(l => [l.id, l])), [locations]);

  useEffect(() => {
    if (!supabase) return;
    Promise.all([
      supabase.rpc("billing_summary", { p_from: range.from, p_to: range.to }),
      fetchAll<Payment>((a, b) => supabase!.from("payments").select("*").order("paid_on", { ascending: false }).order("id").range(a, b)),
    ]).then(([b, p]) => { if (b.error) throw b.error; setBills(b.data as Billing[]); setPays(p); setErr(""); })
      .catch(e => setErr(`Couldn't load collections: ${errText(e)}. Run the latest database step (009) in Supabase.`));
  }, [range.from, range.to, reload]);

  const rows = useMemo<Row[]>(() => {
    const bill = new Map(bills.filter(b => b.party_type === "LOCATION").map(b => [b.party_id, b]));
    const inScope = applyScope(parties, scope);
    const base = inScope.map(loc => {
      const b = bill.get(loc.id), billed = n(b?.billed), collected = n(b?.collected);
      return { loc, ss: loc.kind === "DISTRIBUTOR" ? byId.get(loc.parent_id || "")?.name || "" : "", billed, collected,
        pct: billed > 0 ? (collected / billed) * 100 : null, owed: n(b?.billed_all) - n(b?.collected_all), lastBill: b?.last_bill || null, lastPay: b?.last_payment || null, flag: "" };
    });
    const billedList = base.filter(r => r.billed > 0).map(r => r.billed).sort((a, b) => a - b);
    const median = billedList.length ? billedList[Math.floor(billedList.length / 2)] : 0;
    base.forEach(r => {
      const since = daysSince(r.lastPay), flags: string[] = [];
      if (r.billed > 0 && r.pct !== null && r.billed >= median * 1.5 && r.pct < 70) flags.push("Heavy orders, low payment");
      else if (r.pct !== null && r.pct < 50) flags.push("Paid under half of billing");
      if (r.owed > 0 && (since === null || since > 45)) flags.push(since === null ? "Never paid" : `No payment in ${since} days`);
      r.flag = flags.join("; ");
    });
    return base.filter(r => r.billed || r.collected || r.owed);
  }, [bills, parties, scope, byId]);

  const cols: Col<Row>[] = [
    { key: "name", label: "Name", value: r => r.loc.name }, { key: "type", label: "Type", value: r => KIND_LABEL[r.loc.kind] },
    { key: "ss", label: "Super Stockist", value: r => r.ss }, { key: "state", label: "State", value: r => r.loc.state },
    { key: "billed", label: "Billed", value: r => Math.round(r.billed), num: true }, { key: "collected", label: "Collected", value: r => Math.round(r.collected), num: true },
    { key: "pct", label: "Collection %", value: r => (r.pct === null ? null : Math.round(r.pct)), num: true },
    { key: "owed", label: "Outstanding", value: r => Math.round(r.owed), num: true },
    { key: "lastBill", label: "Last Bill", value: r => r.lastBill }, { key: "lastPay", label: "Last Payment", value: r => r.lastPay }, { key: "flag", label: "Flag", value: r => r.flag },
  ];
  const table = useColumnFilters(rows, cols);
  const tot = table.rows.reduce((a, r) => ({ b: a.b + r.billed, c: a.c + r.collected, o: a.o + r.owed }), { b: 0, c: 0, o: 0 });

  // ---------- payments list ----------
  const inPeriod = pays.filter(p => p.paid_on >= range.from && p.paid_on <= range.to);
  const who = (id: string | null) => (id ? byId.get(id)?.name || "Deleted" : COMPANY);
  const pcols: Col<Payment>[] = [
    { key: "date", label: "Date", value: p => p.paid_on }, { key: "by", label: "Paid By", value: p => who(p.payer_id) }, { key: "to", label: "Paid To", value: p => who(p.payee_id) },
    { key: "amount", label: "Amount", value: p => n(p.amount), num: true }, { key: "mode", label: "Mode", value: p => p.mode }, { key: "ref", label: "Reference", value: p => p.reference },
  ];
  const ptable = useColumnFilters(inPeriod, pcols);
  async function remove(p: Payment) {
    if (!supabase || !confirm(`Delete the payment of ${money(p.amount)} by ${who(p.payer_id)} on ${p.paid_on}?`)) return;
    const { error } = await supabase.from("payments").delete().eq("id", p.id);
    if (error) return notify(`Not deleted: ${error.message}`);
    setReload(x => x + 1);
  }

  function exportAll() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(table.rows.map(r => ({ Name: r.loc.name, Code: r.loc.code, Type: KIND_LABEL[r.loc.kind], "Super Stockist": r.ss, State: r.loc.state, Billed: Math.round(r.billed), Collected: Math.round(r.collected), "Collection %": r.pct === null ? "" : Math.round(r.pct), Outstanding: Math.round(r.owed), "Last Bill": r.lastBill || "", "Last Payment": r.lastPay || "", Flag: r.flag }))), "Billing vs collection");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ptable.rows.map(p => ({ Date: p.paid_on, "Paid By": who(p.payer_id), "Paid To": who(p.payee_id), Amount: n(p.amount), Mode: p.mode || "", Reference: p.reference || "", Note: p.note || "" }))), "Payments");
    XLSX.writeFile(wb, `collections-${range.from}-to-${range.to}.xlsx`);
  }

  return <>
    <section className="card">
      <div className="rowhead"><h2>Billing vs Collection</h2>
        <div className="actions"><DateRange value={range} onChange={setRange} /><button className="secondary" onClick={exportAll} disabled={!rows.length && !inPeriod.length}>Export To Excel</button></div></div>
      <p className="hint">Billing is the stock each super stockist or distributor received from its supplier in the period; collection is what it paid. Low collection with heavy orders usually means stock is being held or credit is stretching. Click a name for the full report.</p>
      <FilterBar locations={locations} value={scope} onChange={setScope} kinds={["SUPER_STOCKIST", "DISTRIBUTOR"]} saveKey="collections" />
      {err && <div className="status err">{err}</div>}
      <div className="cards">
        <div className="metric"><small>Billed</small><b>{money(tot.b)}</b></div>
        <div className="metric"><small>Collected</small><b>{money(tot.c)}</b></div>
        <div className="metric"><small>Collection %</small><b>{tot.b ? `${fmt((tot.c / tot.b) * 100)}%` : "—"}</b></div>
        <div className="metric"><small>Outstanding</small><b>{money(tot.o)}</b></div>
      </div>
      {rows.length ? <div className="tablewrap"><table><thead><tr>{cols.map(c => table.head(c.key))}</tr></thead>
        <tbody>{table.rows.map(r => <tr key={r.loc.id} className={r.flag ? "flagged" : ""}>
          <td><button className="link" onClick={() => setReport(r.loc)}>{r.loc.name}</button></td><td>{KIND_LABEL[r.loc.kind]}</td><td>{r.ss}</td><td>{r.loc.state}</td>
          <td>{money(r.billed)}</td><td>{money(r.collected)}</td>
          <td><span className={`pctbar${r.pct === null ? "" : r.pct < 50 ? " low" : r.pct < 80 ? " mid" : " good"}`}>{r.pct === null ? "—" : `${fmt(r.pct)}%`}</span></td>
          <td>{money(r.owed)}</td><td>{r.lastBill || "—"}</td><td>{r.lastPay || "never"}</td><td className="wrap">{r.flag && <span className="err">{r.flag}</span>}</td></tr>)}</tbody></table>
        {!table.rows.length && <p className="empty">No rows match the column filters.</p>}</div>
        : <p className="empty">No bills or payments in this period yet. Billing comes from stock posted to super stockists and distributors; payments are recorded below.</p>}
    </section>

    {canManage && <PaymentForm parties={parties} byId={byId} onSaved={() => { setReload(x => x + 1); onChanged(); }} notify={notify} />}

    <section className="card">
      <div className="rowhead"><h2>Payments ({ptable.rows.length})</h2>{ptable.active > 0 && <button className="link" onClick={ptable.clear}>Clear Filters</button>}</div>
      {inPeriod.length ? <div className="tablewrap"><table><thead><tr>{pcols.map(c => ptable.head(c.key))}<th>Note</th>{canManage && <th />}</tr></thead>
        <tbody>{ptable.rows.map(p => <tr key={p.id}><td>{p.paid_on}</td><td>{who(p.payer_id)}</td><td>{who(p.payee_id)}</td><td>{money(p.amount)}</td><td>{p.mode}</td><td>{p.reference}</td><td className="wrap">{p.note}</td>
          {canManage && <td><button className="del" aria-label="Delete payment" onClick={() => remove(p)}>✕</button></td>}</tr>)}</tbody></table></div>
        : <p className="empty">No payments recorded in this period.</p>}
    </section>
    {report && <DistributorReport location={report} locations={locations} stock={stock} officers={officers} onClose={() => setReport(null)} />}
  </>;
}

// ---------- recording and importing payments ----------
function PaymentForm({ parties, byId, onSaved, notify }: { parties: Distributor[]; byId: Map<string, Distributor>; onSaved: () => void; notify: (m: string) => void }) {
  const blank = { payer: "", payee: "", date: today(), amount: "", mode: MODES[0], reference: "", note: "" };
  const [f, setF] = useState(blank), [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null), [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ file: string; rows: { date: string; payer?: Distributor; payerText: string; payee?: Distributor | null; payeeText: string; amount: number; mode: string; reference: string; note: string; problem: string }[] } | null>(null);
  const supers = parties.filter(p => p.kind === "SUPER_STOCKIST");
  const defaultPayee = (id: string) => { const p = byId.get(id); return p?.kind === "DISTRIBUTOR" ? p.parent_id || "" : ""; };
  const problem = !f.payer ? "Choose who paid." : !(Number(f.amount) > 0) ? "Enter the amount." : !f.date ? "Pick the date." : "";

  async function save() {
    if (!supabase || problem) return;
    setBusy(true);
    const { error } = await supabase.from("payments").insert({ payer_id: f.payer, payee_id: f.payee || null, paid_on: f.date, amount: Number(f.amount), mode: f.mode, reference: f.reference.trim() || null, note: f.note.trim() || null });
    setBusy(false);
    if (error) return setMsg({ kind: "err", text: `Not saved: ${error.message}` });
    setMsg({ kind: "ok", text: `Recorded ${money(Number(f.amount))} from ${byId.get(f.payer)?.name}.` });
    setF({ ...blank, date: f.date }); onSaved();
  }
  /** Reads every sheet of every chosen file; sheets without a payer and an amount column are listed as not used. */
  async function read(files: File[]) {
    try {
      const all: NonNullable<typeof preview>["rows"] = [], unused: string[] = [];
      for (const file of files) for (const sh of (await readAnyFile(file)).sheets) {
      const g: Grid = sh.grid;
      const h = findHeader(g, P_RULES, "amount");
      if (!h || !h.mapping.includes("payer")) { unused.push(`${file.name} › ${sh.name}`); continue; }
      const col = (k: PField) => h.mapping.indexOf(k);
      const rows = g.slice(h.row + 1).map(r => {
        const v = (k: PField) => (col(k) >= 0 ? cellText(r[col(k)]) : "");
        const payerText = v("payer"), payeeText = v("payee"), amount = col("amount") >= 0 ? parseNum(r[col("amount")]) || 0 : 0;
        if (!payerText && !amount) return null;
        const payer = matchDistributor(payerText, parties);
        const payee = !payeeText || /kolor|hevlon|company|head ?office|^ho$/i.test(payeeText) ? null : matchDistributor(payeeText, supers) || undefined;
        const date = col("date") >= 0 ? toISODate(r[col("date")]) : "";
        const problem = !payer ? `"${payerText}" isn't in your list` : !(amount > 0) ? "no amount" : !date ? "no date" : payee === undefined ? `"${payeeText}" isn't a super stockist` : "";
        return { date, payer, payerText, payee: payee === undefined ? undefined : payee ?? (payeeText ? null : byId.get(defaultPayee(payer?.id || "")) || null), payeeText, amount, mode: v("mode"), reference: v("reference"), note: v("note"), problem };
      }).filter(Boolean) as NonNullable<typeof preview>["rows"];
      all.push(...rows);
      }
      if (!all.length) throw new Error(`No payment rows found. A sheet needs columns for who paid and the amount (and ideally Date, Paid To, Mode, Reference).${unused.length ? ` Sheets read: ${unused.join(", ")}.` : ""}`);
      setPreview({ file: files.map(f => f.name).join(", "), rows: all });
      if (unused.length) setMsg({ kind: "ok", text: `Sheets without payment columns, not used: ${unused.join(", ")}.` });
    } catch (e) { setMsg({ kind: "err", text: `Import failed: ${errText(e)}` }); }
  }
  async function post() {
    if (!supabase || !preview) return;
    const good = preview.rows.filter(r => !r.problem);
    setBusy(true);
    const { error } = await supabase.from("payments").insert(good.map(r => ({ payer_id: r.payer!.id, payee_id: r.payee?.id || null, paid_on: r.date, amount: r.amount, mode: r.mode || null, reference: r.reference || null, note: r.note || null, source_file: preview.file })));
    setBusy(false);
    if (error) return setMsg({ kind: "err", text: `Import failed: ${error.message}` });
    const text = `Imported ${plural(good.length, "payment")} (${money(good.reduce((a, r) => a + r.amount, 0))}).${preview.rows.length > good.length ? ` ${plural(preview.rows.length - good.length, "row")} skipped.` : ""}`;
    setMsg({ kind: "ok", text }); notify(text); setPreview(null); onSaved();
  }

  return <section className="card upload">
    <div className="rowhead"><h2>Record A Payment</h2>
      <label className="button secondary">Import Payments<input hidden type="file" multiple accept={ACCEPT} onChange={e => { const x = [...(e.target.files || [])]; if (x.length) read(x); e.target.value = ""; }} /></label></div>
    <div className="formgrid">
      <label>Paid by *<Select value={f.payer} onChange={e => setF({ ...f, payer: e.target.value, payee: defaultPayee(e.target.value) })}>
        <option value="">Choose…</option>
        {(["DISTRIBUTOR", "SUPER_STOCKIST"] as const).map(k => <optgroup key={k} label={k === "DISTRIBUTOR" ? "Distributors" : "Super stockists"}>
          {parties.filter(p => p.kind === k).map(p => <option key={p.id} value={p.id}>{p.name}{p.territory ? ` · ${p.territory}` : ""}</option>)}</optgroup>)}</Select></label>
      <label>Paid to<Select value={f.payee} onChange={e => setF({ ...f, payee: e.target.value })}>
        <option value="">{COMPANY}</option>{supers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></label>
      <label>Date *<input type="date" value={f.date} onChange={e => setF({ ...f, date: e.target.value })} /></label>
      <label>Amount (₹) *<input inputMode="decimal" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value.replace(/[^\d.]/g, "") })} /></label>
      <label>Mode<Select value={f.mode} onChange={e => setF({ ...f, mode: e.target.value })}>{MODES.map(m => <option key={m}>{m}</option>)}</Select></label>
      <label>Reference <small>UTR, cheque no.</small><input value={f.reference} onChange={e => setF({ ...f, reference: e.target.value })} /></label>
      <label className="wide">Note<input value={f.note} onChange={e => setF({ ...f, note: e.target.value })} /></label>
    </div>
    <div className="actions"><button disabled={!!problem || busy} onClick={save}>{busy ? "Saving…" : "Save Payment"}</button><span className="hint reserve">{f.payer || f.amount ? problem : ""}</span></div>
    <div className="reserve">{msg && <div className={`status ${msg.kind}`}>{msg.text}</div>}</div>
    {preview && <div className="fixbox">
      <div className="rowhead"><b>Import preview — {preview.file}</b><div className="actions"><button className="secondary" onClick={() => setPreview(null)}>Cancel</button>
        <button disabled={busy || !preview.rows.some(r => !r.problem)} onClick={post}>Import {plural(preview.rows.filter(r => !r.problem).length, "Payment")}</button></div></div>
      <div className="tablewrap"><table><thead><tr><th>Date</th><th>Paid By</th><th>Paid To</th><th>Amount</th><th>Mode</th><th>Reference</th><th>Check</th></tr></thead>
        <tbody>{preview.rows.slice(0, 500).map((r, i) => <tr key={i} className={r.problem ? "bad" : ""}><td>{r.date}</td><td>{r.payer?.name || r.payerText}</td><td>{r.payee === undefined ? r.payeeText : r.payee?.name || COMPANY}</td>
          <td>{money(r.amount)}</td><td>{r.mode}</td><td>{r.reference}</td><td>{r.problem ? <span className="err">{r.problem}</span> : <span className="ok">Ready</span>}</td></tr>)}</tbody></table></div>
    </div>}
  </section>;
}
