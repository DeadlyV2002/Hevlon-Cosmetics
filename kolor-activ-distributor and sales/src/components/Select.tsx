// Dropdowns drawn by the page itself. Native <select> and <datalist> popups are drawn by the
// operating system and open in the wrong place inside embedded or split windows; these open right
// under (or above) their field in any window size. <Select> takes the same <option> children as <select>.
import { Children, Fragment, InputHTMLAttributes, ReactElement, ReactNode, forwardRef, isValidElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Opt { value: string; label: string; hint?: string; disabled?: boolean; group?: string }
const text = (n: ReactNode): string => Children.toArray(n).map(x => (typeof x === "string" || typeof x === "number" ? String(x) : isValidElement(x) ? text((x.props as any).children) : "")).join("");
function collect(children: ReactNode, out: Opt[] = [], group?: string): Opt[] {
  Children.forEach(children, c => {
    if (!isValidElement(c)) return;
    const el = c as ReactElement<any>;
    if (el.type === Fragment) collect(el.props.children, out, group);
    else if (el.type === "optgroup") collect(el.props.children, out, el.props.label);
    else if (el.type === "option") out.push({ value: String(el.props.value ?? text(el.props.children)), label: text(el.props.children), disabled: el.props.disabled, group });
  });
  return out;
}
/** A change event shaped like the native one, so existing handlers keep working. */
const fake = (value: string) => ({ target: { value }, currentTarget: { value } });

/** Keeps a popup attached to its field while the page scrolls or the window changes size. */
function usePlace(anchor: React.RefObject<HTMLElement>, open: boolean, rows: number) {
  const [pos, setPos] = useState<React.CSSProperties>({});
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const vw = document.documentElement.clientWidth, vh = window.innerHeight;
      const want = Math.min(300, rows * 36 + 12), below = vh - r.bottom - 8, above = r.top - 8;
      const up = below < want && above > below;
      const width = Math.min(Math.max(r.width, 260), vw - 16);
      setPos({ left: Math.max(8, Math.min(r.left, vw - width - 8)), width, maxHeight: Math.max(120, Math.min(300, up ? above : below)),
        ...(up ? { bottom: vh - r.top + 4 } : { top: r.bottom + 4 }) });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [open, rows]);
  return pos;
}
function useOutside(open: boolean, refs: React.RefObject<HTMLElement>[], close: () => void) {
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!refs.some(r => r.current?.contains(e.target as Node))) close(); };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [open]);
}

function List({ opts, active, setActive, pick, pos, listRef, current }: {
  opts: Opt[]; active: number; setActive: (i: number) => void; pick: (o: Opt) => void; pos: React.CSSProperties; listRef: React.RefObject<HTMLDivElement>; current?: string;
}) {
  useEffect(() => { listRef.current?.querySelector(".opt.active")?.scrollIntoView({ block: "nearest" }); }, [active]);
  // Stop clicks here reaching dialogs that close when clicked outside their panel.
  return createPortal(<div className="popup" ref={listRef} style={pos} role="listbox" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
    {opts.map((o, i) => <Fragment key={`${o.group}|${o.value}|${i}`}>
      {o.group && o.group !== opts[i - 1]?.group && <div className="optgroup">{o.group}</div>}
      <div role="option" aria-selected={o.value === current} aria-disabled={o.disabled}
        className={`opt${i === active ? " active" : ""}${o.value === current ? " on" : ""}${o.disabled ? " off" : ""}`}
        onPointerEnter={() => setActive(i)} onMouseDown={e => e.preventDefault()} onClick={() => !o.disabled && pick(o)}>
        {o.label || " "}{o.hint && <small>{o.hint}</small>}
      </div></Fragment>)}
    {!opts.length && <div className="opt off">No matches</div>}
  </div>, document.body);
}

