import { ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/** A dialog centred in the window, whatever its size or scroll position. */
export default function Modal({ title, subtitle, onClose, children, wide, actions, className = "", panelRef }: {
  title: ReactNode; subtitle?: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; actions?: ReactNode; className?: string;
  panelRef?: React.RefObject<HTMLDivElement>;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.fullscreenElement) onClose(); };
    document.addEventListener("keydown", esc);
    document.body.classList.add("noscroll");
    return () => { document.removeEventListener("keydown", esc); document.body.classList.remove("noscroll"); };
  }, []);
  return createPortal(<div className={`overlay modalroot ${className}`} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={`overlaypanel dialog${wide ? " wide" : ""}`} role="dialog" aria-modal="true" ref={panelRef}>
      <header><div><h2>{title}</h2>{subtitle && <p className="subtitle">{subtitle}</p>}</div>
        <div className="actions">{actions}<button className="secondary" ref={close} aria-label="Close" onClick={onClose}>✕</button></div></header>
      <div className="dialogbody">{children}</div>
    </div>
  </div>, document.body);
}
