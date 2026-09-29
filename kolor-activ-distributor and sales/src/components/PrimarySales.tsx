import { useEffect, useMemo, useState } from "react";
import { supabase, Distributor, Product, ProductAlias, fetchAll, matchDistributor, matchProduct, nextCode, proper, fmt, money, plural, errText } from "../lib/supabase";
import { normName } from "../lib/parse";
import { similarity, guessProduct } from "../lib/fuzzy";
import { PrimaryRead } from "../lib/primary";
import { runTask } from "../lib/tasks";
import { ask } from "../lib/ask";
import { Select } from "./Select";

const NEW = "__new", NEW_GODOWN = "__newgodown";
/** The billing sheet's category headings under the names the DSR list uses for the same products. */
const DSR_NAMES: Record<string, string> = { kajal: "Eye Shadow", foundation: "Compact", "eye shadow & blush": "Eye Shadow", "eye shadow and blush": "Eye Shadow", glycerine: "Lip Care", glycerin: "Lip Care" };
const dsrCategory = (c: string) => DSR_NAMES[c.trim().toLowerCase()] || c.trim();
const BOX = /\b(box|boxes|bx|bxs)\b/i;
const PAGE = 40;
const n = (v: unknown) => Number(v) || 0;

interface SsRow { key: string; name: string; state: string; town: string; invoices: number; pcs: number; value: number; pick: string; how: string }
interface ItemRow { key: string; name: string; category: string; rate: number | null; pop: boolean; pcs: number; pick: string; how: string }

