// Export, print and present: charts as PNG images, a report on paper, a report full screen.

const STYLE_PROPS = ["fill", "stroke", "stroke-width", "stroke-dasharray", "opacity", "font-size", "font-weight", "font-family", "text-anchor", "dominant-baseline"];

/** Saves every chart (svg) inside `root` as one PNG, with a title above it. */
export async function exportPng(root: HTMLElement, fileName: string, title = "") {
  const svgs = [...root.querySelectorAll("svg")].filter(s => s.getBoundingClientRect().width > 50);
  if (!svgs.length) throw new Error("There's no chart on screen to export.");
  const scale = 2, pad = 24, gap = 24, titleH = title ? 40 : 0;
  const boxes = svgs.map(s => s.getBoundingClientRect());
  const W = Math.max(...boxes.map(b => b.width)) + pad * 2, H = boxes.reduce((a, b) => a + b.height + gap, 0) + pad * 2 + titleH;
  const canvas = document.createElement("canvas");
  canvas.width = W * scale; canvas.height = H * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, H);
  if (title) { ctx.fillStyle = "#0f172a"; ctx.font = "600 18px Inter, system-ui, sans-serif"; ctx.fillText(title, pad, pad + 18); }
  let y = pad + titleH;
  for (let i = 0; i < svgs.length; i++) {
    const img = await svgImage(svgs[i], boxes[i].width, boxes[i].height);
    ctx.drawImage(img, pad, y, boxes[i].width, boxes[i].height);
    y += boxes[i].height + gap;
  }
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = `${fileName.replace(/[^\w\- ]+/g, "").trim() || "chart"}.png`;
  a.click();
}

/** Copies the computed colours and fonts into the svg so it looks the same outside the page. */
function svgImage(svg: SVGSVGElement, w: number, h: number): Promise<HTMLImageElement> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const src = [svg, ...svg.querySelectorAll("*")], dst = [clone, ...clone.querySelectorAll("*")];
  src.forEach((el, i) => {
    const cs = getComputedStyle(el as Element);
    (dst[i] as SVGElement).setAttribute("style", STYLE_PROPS.map(p => `${p}:${cs.getPropertyValue(p)}`).join(";"));
  });
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(w)); clone.setAttribute("height", String(h));
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
  return new Promise((ok, fail) => { const img = new Image(); img.onload = () => ok(img); img.onerror = () => fail(new Error("Couldn't draw the chart.")); img.src = url; });
}

/** Prints only `el` (the rest of the page is hidden while printing). */
export function printOnly(el: HTMLElement) {
  el.classList.add("printarea");
  document.body.classList.add("printing");
  const done = () => { el.classList.remove("printarea"); document.body.classList.remove("printing"); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  window.print();
  setTimeout(done, 1500);
}

/** Shows `el` full screen, or leaves full screen. */
export async function togglePresent(el: HTMLElement) {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await el.requestFullscreen();
}
