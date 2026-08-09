"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { XIcon } from "./icons";
import { useI18n } from "@/lib/i18n";

// ONE bottom sheet, used by every screen that opens one.
//
// WHY THIS EXISTS. There were three hand-rolled copies (wallet's Send/Receive
// chooser, the transaction detail sheet, the sponsored-offer disclosure). All
// three set role="dialog" + aria-modal, and none of them did the things those
// two attributes PROMISE a screen reader and a keyboard: focus never entered
// the sheet, Tab walked straight out of it into the page behind, Escape did
// nothing, the background scrolled under the panel, and the only obvious way
// to dismiss was tapping the dark area — which is invisible to anyone who
// cannot see it. A dialog that lies about being modal is worse than a plain
// panel, because assistive tech stops announcing the rest of the page.
//
// What this handles so no caller has to remember it:
//   • focus moves into the sheet on open, and back to the opener on close
//   • Tab is trapped inside the panel
//   • Escape closes
//   • the page behind cannot scroll
//   • a VISIBLE close button, not just the backdrop
//
// Callers supply their own heading and body. Give the heading `pe-10` so it
// clears the close button, and pass its id as `labelledBy` (or pass `label`
// for a sheet with no visible heading).

// The behaviour half, on its own, because one screen needs it without the
// bottom-sheet chrome: TaskFlow's full-screen "Task started" panel had exactly
// the same defect — an opaque overlay covering the page, with Tab still walking
// into the controls hidden behind it.
export function useDialogBehaviour(onClose: () => void) {
  const panel = useRef<HTMLDivElement>(null);

  // onClose is an inline arrow at every call site, so its identity changes on
  // every render. Reading it through a ref keeps the mount effect below at
  // empty deps — otherwise the dialog would re-grab focus, and re-lock the
  // body, on every single re-render of the page underneath.
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = panel.current;
    node?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== "Tab" || !node) return;
      const focusable = node.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === node)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    // Capture phase: the sheet must win Escape even when focus sits in an
    // input inside it that handles keys of its own.
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      // The opener may itself have unmounted while the sheet was open.
      opener?.focus?.();
    };
  }, []);

  return { panel, close };
}

export function BottomSheet({
  labelledBy, label, onClose, children,
}: {
  labelledBy?: string;
  label?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const { panel, close } = useDialogBehaviour(onClose);

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center">
      {/* Tapping outside still closes, but it is out of the tab order: the
          close button in the corner is the keyboard path, and two identical
          "Close" stops is noise for a screen reader. */}
      <button
        aria-hidden
        tabIndex={-1}
        onClick={() => close.current()}
        className="absolute inset-0 bg-black/40"
      />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={label}
        className="animate-rise relative max-h-[90dvh] w-full max-w-[480px] overflow-y-auto rounded-t-3xl bg-card p-5 pb-7 outline-none"
      >
        <button
          onClick={() => close.current()}
          aria-label={t("common.close")}
          className="absolute end-4 top-4 grid h-9 w-9 place-items-center rounded-full bg-brand-tint text-brand active:brightness-95"
        >
          <XIcon size={18} />
        </button>
        <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-line" />
        {children}
      </div>
    </div>
  );
}
