"use client";

// The look picker on /profile/settings. Two options, matching the two design
// directions the founder asked to see built:
//   • Deep Vault    — the dark "Wallet look" — THE DEFAULT (founder, 2026-08-30)
//   • Charged Light  — the original light shell, now the opt-out
//
// Purely a colour choice, stored on the device (see lib/theme.tsx). No balance,
// copy, or guardrail changes with it. Reduced-motion and screen readers are
// handled by the underlying radio semantics.
import { CheckIcon } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { useTheme, type Theme } from "@/lib/theme";

type Opt = { id: Theme; titleKey: string; descKey: string; swatch: string[] };

const OPTIONS: Opt[] = [
  {
    id: "vault",
    titleKey: "settings.theme.vault",
    descKey: "settings.theme.vault.desc",
    // page ground, card, hero teal, marigold
    swatch: ["#0b1517", "#0e2429", "#16bdb6", "#f5a623"],
  },
  {
    id: "light",
    titleKey: "settings.theme.light",
    descKey: "settings.theme.light.desc",
    swatch: ["#eef5f5", "#ffffff", "#0d5c63", "#f2a417"],
  },
];

export function ThemeToggle() {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();

  return (
    <div role="radiogroup" aria-label={t("settings.theme")} className="space-y-2.5">
      {OPTIONS.map((o) => {
        const selected = theme === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setTheme(o.id)}
            className={`flex w-full items-center gap-3 rounded-2xl border p-4 text-left transition ${
              selected
                ? "border-brand bg-brand-tint/50"
                : "border-line bg-card active:brightness-95"
            }`}
          >
            <span
              className="flex shrink-0 overflow-hidden rounded-xl border border-line"
              aria-hidden="true"
            >
              {o.swatch.map((c, i) => (
                <span key={i} style={{ background: c, width: 14, height: 40 }} />
              ))}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold text-brand-ink">{t(o.titleKey)}</span>
              <span className="block text-sm text-muted">{t(o.descKey)}</span>
            </span>
            {selected && <CheckIcon size={20} className="shrink-0 text-brand" />}
          </button>
        );
      })}
    </div>
  );
}