/** Company billing to super stockists: check which SS and SKU each name is, then save every invoice as stock the SS received. */
export default function PrimarySales({ read, fileName, locations, products, aliases, canManage, onDone, onReadNormally, notify }: {
  read: PrimaryRead; fileName: string; locations: Distributor[]; products: Product[]; aliases: ProductAlias[]; canManage: boolean;
  onDone: (saved: boolean) => void; onReadNormally: () => void; notify: (m: string) => void;
}) {
  const supers = useMemo(() => locations.filter(l => l.kind === "SUPER_STOCKIST"), [locations]);
  // The company mostly bills super stockists, and some distributors directly.
  const dists = useMemo(() => locations.filter(l => l.kind === "DISTRIBUTOR"), [locations]);
  const kindNote = (l?: Distributor) => (l?.kind === "DISTRIBUTOR" ? ", distributor billed directly" : "");
  const [pieces, setPieces] = useState(read.pieces);
  const [busy, setBusy] = useState(false), [shown, setShown] = useState(PAGE), [allItems, setAllItems] = useState(false);
  const [saved, setSaved] = useState<Set<string> | null>(null);
  // Billed stock leaves the company godown.
  const godowns = useMemo(() => locations.filter(l => l.kind === "GODOWN"), [locations]);
  const [godown, setGodown] = useState(() => godowns[0]?.id || NEW_GODOWN), [noGodown, setNoGodown] = useState(0);
  // Quantities written in boxes ("346 Box"): pieces per box, remembered on the SKU.
  const boxItems = useMemo(() => [...new Set(read.invoices.flatMap(i => i.lines.filter(l => l.raw && BOX.test(l.raw)).map(l => l.item)))], [read]);
  const [boxPcs, setBoxPcs] = useState<Record<string, string>>({});

  // ---------- who each SS in the sheet is ----------
  const [ss, setSs] = useState<SsRow[]>(() => {
    const m = new Map<string, SsRow>();
    read.invoices.forEach(i => {
      const key = `${normName(i.ss)}|${normName(i.state)}`;
      const e = m.get(key) || { key, name: i.ss, state: i.state, town: i.town, invoices: 0, pcs: 0, value: 0, pick: "", how: "" };
      e.invoices++; e.pcs += i.lines.reduce((a, l) => a + l.pcs, 0); e.value += n(i.value); m.set(key, e);
    });
    return [...m.values()].sort((a, b) => b.value - a.value).map(e => {
      const exact = matchDistributor(e.name, supers) || matchDistributor(e.name, dists.filter(d => !e.state || !d.state || normName(d.state) === normName(e.state)));
      if (exact) return { ...e, pick: exact.id, how: `same name${kindNote(exact)}` };
      // A close spelling in the same state ("Parlar House" / "Parlour House").
      let best: Distributor | undefined, score = 0;
      [...supers, ...dists].filter(s => !e.state || !s.state || normName(s.state) === normName(e.state)).forEach(s => {
        const v = Math.max(similarity(e.name, s.name), similarity(e.name, s.company_name || ""), ...(s.aliases || []).map(a => similarity(e.name, a)));
        if (v > score) { score = v; best = s; }
      });
      return best && score >= 0.85 ? { ...e, pick: best.id, how: `similar name${kindNote(best)}, check` } : { ...e, pick: NEW, how: "not in the list" };
    });
  });

  // ---------- which SKU each item is ----------
  const [items, setItems] = useState<ItemRow[]>(() => {
    const pcs = new Map<string, number>();
    read.invoices.forEach(i => i.lines.forEach(l => pcs.set(normName(l.item), (pcs.get(normName(l.item)) || 0) + l.pcs)));
    return read.items.map(it => {
      const key = normName(it.name), base = { key, name: it.name, category: it.category || (it.pop ? "POP" : ""), rate: it.rate, pop: it.pop, pcs: pcs.get(key) || 0 };
      const exact = matchProduct("", it.name, products, aliases);
      if (exact) return { ...base, pick: exact.id, how: "same name" };
      const guess = it.pop ? undefined : guessProduct(it.name, n(it.rate) * 12, products);
      return guess ? { ...base, pick: guess.id, how: "similar name, check" } : { ...base, pick: NEW, how: it.pop ? "new display item" : "new SKU" };
    }).map((it, i, all) => {
      // Columns before the first category heading take the category their neighbours already have in the product list.
      if (it.category) return it;
      let a = i, b = i;
      while (a > 0 && !all[a - 1].category) a--;
      while (b < all.length - 1 && !all[b + 1].category) b++;
      const votes = new Map<string, number>();
      all.slice(a, b + 1).forEach(o => { const c = products.find(p => p.id === o.pick)?.category; if (c) votes.set(c, (votes.get(c) || 0) + 1); });
      const best = [...votes].sort((x, y) => y[1] - x[1])[0];
      return best ? { ...it, category: best[0] } : it;
    }).map((it, _, all) => {
      // A similar name can't take a SKU another column already is ("Soft Kajal New Pack" next to "Soft Kajal"): it's a separate SKU.
      if (!it.how.includes("check")) return it;
      const taken = all.some(o => o !== it && o.pick === it.pick && (o.how === "same name" || (o.how.includes("check") && o.pcs > it.pcs)));
      return taken ? { ...it, pick: NEW, how: "new SKU (the similar one is its own column)" } : it;
    }).map((it, _, all) => {
      // Categories follow the DSR list: a new SKU takes the category the matched SKUs of its sheet group have ("Kajal" items sit under "Eye Shadow").
      if (it.pick !== NEW || it.pop) return it;
      const votes = new Map<string, number>();
      all.filter(o => o.pick !== NEW && o.category === it.category).forEach(o => { const c = products.find(p => p.id === o.pick)?.category; if (c) votes.set(c, (votes.get(c) || 0) + 1); });
      const best = [...votes].sort((x, y) => y[1] - x[1])[0];
      return best ? { ...it, category: best[0] } : it;
    }).sort((a, b) => Number(a.how === "same name") - Number(b.how === "same name") || b.pcs - a.pcs);
  });

  useEffect(() => {
    setBoxPcs(b => ({ ...Object.fromEntries(boxItems.map(name => { const it = items.find(x => x.key === normName(name)); const p = products.find(x => x.id === it?.pick); return [normName(name), p?.box_pcs ? String(p.box_pcs) : ""]; })), ...b }));
  }, [boxItems]);
  const boxOf = (item: string) => Number(boxPcs[normName(item)]) || 0;
  const pcsOf = (l: PrimaryRead["invoices"][number]["lines"][number]) => (l.raw && BOX.test(l.raw) ? l.pcs * boxOf(l.item) : l.pcs);
  const boxMissing = boxItems.filter(name => !boxOf(name));

  // Invoices already saved for these super stockists, so the same sheet can come back each month with more rows.
  const ssIds = ss.map(s => s.pick).filter(id => id && id !== NEW).join(",");
  useEffect(() => {
    if (!supabase) return;
    let live = true;
    const refs = [...new Set(read.invoices.map(i => i.invoice).filter(Boolean))];
    const ids = ssIds ? ssIds.split(",") : [];
    (async () => {
      const got = new Set<string>();
      for (let i = 0; i < refs.length && ids.length; i += 150) {
        const { data } = await supabase!.from("inventory_transactions").select("distributor_id,reference").eq("source", "PURCHASE").in("distributor_id", ids).in("reference", refs.slice(i, i + 150));
        (data || []).forEach((r: { distributor_id: string; reference: string }) => got.add(`${r.distributor_id}|${r.reference}`));
      }
      // Billing saved before the godown was taken into account.
      const earlier = await fetchAll<{ id: string }>((a, b) => supabase!.from("inventory_transactions").select("id").eq("party", "Company billing").eq("mode", "INPUT").is("counterparty_id", null).order("id").range(a, b)).catch(() => []);
      if (live) { setSaved(got); setNoGodown(earlier.length); }
    })().catch(() => { if (live) setSaved(new Set()); });
    return () => { live = false; };
  }, [ssIds]);

  const ssOf = (name: string, state: string) => ss.find(s => s.key === `${normName(name)}|${normName(state)}`);
  const isSaved = (i: PrimaryRead["invoices"][number]) => { const s = ssOf(i.ss, i.state); return !!(saved && s && s.pick !== NEW && saved.has(`${s.pick}|${i.invoice}`)); };
  const fresh = read.invoices.filter(i => !isSaved(i));
  const months = [...new Set(read.invoices.map(i => i.date.slice(0, 7)).filter(Boolean))].sort();
  const monthName = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString("en-IN", { month: "short", year: "numeric" });
  const totalPcs = read.invoices.reduce((a, i) => a + i.lines.reduce((b, l) => b + l.pcs, 0), 0), totalValue = read.invoices.reduce((a, i) => a + n(i.value), 0);
  const newSs = ss.filter(s => s.pick === NEW), newItems = items.filter(i => i.pick === NEW), toCheck = [...ss, ...items].filter(x => x.how.includes("check")).length;
  const productOptions = useMemo(() => [...products].sort((a, b) => a.item_name.localeCompare(b.item_name)).map(p => <option key={p.id} value={p.id}>{p.item_name}{p.category ? ` · ${p.category}` : ""}</option>), [products]);
  const itemList = allItems ? items : items.filter(i => i.how !== "same name");

  async function save() {
    if (!supabase || !canManage) return;
    const dz = (pcs: number) => (pieces ? pcs / 12 : pcs);
    if (boxMissing.length) { notify(`Enter how many pieces are in a box of ${boxMissing.join(", ")} first.`); return; }
    const gName = godown === NEW_GODOWN ? "Company Godown (added now)" : godowns.find(g => g.id === godown)?.name;
    const parts = [
      fresh.length ? `Save ${plural(fresh.length, "invoice")} of company billing as stock received by ${plural(new Set(fresh.map(i => ssOf(i.ss, i.state)?.key)).size, "party", "parties")}.` : "",
      gName ? `The same stock leaves ${gName}${noGodown && !fresh.length ? ` (${fmt(noGodown)} lines billed earlier)` : ""}.` : "Godown stock stays as it is.",
      newSs.length ? `${plural(newSs.length, "new super stockist")} will be added.` : "",
      newItems.length ? `${plural(newItems.length, "new SKU")} will be added (${newItems.filter(i => i.pop).length} free display items).` : "",
      read.invoices.length - fresh.length ? `${plural(read.invoices.length - fresh.length, "invoice")} already saved will be skipped.` : "",
    ].filter(Boolean);
    if (!await ask(parts.join("\n\n"))) return;
    setBusy(true);
    try {
      const r = await runTask(`Saving billing from ${fileName}`, async task => {
        // New super stockists, with the sheet's spelling, state and town.
        const ids = new Map(ss.filter(s => s.pick !== NEW).map(s => [s.key, s.pick]));
        // The company godown, added if the app doesn't have one yet.
        let godownId = godown && godown !== NEW_GODOWN ? godown : null;
        if (godown === NEW_GODOWN) {
          const { data, error } = await supabase!.from("distributors").insert({ code: nextCode("GODOWN", locations), name: "Company Godown", company_name: "Hevlon Cosmetics", kind: "GODOWN", aliases: [] }).select("id").single();
          if (error) throw new Error(errText(error));
          godownId = (data as { id: string }).id;
        }
        if (newSs.length) {
          const taken: { code: string }[] = [...locations];
          const payload = newSs.map(s => { const code = nextCode("SUPER_STOCKIST", taken); taken.push({ code }); return { code, name: proper(s.name), company_name: proper(s.name), kind: "SUPER_STOCKIST", state: s.state || null, territory: s.town ? proper(s.town) : null, aliases: [] }; });
          const { data, error } = await supabase!.from("distributors").insert(payload).select("id,name");
          if (error) throw new Error(errText(error));
          (data as { id: string; name: string }[]).forEach((d, k) => ids.set(newSs[k].key, d.id));
        }
        // Spellings matched by a similar name are remembered, so the next sheet matches on its own.
        for (const s of ss.filter(x => x.how.includes("check") && x.pick !== NEW)) {
          const loc = locations.find(l => l.id === s.pick);
          if (loc && !(loc.aliases || []).some(a => normName(a) === normName(s.name))) await supabase!.from("distributors").update({ aliases: [...(loc.aliases || []), s.name] }).eq("id", loc.id);
        }
        for (const it of items.filter(x => x.how.includes("check") && x.pick !== NEW)) await supabase!.from("product_aliases").insert({ product_id: it.pick, alias: it.name });
        task.step(0, 1, "Lists updated");
        // One line per SS, invoice and product (the same item twice on an invoice is added up).
        const pick = new Map(items.map(i => [i.key, i]));
        const lines = new Map<string, Record<string, unknown>>();
        fresh.forEach(i => {
          const sid = ids.get(ssOf(i.ss, i.state)!.key)!;
          i.lines.forEach(l => {
            const it = pick.get(normName(l.item));
            const k = `${sid}|${i.invoice}|${it?.pick !== NEW ? it?.pick : normName(l.item)}`;
            const e = lines.get(k);
            if (e) { e.qty = n(e.qty) + dz(pcsOf(l)); return; }
            lines.set(k, { ss_id: sid, date: i.date, invoice: i.invoice, product_id: it && it.pick !== NEW ? it.pick : null, item: proper(l.item),
              category: it?.category || l.category || (it?.pop ? "POP" : ""), qty: dz(pcsOf(l)), free: !!it?.pop, rate: it?.pop ? null : l.rate !== null ? (pieces ? l.rate * 12 : l.rate) : null });
          });
        });
        // Every item goes into the SKU list first, with its category (display material not billed yet included), before the invoice lines.
        const itemLines = items.map(i => ({ ss_id: null, product_id: i.pick !== NEW ? i.pick : null, item: proper(i.name), category: i.pop ? "POP" : dsrCategory(i.category), qty: 0, free: i.pop,
          rate: i.pop ? null : i.rate !== null ? (pieces ? i.rate * 12 : i.rate) : null, box_pcs: boxOf(i.name) || null }));
        const all = [...itemLines, ...lines.values()], out = { added: 0, kept: 0, changed: 0, new_products: 0, count_adjusted: 0, godown_lines: 0, changed_lines: [] as unknown[] };
        for (let k = 0; k < all.length; k += 400) {
          const { data, error } = await supabase!.rpc("post_primary_sales", { p_lines: all.slice(k, k + 400), p_source_file: fileName, p_godown: godownId });
          if (error) throw new Error(`${errText(error)}. Run database step 012.`);
          const d = data as typeof out;
          out.added += d.added; out.kept += d.kept; out.changed += d.changed; out.new_products += d.new_products; out.count_adjusted += d.count_adjusted; out.godown_lines += d.godown_lines || 0; out.changed_lines.push(...d.changed_lines);
          task.step(Math.min(k + 400, all.length), all.length, `${fmt(out.added)} lines saved`);
        }
        return out;
      }, 1, r => `${fmt(r.added)} invoice lines saved${r.kept ? `, ${fmt(r.kept)} already there` : ""}.`);
      notify(`${r.added ? `Saved ${fmt(r.added)} billing lines from ${fileName}` : `${fileName}: no new invoices`}${r.new_products ? `, added ${plural(r.new_products, "SKU")}` : ""}${newSs.length ? `, added ${plural(newSs.length, "super stockist")}` : ""}.${r.kept ? ` ${fmt(r.kept)} lines were already saved and were skipped.` : ""}${r.changed ? ` ${plural(r.changed, "saved line")} now show${r.changed === 1 ? "s" : ""} a different quantity in the sheet; they were kept as first saved.` : ""}${r.count_adjusted ? ` ${fmt(r.count_adjusted)} lines were billed before a stock count the SS had already sent, so they show against that count.` : ""}${r.godown_lines ? ` ${fmt(r.godown_lines)} lines taken off the godown's stock.` : ""}`);
      onDone(true);
    } catch (e) { notify(`Billing not saved: ${errText(e)}`); }
    finally { setBusy(false); }
  }

  return <section className="card primary">
    <div className="rowhead"><div><h2>Company Billing To Super Stockists</h2>
      <p className="hint">{fileName}: read as billing from the company to super stockists ({read.sheets.join(", ")}). Each invoice becomes stock the SS received, so their monthly closing stock can be checked against it.</p></div>
      <div className="actions"><button className="secondary" disabled={busy} onClick={() => onDone(false)}>Cancel</button>
        <button className="secondary" disabled={busy} onClick={onReadNormally} title="Read it like any other stock file (for example the godown's own sales register)">Read As A Normal Stock File</button>
        <button disabled={busy || !canManage || !(fresh.length || newItems.length || (noGodown && godown)) || !saved} onClick={save}>{busy ? "Saving…" : !saved ? "Checking…" : fresh.length ? `Save ${plural(fresh.length, "Invoice")}` : newItems.length ? `Add ${plural(newItems.length, "New SKU")}` : noGodown && godown ? `Take ${fmt(noGodown)} Billed Lines Off The Godown` : "All Invoices Saved"}</button></div></div>
    {!canManage && <div className="status err">Only HO admins and state managers can save company billing.</div>}
    <div className="cards">
      <div className="metric"><small>Invoices</small><b>{fmt(read.invoices.length)}</b><span className="muted">{saved ? `${fmt(fresh.length)} new, ${fmt(read.invoices.length - fresh.length)} saved before` : "checking…"}</span></div>
      <div className="metric"><small>Super stockists</small><b>{ss.length}</b><span className="muted">{newSs.length ? `${newSs.length} new` : "all in your list"}</span></div>
      <div className="metric"><small>Quantity</small><b>{fmt(pieces ? totalPcs / 12 : totalPcs, 1)} dz</b><span className="muted">{fmt(pieces ? totalPcs : totalPcs * 12)} pcs</span></div>
      <div className="metric"><small>Value</small><b>{money(totalValue)}</b><span className="muted">{months.length ? `${monthName(months[0])} to ${monthName(months[months.length - 1])}` : ""}</span></div>
    </div>
    <div className="unitpick"><span>Quantities in this sheet are</span>
      <label className="inline"><input type="radio" checked={pieces} onChange={() => setPieces(true)} /> Pieces</label>
      <label className="inline"><input type="radio" checked={!pieces} onChange={() => setPieces(false)} /> Dozens</label>
      <small>{read.pieces ? "The heading says pieces." : "No unit in the heading; dozens assumed."} Stock is kept in dozens, so pieces are divided by 12.</small></div>
    <div className="unitpick"><span>Stock leaves from</span>
      <Select value={godown} onChange={e => setGodown(e.target.value)} aria-label="Godown">
        {godowns.map(g => <option key={g.id} value={g.id}>{g.name}{g.territory ? ` · ${g.territory}` : ""}</option>)}
        {!godowns.length && <option value={NEW_GODOWN}>Company Godown (add it)</option>}
        <option value="">Nowhere: don't change godown stock</option></Select>
      <small>A bill means the goods left the godown, so the godown's stock goes down by what's billed. Your godown audit then shows the real figure.</small></div>
    {boxItems.length > 0 && <div className="warn"><div>Some quantities are written in boxes. Enter the pieces in one box; it's remembered for next time.</div>
      <div className="boxsizes">{boxItems.map(name => <label key={name} className="inline">{name}: <input type="number" min={1} value={boxPcs[normName(name)] || ""} onChange={e => setBoxPcs(b => ({ ...b, [normName(name)]: e.target.value }))} /> pieces per box</label>)}</div></div>}
    {(read.notes.length > 0 || toCheck > 0) && <div className="warn">
      {toCheck > 0 && <div>{plural(toCheck, "name")} matched by a similar spelling: check {toCheck === 1 ? "it" : "them"} below (marked "check").</div>}
      {read.notes.slice(0, 12).map((t, k) => <div key={k}>{t}</div>)}{read.notes.length > 12 && <div>…and {read.notes.length - 12} more.</div>}</div>}

    <h3>Super Stockists</h3>
    <div className="tablewrap scrolltable short"><table className="nice"><thead><tr><th>In The Sheet</th><th>State · Town</th><th>Invoices</th><th>Pieces</th><th>Value</th><th>Billed To</th></tr></thead>
      <tbody>{ss.map(s => <tr key={s.key} className={s.how.includes("check") ? "flagged" : ""}><td><b>{s.name}</b><small className="muted">{s.how}</small></td><td>{[s.state, s.town].filter(Boolean).join(" · ")}</td>
        <td>{s.invoices}</td><td>{fmt(s.pcs)}</td><td>{money(s.value)}</td>
        <td><Select value={s.pick} onChange={e => setSs(list => list.map(x => (x.key === s.key ? { ...x, pick: e.target.value, how: e.target.value === NEW ? "not in the list" : "your pick" } : x)))}>
          <option value={NEW}>Add as a new super stockist</option>
          <optgroup label="Super stockists">{supers.map(l => <option key={l.id} value={l.id}>{l.name}{l.territory ? ` · ${l.territory}` : ""}{l.state ? ` · ${l.state}` : ""}</option>)}</optgroup>
          <optgroup label="Distributors billed directly">{dists.filter(d => !s.state || !d.state || normName(d.state) === normName(s.state)).map(l => <option key={l.id} value={l.id}>{l.name}{l.territory ? ` · ${l.territory}` : ""}</option>)}</optgroup></Select></td></tr>)}</tbody></table></div>

    <div className="rowhead"><h3>Items ({items.length})</h3>
      <label className="inline"><input type="checkbox" checked={allItems} onChange={e => { setAllItems(e.target.checked); setShown(PAGE); }} /> Show items that matched exactly too ({items.filter(i => i.how === "same name").length})</label></div>
    <p className="hint">{newItems.length ? `${plural(newItems.length, "item")} will be added as new SKUs, ${newItems.filter(i => i.pop).length} of them display items (stands, trays, bags, boards) under the POP category. ` : "Every item is already a SKU. "}Change any match that's wrong.</p>
    {itemList.length > 0 ? <div className="tablewrap scrolltable short"><table className="nice"><thead><tr><th>In The Sheet</th><th>Category</th><th>Rate / pc</th><th>Pieces</th><th>Save As</th></tr></thead>
      <tbody>{itemList.slice(0, shown).map(it => <tr key={it.key} className={it.how.includes("check") ? "flagged" : ""}><td><b>{it.name}</b><small className="muted">{it.how}</small></td>
        <td>{it.category || <span className="muted">from the product list</span>}</td><td>{it.rate !== null ? `₹${fmt(it.rate, 2)}` : "—"}</td><td>{fmt(it.pcs)}</td>
        <td><Select value={it.pick} onChange={e => setItems(list => list.map(x => (x.key === it.key ? { ...x, pick: e.target.value, how: e.target.value === NEW ? (x.pop ? "new display item" : "new SKU") : "your pick" } : x)))}>
          <option value={NEW}>Add as a new SKU</option>{productOptions}</Select></td></tr>)}</tbody></table></div> : <p className="hint">Every item matched a SKU by name.</p>}
    {itemList.length > shown && <div className="actions"><span className="muted">Showing {shown} of {itemList.length}.</span><button className="secondary" onClick={() => setShown(x => x + PAGE)}>Show More</button></div>}
  </section>;
}
