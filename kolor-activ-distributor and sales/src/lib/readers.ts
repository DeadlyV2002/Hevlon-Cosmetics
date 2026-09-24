// Browser-side file reading. Every format ends up as a Table (one or more grids)
// that parse.ts turns into rows.
import * as XLSX from "xlsx";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.js?url";
import {
  Table, Grid, Cell, workbookToTable, linesToGrid, heuristicGrid, detectLayout,
  treeToGrid, decodeText, cleanXml, domToNode, jsonToNode,
} from "./parse";

export const ACCEPT = ".xlsx,.xls,.xlsm,.xlsb,.ods,.csv,.tsv,.txt,.asc,.prn,.xml,.json,.html,.htm,.pdf,.png,.jpg,.jpeg,.webp";

export async function fileHash(file: File): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, "0")).join("");
}

const single = (grid: Grid, source: string, note?: string, fillDown = true): Table => ({ sheets: [{ name: source, grid }], source, note, fillDown });

function fromXml(text: string): Table {
  const doc = new DOMParser().parseFromString(cleanXml(text), "text/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("This XML file is damaged or not a Tally export.");
  const { grid, kind } = treeToGrid(domToNode(doc.documentElement));
  if (grid.length < 2) throw new Error("No stock items or inventory lines found in this XML file.");
  return single(grid, kind, undefined, false);
}

function fromJson(text: string): Table {
  const { grid, kind } = treeToGrid(jsonToNode(JSON.parse(text)));
  if (grid.length < 2) throw new Error("No stock items or inventory lines found in this JSON file.");
  return single(grid, kind.replace("XML", "JSON"), undefined, false);
}

function fromText(text: string, source: string): Table {
  const t = text.trimStart();
  if (t.startsWith("<?xml") || t.startsWith("<ENVELOPE")) return fromXml(text);
  if (t.startsWith("{") || t.startsWith("[")) return fromJson(text);
  if (/<table/i.test(t)) return workbookToTable(XLSX.read(text, { type: "string" }), source);
  const table = workbookToTable(XLSX.read(text, { type: "string", raw: true }), source);
  // Fixed-width reports (Tally ASCII, .prn) come through as a single column.
  const g = table.sheets[0]?.grid || [];
  const oneCol = g.length > 0 && g.filter(r => r.filter(c => String(c ?? "").trim()).length > 1).length < g.length * 0.3;
  if (oneCol) return single(linesToGrid(text.split(/\r?\n/)), "Text report");
  return table;
}

/** Rebuilds table rows from PDF text positions: same line = same y, a wide gap = new cell. */
async function pdfGrids(file: File, onProgress: (m: string) => void): Promise<{ grid: Grid; lines: string[]; pdf: any }> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
  // isEvalSupported:false closes the pdf.js font-eval hole (CVE-2024-4367).
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false }).promise;
  const grid: Grid = [], lines: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress(`Reading PDF page ${i} of ${pdf.numPages}…`);
    const page = await pdf.getPage(i), content = await page.getTextContent();
    const byY = new Map<number, { x: number; w: number; s: string }[]>();
    for (const it of content.items as any[]) {
      if (!it.str?.trim()) continue;
      const y = Math.round(it.transform[5] / 3) * 3;
      if (!byY.has(y)) byY.set(y, []);
      byY.get(y)!.push({ x: it.transform[4], w: it.width || 0, s: it.str });
    }
    for (const [, items] of [...byY.entries()].sort((a, b) => b[0] - a[0])) {
      items.sort((a, b) => a.x - b.x);
      const cells: string[] = [];
      let cur = "", end = -Infinity;
      for (const it of items) {
        const charW = it.s.length ? it.w / it.s.length : 5;
        if (cur && it.x - end > Math.max(8, charW * 1.8)) { cells.push(cur.trim()); cur = ""; }
        cur += (cur && it.x - end > charW * 0.3 ? " " : "") + it.s;
        end = it.x + it.w;
      }
      if (cur.trim()) cells.push(cur.trim());
      grid.push(cells);
      lines.push(cells.join("  "));
    }
  }
  return { grid, lines, pdf };
}

async function ocrCanvasOrImage(sources: (HTMLCanvasElement | File)[], onProgress: (m: string) => void): Promise<string[]> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");
  const lines: string[] = [];
  try {
    for (let i = 0; i < sources.length; i++) {
      onProgress(`Reading scanned page ${i + 1} of ${sources.length} (OCR)…`);
      const res = await worker.recognize(sources[i]);
      lines.push(...res.data.text.split(/\r?\n/));
    }
  } finally { await worker.terminate(); }
  return lines;
}

function fromLines(lines: string[], source: string): Table {
  const g = linesToGrid(lines);
  if (detectLayout(g, "INPUT").headerRow >= 0) return single(g, source);
  const h = heuristicGrid(lines);
  return single(h, source, h.length > 1 ? "No column headings found, so rows were guessed from the text. Check every row." : undefined);
}

export async function readAnyFile(file: File, onProgress: (m: string) => void = () => {}): Promise<Table> {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  onProgress(`Reading ${file.name}…`);

  if (["xlsx", "xls", "xlsm", "xlsb", "ods"].includes(ext)) {
    return workbookToTable(XLSX.read(await file.arrayBuffer(), { type: "array" }), "Excel");
  }
  if (["png", "jpg", "jpeg", "webp"].includes(ext) || file.type.startsWith("image/")) {
    return fromLines(await ocrCanvasOrImage([file], onProgress), "Photo (OCR)");
  }
  if (ext === "pdf") {
    const { grid, lines, pdf } = await pdfGrids(file, onProgress);
    const textLen = lines.join("").length;
    if (textLen > 40 && detectLayout(grid, "INPUT").headerRow >= 0) return single(grid, "PDF");
    if (textLen > 40) { const t = fromLines(lines, "PDF"); if (t.sheets[0].grid.length > 1) return t; }
    // Scanned PDF: render pages and OCR them.
    const canvases: HTMLCanvasElement[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i), viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      await page.render({ canvasContext: ctx, viewport }).promise;
      canvases.push(canvas);
    }
    return fromLines(await ocrCanvasOrImage(canvases, onProgress), "Scanned PDF (OCR)");
  }
  const text = decodeText(await file.arrayBuffer());
  if (ext === "xml") return fromXml(text);
  if (ext === "json") return fromJson(text);
  if (ext === "html" || ext === "htm") return workbookToTable(XLSX.read(text, { type: "string" }), "HTML");
  return fromText(text, ext.toUpperCase() || "Text");
}

export type { Cell };
