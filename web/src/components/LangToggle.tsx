"use client";

import { LOCALES, useI18n } from "@/lib/i18n";

// Two-button language switch (English / اردو). Icon-free, label-first — the label
// is written in its own script so a user recognises their language instantly.
export function LangToggle({ className = "" }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <div className={`inline-flex items-center gap-1 ${className}`} role="group" aria-label={t("lang.label")}>
      {LOCALES.map((l) => {
        const active = l.id === locale;
        return (
          <button
            key={l.id}
            type="button"
            onClick={() => setLocale(l.id)}
            aria-pressed={active}
            className={`rounded-full px-3 py-1 text-sm font-semibold ${
              active ? "bg-brand text-white" : "border border-line text-muted"
            }`}
          >
            {l.label}
          </button>
        );
      })}
    </div>
  );
}
