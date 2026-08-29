"use client";

// Toasts for the staff console (admin rebuild, Phase A). Replaces the panel's
// scattered window.alert() calls — an action result should confirm itself
// without stopping the page. Mounted once, in staff/page.tsx.
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

type Kind = "ok" | "err" | "info";
type Toast = { id: number; kind: Kind; text: string };

type ToastApi = {
  ok: (text: string) => void;
  err: (text: string) => void;
  info: (text: string) => void;
};

const noop: ToastApi = { ok: () => {}, err: () => {}, info: () => {} };
const Ctx = createContext<ToastApi>(noop);

/** Toast from anywhere under <ToastProvider>. Safe (no-op) outside it. */
export function useToast(): ToastApi {
  return useContext(Ctx);
}

const KIND_CLASS: Record<Kind, string> = {
  ok: "border-success/40 bg-success-tint text-success",
  err: "border-danger/40 bg-danger-tint text-danger",
  info: "border-brand/40 bg-brand-tint text-brand",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);

  const push = useCallback((kind: Kind, text: string) => {
    const id = ++seq.current;
    setItems((xs) => [...xs, { id, kind, text }]);
    setTimeout(() => setItems((xs) => xs.filter((t) => t.id !== id)), kind === "err" ? 6000 : 3500);
  }, []);

  const api: ToastApi = {
    ok: (t) => push("ok", t),
    err: (t) => push("err", t),
    info: (t) => push("info", t),
  };

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4">
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto max-w-md rounded-lg border px-4 py-2.5 text-sm font-semibold shadow-lg ${KIND_CLASS[t.kind]}`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
