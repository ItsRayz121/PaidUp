"use client";

// Lightweight client-side localization (Phase 3, Urdu first — DESIGN_BRIEF /
// PROJECT_SPEC "Local-language UI (Urdu first)"). The official Next app-router
// i18n uses /[lang] sub-paths, but this app is a client-rendered SPA with
// localStorage auth and a user-chosen language *preference* (not a per-URL
// locale), so a client dictionary + context fits far better and needs no route
// restructure. The internationalization guide notes localization "works the
// same with any web application". Urdu is right-to-left, so switching also flips
// document direction.
import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type Locale = "en" | "ur";
export const LOCALES: { id: Locale; label: string; dir: "ltr" | "rtl" }[] = [
  { id: "en", label: "English", dir: "ltr" },
  { id: "ur", label: "اردو", dir: "rtl" },
];

// Translation keys. Keep flat and simple — one key per user-facing string. Urdu
// copy follows the same simple-English-equivalent rule: short, plain, no jargon.
const dict: Record<Locale, Record<string, string>> = {
  en: {
    "nav.home": "Home",
    "nav.tasks": "Tasks",
    "nav.wallet": "Wallet",
    "nav.refer": "Refer",
    "nav.help": "Help",
    "tasks.title": "Ways to earn",
    "tasks.subtitle": "Finish a task and get points.",
    "tasks.disclosure":
      "These are sponsored offers from our partners. We tell you who gives the reward before you start.",
    "tasks.empty.title": "No tasks right now for {country}",
    "tasks.empty.body":
      "Check back soon. New tasks come every day. Meanwhile, invite a friend and earn more.",
    "common.yourCountry": "your country",
    "lang.label": "Language",
  },
  ur: {
    "nav.home": "ہوم",
    "nav.tasks": "کام",
    "nav.wallet": "بٹوہ",
    "nav.refer": "دعوت دیں",
    "nav.help": "مدد",
    "tasks.title": "کمانے کے طریقے",
    "tasks.subtitle": "ایک کام مکمل کریں اور پوائنٹس پائیں۔",
    "tasks.disclosure":
      "یہ ہمارے شراکت داروں کی طرف سے سپانسر شدہ آفرز ہیں۔ شروع کرنے سے پہلے ہم آپ کو بتاتے ہیں کہ انعام کون دے رہا ہے۔",
    "tasks.empty.title": "{country} کے لیے ابھی کوئی کام نہیں ہے",
    "tasks.empty.body":
      "تھوڑی دیر بعد دوبارہ دیکھیں۔ نئے کام روزانہ آتے ہیں۔ اسی دوران، کسی دوست کو دعوت دیں اور زیادہ کمائیں۔",
    "common.yourCountry": "آپ کا ملک",
    "lang.label": "زبان",
  },
};

const STORAGE_KEY = "paidup.locale";

function localeDir(l: Locale): "ltr" | "rtl" {
  return LOCALES.find((x) => x.id === l)?.dir ?? "ltr";
}

type Ctx = {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, vars?: Record<string, string>) => string;
};

const I18nContext = createContext<Ctx | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  // Start from "en" so server and first client render agree (no hydration
  // mismatch); the stored preference is applied in an effect right after mount.
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    const saved = (typeof window !== "undefined" && window.localStorage.getItem(STORAGE_KEY)) as Locale | null;
    if (saved && (saved === "en" || saved === "ur")) setLocaleState(saved);
  }, []);

  // Reflect the language onto <html> so the browser (and CSS) get lang + text
  // direction right. Urdu flips the whole app to RTL.
  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute("lang", locale);
    el.setAttribute("dir", localeDir(locale));
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      window.localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* private mode — preference just won't persist */
    }
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string>) => {
      let s = dict[locale][key] ?? dict.en[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
      return s;
    },
    [locale],
  );

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n(): Ctx {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}
