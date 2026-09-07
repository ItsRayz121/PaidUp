"use client";

// A real in-app modal that stands in for window.prompt() (admin rebuild,
// Phase F — CLAUDE.md's Phase A entry named this the one thing left after
// toasts replaced window.alert: "input prompts stay window.prompt until
// Phase F"). A native browser prompt is unstyled, blocks the whole tab, and
// cannot be multi-line — this is the same imperative call shape
// (`await prompt(message)` where window.prompt was `window.prompt(message)`)
// but rendered as a real, dismissable, on-brand dialog.
//
// Mounted once, in staff/page.tsx, alongside <ToastProvider>.
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

export type PromptOptions = {
  /** The instruction shown above the input — window.prompt's own `message` arg. */
  message: string;
  /** Optional heading above the message. Defaults to a generic title. */
  title?: string;
  defaultValue?: string;
  placeholder?: string;
  /** A textarea instead of a single-line input, for a longer written reason. */
  multiline?: boolean;
  confirmLabel?: string;
  /** Red confirm button, for a destructive action (e.g. reject/suspend). */
  danger?: boolean;
};

/** Resolves to the typed value, or null if the user cancelled — same contract
 *  window.prompt() has, so `if (!value) return;` call sites need no change. */
export type PromptApi = (opts: PromptOptions | string) => Promise<string | null>;

const noop: PromptApi = async () => null;
const Ctx = createContext<PromptApi>(noop);

/** Prompt from anywhere under <PromptProvider>. A no-op (always null) outside it. */
export function usePrompt(): PromptApi {
  return useContext(Ctx);
}

type ActivePrompt = { opts: PromptOptions; resolve: (v: string | null) => void };

export function PromptProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActivePrompt | null>(null);
  const [value, setValue] = useState("");
  // Only one prompt is ever on screen at a time — a second call while one is
  // open resolves the first as cancelled rather than stacking dialogs.
  const pending = useRef<ActivePrompt | null>(null);

  const prompt = useCallback<PromptApi>((raw) => {
    const opts: PromptOptions = typeof raw === "string" ? { message: raw } : raw;
    return new Promise<string | null>((resolve) => {
      pending.current?.resolve(null);
      const entry: ActivePrompt = { opts, resolve };
      pending.current = entry;
      setActive(entry);
      setValue(opts.defaultValue ?? "");
    });
  }, []);

  function close(result: string | null) {
    active?.resolve(result);
    pending.current = null;
    setActive(null);
  }

  return (
    <Ctx.Provider value={prompt}>
      {children}
      {active && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          onClick={() => close(null)}
        >
          <div
            role="dialog" aria-modal="true"
            className="w-full max-w-sm rounded-xl border-2 border-line-strong bg-card p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {active.opts.title && <h3 className="mb-1 font-bold text-brand-ink">{active.opts.title}</h3>}
            <p className="mb-3 whitespace-pre-wrap text-sm text-muted">{active.opts.message}</p>
            {active.opts.multiline ? (
              <textarea
                autoFocus rows={3} value={value} placeholder={active.opts.placeholder}
                onChange={(e) => setValue(e.target.value)}
                className="w-full rounded-md border border-line bg-bg p-2 text-sm outline-none focus:border-brand"
              />
            ) : (
              <input
                autoFocus type="text" value={value} placeholder={active.opts.placeholder}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") close(value); if (e.key === "Escape") close(null); }}
                className="w-full rounded-md border border-line bg-bg p-2 text-sm outline-none focus:border-brand"
              />
            )}
            <div className="mt-3 flex justify-end gap-2">
              <button onClick={() => close(null)}
                className="rounded-md bg-brand-tint px-3 py-1.5 text-xs font-semibold text-brand">
                Cancel
              </button>
              <button onClick={() => close(value)}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold text-white ${
                  active.opts.danger ? "bg-danger" : "bg-brand"
                }`}>
                {active.opts.confirmLabel ?? "OK"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
