import { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { Distributor, StockLine, KINDS, KIND_LABEL, fmt, money } from "../lib/supabase";
import FilterBar, { Scope, emptyScope, applyScope, scopeLabel } from "../components/FilterBar";
import BarChart from "../components/BarChart";

type Group = "state" | "region" | "ss" | "location" | "product";
const GROUPS: { id: Group; label: string }[] = [
  { id: "state", label: "State" }, { id: "region", label: "Region" }, { id: "ss", label: "Super stockist" },
  { id: "location", label: "Location" }, { id: "product", label: "Product" },
];
/** Series order is fixed, so each location type keeps its colour on every chart. */
export const TYPE_SERIES = ["Godowns", "Super stockists", "Distributors"];
export const seriesIndex = (d?: Distributor) => (d?.kind === "GODOWN" ? 0 : d?.kind === "SUPER_STOCKIST" ? 1 : 2);

interface G { key: string; label: string; seg: number[]; units: number; value: number; locs: Set<string>; products: Set<string> }

export default function Reports({ stock, locations }: { stock: StockLine[]; locations: Distributor[] }) {
  const [scope, setScope] = useState<Scope>(emptyScope());
  const [group, setGroup] = useState<Group>("state");
  const [measure, setMeasure] = useState<"value" | "units">("value");
  const [search, setSearch] = useState("");
  const [hideZero, setHideZero] = useState(true);

  const byId = useMemo(() => new Map(locations.map(d => [d.id, d])), [locations]);
  const rank = useMemo(() => {
    const m = new Map<string, number>();
    stock.forEach(s => m.set(s.distributor_id, (m.get(s.distributor_id) || 0) + Number(s.stock_value)));
    return m;
  }, [stock]);
  const picked = applyScope(locations, scope);
  const ids = new Set(picked.map(d => d.id));
  const lines = stock.filter(s => ids.has(s.distributor_id));

  const groups = useMemo<G[]>(() => {
    const keyOf = (s: StockLine): [string, string] => {
      const d = byId.get(s.distributor_id);
      if (group === "state") return [d?.state || "", d?.state || "No state"];
      if (group === "region") return [`${d?.state || ""}|${d?.region || ""}`, `${d?.region || "No region"}${!scope.state && d?.state ? `, ${d.state}` : ""}`];
      if (group === "ss") {
        if (d?.kind === "GODOWN") return ["godowns", "Your godowns"];
        const ss = d?.kind === "SUPER_STOCKIST" ? d : byId.get(d?.parent_id || "");
        return [ss?.id || "", ss?.name || "No super stockist"];
      }
      if (group === "location") return [s.distributor_id, d?.name || s.distributor_name];
      return [s.product_id, `${s.item_name} (${s.sku})`];
    };
    const m = new Map<string, G>();
    lines.forEach(s => {
      const [key, label] = keyOf(s);
      const g = m.get(key) || { key, label, seg: [0, 0, 0], units: 0, value: 0, locs: new Set<string>(), products: new Set<string>() };
      const units = Number(s.current_stock), value = Number(s.stock_value);
      g.seg[seriesIndex(byId.get(s.distributor_id))] += measure === "value" ? value : units;
      g.units += units; g.value += value; g.locs.add(s.distributor_id);
      if (units) g.products.add(s.product_id);
      m.set(key, g);
    });
    return [...m.values()].sort((a, b) => (measure === "value" ? b.value - a.value : b.units - a.units));
  }, [lines, group, measure, byId, scope.state]);
  const totalUnits = groups.reduce((a, g) => a + g.units, 0), totalValue = groups.reduce((a, g) => a + g.value, 0);

  /** Clicking a bar narrows the filters to it and shows the next level down. */
  function drill(key: string) {
    if (group === "state") { setScope({ ...scope, state: key, region: "", ids: [] }); setGroup("region"); }
    else if (group === "region") { const [st, rg] = key.split("|"); setScope({ ...scope, state: st, region: rg, ids: [] }); setGroup("location"); }
    else if (group === "ss" && key && key !== "godowns") { setScope({ ...scope, ss: key, ids: [] }); setGroup("location"); }
    else if (group === "location") { setScope({ ...scope, ids: [key] }); setGroup("product"); }
  }

  const detail = lines.filter(s => (!hideZero || Number(s.current_stock) !== 0) && `${s.distributor_name} ${s.sku} ${s.item_name}`.toLowerCase().includes(search.toLowerCase()));
  const groupLabel = GROUPS.find(g => g.id === group)!.label;
  function exportAll() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(groups.map(g => ({
      [groupLabel]: g.label, Locations: g.locs.size, "Products in stock": g.products.size, Units: g.units, "Value ₹": Math.round(g.value),
      "Godown value ₹": measure === "value" ? Math.round(g.seg[0]) : undefined, "SS value ₹": measure === "value" ? Math.round(g.seg[1]) : undefined, "Distributor value ₹": measure === "value" ? Math.round(g.seg[2]) : undefined,
    }))), `By ${groupLabel.toLowerCase()}`.slice(0, 31));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detail.map(s => {
      const d = byId.get(s.distributor_id), ss = d?.kind === "DISTRIBUTOR" ? byId.get(d.parent_id || "") : undefined;
      return { Location: s.distributor_name, Code: s.distributor_code, Type: d ? KIND_LABEL[d.kind] : "", State: d?.state || "", Region: d?.region || "", "Super stockist": ss?.name || "",
        SKU: s.sku, Product: s.item_name, In: Number(s.total_input), Out: Number(s.total_output), Stock: Number(s.current_stock), "Rate ₹": Number(s.unit_price), "Value ₹": Number(s.stock_value), "Last movement": s.last_movement };
    })), "Stock detail");
    XLSX.writeFile(wb, `stock-report-${scopeLabel(locations, scope).toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  return <>
    <section className="card">
      <FilterBar locations={locations} value={scope} onChange={setScope} kinds={KINDS} rank={rank} saveKey="reports" />
      <div className="rowhead">
        <h2>Stock by {groupLabel.toLowerCase()} <small className="muted">· {scopeLabel(locations, scope)} · {fmt(totalUnits)} units · {money(totalValue)}</small></h2>
        <div className="actions">
          <div className="seg" role="group" aria-label="Group by">{GROUPS.map(g => <button key={g.id} className={group === g.id ? "on" : ""} onClick={() => setGroup(g.id)}>{g.label}</button>)}</div>
          <div className="seg" role="group" aria-label="Measure"><button className={measure === "value" ? "on" : ""} onClick={() => setMeasure("value")}>Value ₹</button><button className={measure === "units" ? "on" : ""} onClick={() => setMeasure("units")}>Units</button></div>
          <button onClick={exportAll} disabled={!lines.length}>Export to Excel</button>
        </div>
      </div>
      <BarChart title={`Stock ${measure} by ${groupLabel.toLowerCase()}`} series={TYPE_SERIES}
        bars={groups.map(g => ({ key: g.key, label: g.label, segments: g.seg }))} format={measure === "value" ? money : n => fmt(n)}
        onPick={group === "product" ? undefined : drill} />
      {group !== "product" && groups.length > 0 && <p className="hint">Click a bar to see what's inside it.</p>}
      <div className="tablewrap"><table><thead><tr><th>{groupLabel}</th><th>Locations</th><th>Products in stock</th><th>Units</th><th>Value ₹</th><th>Share of value</th></tr></thead>
        <tbody>{groups.map(g => <tr key={g.key}><td><b>{g.label}</b></td><td>{g.locs.size}</td><td>{g.products.size}</td><td>{fmt(g.units)}</td><td>{fmt(g.value)}</td>
          <td>{totalValue ? `${((g.value / totalValue) * 100).toFixed(1)}%` : "—"}</td></tr>)}</tbody></table>
        {!groups.length && <p className="empty">No stock for this selection.</p>}</div>
    </section>

    <section className="card"><div className="rowhead"><h2>Stock detail ({detail.length})</h2>
      <div className="actions"><input className="search" placeholder="Search location or product…" value={search} onChange={e => setSearch(e.target.value)} />
        <label className="inline"><input type="checkbox" checked={hideZero} onChange={e => setHideZero(e.target.checked)} /> Hide zero</label></div></div>
      <div className="tablewrap"><table><thead><tr><th>Location</th><th>Type</th><th>State</th><th>SKU</th><th>Product</th><th>In</th><th>Out</th><th>Stock</th><th>Value ₹</th><th>Last movement</th></tr></thead>
        <tbody>{detail.slice(0, 1500).map(s => { const d = byId.get(s.distributor_id); return <tr key={`${s.distributor_id}-${s.product_id}`}>
          <td>{s.distributor_name}</td><td>{d ? KIND_LABEL[d.kind] : ""}</td><td>{d?.state}</td><td>{s.sku}</td><td>{s.item_name}</td>
          <td className="in">+{fmt(s.total_input)}</td><td className="out">-{fmt(s.total_output)}</td><td><b>{fmt(s.current_stock)}</b></td><td>{fmt(s.stock_value)}</td><td>{s.last_movement}</td></tr>; })}</tbody></table>
        {detail.length > 1500 && <p className="hint">Showing 1,500 of {detail.length} lines. Export to Excel for all of them.</p>}
        {!detail.length && <p className="empty">No stock lines.</p>}</div></section>
  </>;
}
