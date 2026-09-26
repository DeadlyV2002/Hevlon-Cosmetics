import { useEffect, useState } from "react";

const TYPES = new Set(["text", "search", "email", "tel", "number", "url", ""]);
const clearable = (el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement =>
  // Not in table cells (stock rows): the boxes there are small and the button would cover the figure.
  (el instanceof HTMLInputElement && TYPES.has(el.type) && !el.readOnly && !el.disabled && !el.closest(".noclear, td") && el.getBoundingClientRect().width >= 120) || el instanceof HTMLTextAreaElement;

/** A ✕ inside the text box being typed in that empties it, for every box in the app. */
export default function ClearButton() {
  const [box, setBox] = useState<{ el: HTMLInputElement | HTMLTextAreaElement; top: number; left: number; h: number } | null>(null);
  useEffect(() => {
    const place = (el: HTMLInputElement | HTMLTextAreaElement | null) => {
      if (!el || !el.value || !el.isConnected) return setBox(null);
      const r = el.getBoundingClientRect();
      if (!r.width) return setBox(null);
      setBox({ el, top: r.top, left: r.right - 26, h: Math.min(r.height, 40) });
    };
    const current = () => (clearable(document.activeElement) ? document.activeElement : null);
    const update = () => place(current());
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", () => setTimeout(update, 0));
    document.addEventListener("input", update, true);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      document.removeEventListener("focusin", update); document.removeEventListener("input", update, true);
      window.removeEventListener("scroll", update, true); window.removeEventListener("resize", update);
    };
  }, []);
  if (!box) return null;
  function clear(e: React.PointerEvent) {
    e.preventDefault();
    const el = box!.el;
    // Set the value the way typing would, so the page's own change handlers run.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.focus();
    setBox(null);
  }
  return <button type="button" className="clearbtn" aria-label="Clear this box" title="Clear"
    style={{ top: box.top + box.h / 2 - 11, left: box.left }} onPointerDown={clear} onPointerEnter={() => {}}>✕</button>;
}