interface SelectProps {
  value?: string | number; onChange?: (e: any) => void; children?: ReactNode; disabled?: boolean;
  className?: string; id?: string; title?: string; "aria-label"?: string; name?: string;
}
export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select({ value, onChange, children, disabled, className, ...rest }, ref) {
  const opts = collect(children);
  const [open, setOpen] = useState(false), [q, setQ] = useState(""), [active, setActive] = useState(0);
  const btn = useRef<HTMLButtonElement | null>(null), list = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const cur = String(value ?? "");
  const sel = opts.find(o => o.value === cur) ?? (value === undefined ? opts[0] : undefined);
  const searchable = opts.length > 8;
  const shown = q ? opts.filter(o => `${o.label} ${o.group || ""}`.toLowerCase().includes(q.toLowerCase())) : opts;
  const pos = usePlace(btn, open, shown.length + (searchable ? 1.4 : 0));
  useOutside(open, [btn, list, search], () => setOpen(false));
  function show() { if (disabled) return; setQ(""); setActive(Math.max(0, opts.findIndex(o => o.value === cur))); setOpen(true); }
  function pick(o: Opt) { setOpen(false); btn.current?.focus(); if (o.value !== cur) onChange?.(fake(o.value)); }
  function key(e: React.KeyboardEvent) {
    if (!open) { if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); show(); } return; }
    if (e.key === "Escape" || e.key === "Tab") { if (e.key === "Escape") e.stopPropagation(); setOpen(false); btn.current?.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive(Math.min(shown.length - 1, active + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(0, active - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (shown[active] && !shown[active].disabled) pick(shown[active]); }
  }
  return <>
    <button type="button" {...rest} ref={el => { btn.current = el; if (typeof ref === "function") ref(el); else if (ref) ref.current = el; }}
      className={`select${className ? ` ${className}` : ""}${open ? " open" : ""}`} disabled={disabled} aria-haspopup="listbox" aria-expanded={open}
      onClick={() => (open ? setOpen(false) : show())} onKeyDown={key}>
      <span>{sel?.label || " "}</span>
    </button>
    {open && <>
      {searchable && createPortal(<input className="popsearch" ref={search} autoFocus placeholder="Type to search…" value={q} aria-label="Search the list"
        style={{ position: "fixed", left: pos.left, width: pos.width, ...(pos.top !== undefined ? { top: pos.top } : { bottom: pos.bottom }) }}
        onChange={e => { setQ(e.target.value); setActive(0); }} onKeyDown={key} onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} />, document.body)}
      <List opts={shown} active={active} setActive={setActive} pick={pick} listRef={list} current={cur}
        pos={searchable ? { ...pos, ...(pos.top !== undefined ? { top: Number(pos.top) + 42 } : { bottom: Number(pos.bottom) + 42 }), maxHeight: Number(pos.maxHeight) - 42 } : pos} />
    </>}
  </>;
});

/** An input with suggestions, in place of <input list=…> and <datalist>. */
type ComboProps = Omit<InputHTMLAttributes<HTMLInputElement>, "list"> & { options: { value: string; hint?: string }[] };
export function Combo({ options, value, defaultValue, onChange, onKeyDown, ...rest }: ComboProps) {
  const [inner, setInner] = useState(String(defaultValue ?? ""));
  const cur = value !== undefined ? String(value) : inner;
  const [open, setOpen] = useState(false), [active, setActive] = useState(-1);
  const box = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
  const t = cur.trim().toLowerCase();
  const exact = options.some(o => o.value.toLowerCase() === t);
  const shown = (t && !exact ? options.filter(o => `${o.value} ${o.hint || ""}`.toLowerCase().includes(t)) : options).slice(0, 80)
    .map(o => ({ value: o.value, label: o.value, hint: o.hint }));
  const pos = usePlace(box, open, shown.length || 1);
  useOutside(open, [box, list], () => setOpen(false));
  function pick(o: Opt) {
    setInner(o.value); setOpen(false);
    onChange?.(fake(o.value) as any);
  }
  return <>
    <input {...rest} ref={box} autoComplete="off" value={cur} role="combobox" aria-expanded={open}
      onFocus={e => { setOpen(true); rest.onFocus?.(e); }}
      onChange={e => { setInner(e.target.value); setOpen(true); setActive(-1); onChange?.(e); }}
      onKeyDown={e => {
        if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive(Math.min(shown.length - 1, active + 1)); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(0, active - 1)); }
        else if (e.key === "Enter" && open && shown[active]) { e.preventDefault(); pick(shown[active]); }
        else if (e.key === "Escape" && open) { e.stopPropagation(); setOpen(false); }
        else if (e.key === "Tab") setOpen(false);
        onKeyDown?.(e);
      }} />
    {open && shown.length > 0 && !rest.disabled && <List opts={shown} active={active} setActive={setActive} pick={pick} listRef={list} pos={pos} current={cur} />}
  </>;
}
