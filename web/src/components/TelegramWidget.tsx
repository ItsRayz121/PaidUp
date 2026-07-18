"use client";

// Telegram's Login Widget, self-configuring: which bot (and whether to render
// at all) comes from GET /auth/telegram/config, so turning Telegram on is a
// backend env change with no web redeploy. Used on /login (sign in) and in the
// Profile connect card (link to an existing account) — the caller decides what
// to do with the signed payload; the backend re-verifies it either way.
//
// NOTE the widget script comes from telegram.org, which is blocked on many
// local networks — it may quietly fail to render. That is acceptable here:
// this is an optional extra button, never the only path.
import { useEffect, useRef, useState } from "react";
import { fetchTelegramConfig } from "@/lib/api";

// `before` renders above the widget ONLY once the widget is really going to
// show — so a divider or heading never sits above nothing.
export function TelegramWidget({ onAuth, before }: {
  onAuth: (u: Record<string, unknown>) => void;
  before?: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [bot, setBot] = useState("");

  useEffect(() => {
    let gone = false;
    fetchTelegramConfig()
      .then((c) => { if (!gone && c.enabled && c.botUsername) setBot(c.botUsername); })
      .catch(() => { /* API unreachable — the button just stays hidden */ });
    return () => { gone = true; };
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!bot || !el) return;
    (window as unknown as { onTelegramAuth?: (u: Record<string, unknown>) => void }).onTelegramAuth = onAuth;
    const s = document.createElement("script");
    s.src = "https://telegram.org/js/telegram-widget.js?22";
    s.async = true;
    s.setAttribute("data-telegram-login", bot);
    s.setAttribute("data-size", "large");
    s.setAttribute("data-radius", "12");
    s.setAttribute("data-request-access", "write");
    s.setAttribute("data-onauth", "onTelegramAuth(user)");
    el.appendChild(s);
    return () => { el.innerHTML = ""; };
  }, [bot, onAuth]);

  if (!bot) return null;
  return (
    <>
      {before}
      <div ref={box} className="flex justify-center" />
    </>
  );
}
