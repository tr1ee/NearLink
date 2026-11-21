import type { ReactNode } from "react";
import { X, LoaderCircle } from "lucide-react";
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={"modal " + (wide ? "wide" : "")}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function Busy({ label = "正在加载" }: { label?: string }) {
  return (
    <div className="busy">
      <LoaderCircle className="spin" size={21} />
      <span>{label}</span>
    </div>
  );
}
export function StatusDot({ online }: { online: boolean }) {
  return <span className={"status-dot " + (online ? "online" : "")} />;
}
export function ErrorNote({ text }: { text?: string }) {
  return text ? (
    <div role="alert" className="error-note">
      {text}
    </div>
  ) : null;
}
