"use client";

// The look of the earner app — a per-device choice between two design
// directions the founder asked to see built:
//
//   "vault"  — Deep Vault. A full dark skin ("the Wallet look"): near-black
//              teal ground, glowing balance, live mining reactor. THE DEFAULT
//              (founder, 2026-08-30, after reviewing the redesign mockup).
//   "light"  — Charged Light. The original light shell with the deep-teal hero
//              and mining panels. Now the OPT-OUT — a user picks it in
//              /profile/settings and we store that choice.
//
// ⚠️ Making vault the default reopens the documented "app is light-only" call
// (DESIGN_BRIEF / CLAUDE.md). It changes NOTHING about the ledgers, the copy,
// or any guardrail — only the colour tokens (see the [data-theme="vault"]
// block in globals.css) — and light is one tap away in settings.
//
// HOW THE NO-FLASH BIT WORKS: a tiny blocking script in layout.tsx reads the
// same localStorage key and sets data-theme on <html> BEFORE first paint, so a
// vault user never sees a white flash. This provider is the React-side mirror:
// it exposes the current value + a setter, and keeps <html> and storage in step
// when the user changes it in settings.

import {
  createContext, useCallback, useContext, useEffect, useState,
} from "react";

export type Theme = "light" | "vault";

const STORAGE_KEY = "rozipay-theme";

// Shared with the blocking script in layout.tsx — keep the key in sync.
export const THEME_STORAGE_KEY = STORAGE_KEY;

// Vault is the default: anything other than a stored, explicit "light" resolves
// to "vault". Matches the blocking script in layout.tsx.
function readStored(): Theme {
  if (typeof window === "undefined") return "vault";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "light" ? "light" : "vault";
  } catch {
    return "vault";
  }
}

function apply(theme: Theme) {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  if (theme === "vault") el.dataset.theme = "vault";
  else delete el.dataset.theme;
}

type Ctx = { theme: Theme; setTheme: (t: Theme) => void };
const ThemeContext = createContext<Ctx>({ theme: "light", setTheme: () => {} });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Server render + first client render must match the prerendered HTML (which
  // carries no data-theme — the blocking script in layout.tsx sets it), so the
  // initial value is always "light". The effect below reconciles to the real
  // choice (now "vault" unless the user stored "light"); the blocking script
  // already painted the right skin, so this is only React state catching up.
  const [theme, setThemeState] = useState<Theme>("light");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setThemeState(readStored());
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    apply(t);
    try {
      window.localStorage.setItem(STORAGE_KEY, t);
    } catch {
      // Private mode / storage disabled — the choice just won't persist.
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): Ctx {
  return useContext(ThemeContext);
}
