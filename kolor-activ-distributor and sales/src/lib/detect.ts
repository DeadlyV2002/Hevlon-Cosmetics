// Works out what an uploaded file is (closing stock, stock received, stock sent out, or an
// SO report) and whose stock it is, from the heading, file name, columns and party names.
// Pure functions, so they can be tested outside the browser.
import { Grid, Layout, cellText, normName, detectDistributor } from "./parse";
import { keyWords, hasWord, similarity } from "./fuzzy";
import { Distributor, SalesOfficer, KIND_LABEL, matchDistributor } from "./supabase";

export type FileType = "COUNT" | "IN" | "OUT" | "SO";
export interface Detection {
  type: FileType;
  /** false when the type is only a guess and the user should confirm it */
  sure: boolean;
  /** location code whose stock the file is about ("" if unknown) */
  holder: string;
  /** SO code for SO reports that name the SO in the heading or file name */
  so: string;
  reasons: string[];
}

const COUNT_HEAD = /\b(stock summary|closing stock|stock statement|stock report|stock position|godown summary|physical stock|current stock|inventory)\b/;
const IN_HEAD = /\b(purchase|purchases|purchase register|receipt note|grn|goods received|inward|inwards|material received)\b/;
const OUT_HEAD = /\b(sales|sale|sales register|dispatch|despatch|delivery note|delivery|challan|invoice|invoices|stock transfer|outward|outwards|issue)\b/;
const SO_HEAD = /\b(so report|so daily|dsr|daily sales report|order report|order booking|orders booked|beat report|salesman report|secondary order|secondary orders)\b/;
const CLOSING_LABEL = /(^| )(closing|stock in hand|soh|physical stock|current stock|available stock|balance)( |$)|^stock$/;

/** When no name matches exactly: the distributor whose distinctive words (allowing small spelling
 * differences) appear in the heading or file name, helped by its town appearing there too. */
function nearDistributor(title: string, locations: Distributor[]): string {
  const words = normName(title).split(" ").filter(Boolean);
  let best = "", score = 0, tie = false;
  for (const d of locations) {
    const keys = [...new Set([...keyWords(d.name), ...keyWords(d.company_name || "")])];
    if (!keys.length) continue;
    const hit = keys.filter(k => hasWord(words, k)).length;
    if (!hit) continue;
    const town = d.territory ? words.some(w => w.length >= 4 && similarity(w, d.territory!) >= 0.75) : false;
    const s = hit / keys.length + (town ? 0.6 : 0) + (hit === keys.length ? 0.3 : 0);
    if (s > score + 0.01) { best = d.code; score = s; tie = false; } else if (Math.abs(s - score) <= 0.01) tie = true;
  }
  return score >= 1 && !tie ? best : "";
}

export function detectFile(grid: Grid, layout: Layout, heading: string, fileName: string, locations: Distributor[], officers: SalesOfficer[]): Detection {
  const reasons: string[] = [];
  const title = `${heading} ${fileName.replace(/\.[a-z0-9]+$/i, "").replace(/[_\-.]+/g, " ")}`;
  const h = ` ${normName(title)} `;
  const col = (f: Layout["mapping"][number]) => layout.mapping.indexOf(f);
  const start = layout.headerRow + Math.max(layout.headerRows, 1);
  const body = layout.headerRow >= 0 ? grid.slice(start, start + 300) : [];
  const values = (i: number) => (i < 0 ? [] : body.map(r => cellText(r[i])).filter(Boolean));
  const parties = values(col("retailer"));
  const vtCol = layout.labels.findIndex(l => /^(voucher type|vch type|vch bill type|voucher type name|type)$/.test(l));
  const vtypes = values(vtCol).map(v => v.toLowerCase());

  const holderCode = detectDistributor(title, locations) || nearDistributor(title, locations);
  const holderLoc = locations.find(l => l.code === holderCode);
  const so = officers.find(o => [o.name, ...(o.aliases || [])].some(n => { const k = normName(n); return k.length >= 3 && h.includes(` ${k} `); }));

  // ---------- type ----------
  let type: FileType | "" = "", sure = true;
  const said = (re: RegExp) => h.match(re)?.[0].trim() || "";
  if (col("so") >= 0) { type = "SO"; reasons.push("it has a sales officer column"); }
  else if (SO_HEAD.test(h)) { type = "SO"; reasons.push(`the heading or file name says "${said(SO_HEAD)}"`); }
  else if (COUNT_HEAD.test(h)) { type = "COUNT"; reasons.push(`the heading or file name says "${said(COUNT_HEAD)}"`); }
  else if (so && !holderLoc) { type = "SO"; reasons.push(`the file name mentions your SO ${so.name}`); }
  else if (IN_HEAD.test(h)) { type = "IN"; reasons.push(`the heading or file name says "${said(IN_HEAD)}"`); }
  else if (OUT_HEAD.test(h)) { type = "OUT"; reasons.push(`the heading or file name says "${said(OUT_HEAD)}"`); }
  if (!type) {
    const closing = layout.labels.some(l => CLOSING_LABEL.test(l));
    const supplier = layout.labels.some(l => /supplier|vendor|received from|purchased from/.test(l));
    const p = vtypes.filter(v => /purchase|receipt|grn|inward/.test(v)).length;
    const s = vtypes.filter(v => /sale|delivery|dispatch|despatch|challan|transfer|outward|issue/.test(v)).length;
    if (closing && !parties.length) { type = "COUNT"; reasons.push("it has a closing stock column and no party column"); }
    else if (supplier) { type = "IN"; reasons.push("it has a supplier column"); }
    else if (p > s) { type = "IN"; reasons.push("most voucher types are purchases / receipts"); }
    else if (s > p) { type = "OUT"; reasons.push("most voucher types are sales / dispatches"); }
    else if (parties.length) { type = "OUT"; sure = false; reasons.push("it lists a party on each line, like a sales or dispatch register"); }
    else if (closing) { type = "COUNT"; reasons.push("it has a closing stock column"); }
    else { type = "COUNT"; sure = false; reasons.push("it only has products and quantities, so it's read as a stock count"); }
  }

  // ---------- whose stock ----------
  let holder = type === "SO" ? (holderLoc?.kind === "GODOWN" ? "" : holderCode) : holderCode;
  if (holder && holderLoc) reasons.push(`${KIND_LABEL[holderLoc.kind].toLowerCase()} "${holderLoc.name}" appears in the heading or file name`);
  else if (type === "OUT" && parties.length) {
    // A dispatch register whose parties are your own super stockists / distributors.
    const partyLocs = parties.map(p => matchDistributor(p, locations)).filter((l): l is Distributor => !!l);
    const godowns = locations.filter(l => l.kind === "GODOWN");
    if (partyLocs.length >= parties.length * 0.5) {
      const parents = new Set(partyLocs.map(l => l.parent_id));
      const oneSS = partyLocs.every(l => l.kind === "DISTRIBUTOR") && parents.size === 1 ? locations.find(l => l.id === [...parents][0]) : undefined;
      if (oneSS) { holder = oneSS.code; sure = false; reasons.push(`every party is a distributor under ${oneSS.name}, so this looks like their dispatch list`); }
      else if (godowns.length === 1) { holder = godowns[0].code; reasons.push(`the parties are your super stockists / distributors, so this is a dispatch from ${godowns[0].name}`); }
    }
  }
  if (!holder && col("distributor") >= 0 && type !== "SO") reasons.push("each row names its location");
  if (type === "SO" && so) reasons.push(`SO ${so.name} is named in the heading or file name`);
  return { type, sure, holder, so: so?.code || "", reasons };
}
