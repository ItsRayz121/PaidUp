"use client";

// Telegram's Login Widget, self-configuring: which bot (and whether to render
// at all) comes from GET /auth/telegram/config, so turning Telegram on is a
// backend env change with no web redeploy. Used on /login (sign in) and in the
// Profile connect card (link to an existing account) — the caller decides what
// to do with the signed payload; the backend re-verifies it either way.
//
// The widget script comes from telegram.org, which is BLOCKED on many local
// networks. Everything here (the `before` slot, the widget box, the caller via
// onReady) therefore stays hidden until the script has ACTUALLY loaded — a
// blocked network shows nothing at all, never a divider or card with a hole
// where the button should be. This is an optional extra path, never the only
// one, so vanishing quietly is correct.
import { useEffect, useRef, useState } from "react";
import { fetchTelegramConfig } from "@/lib/api";

export function TelegramWidget({ onAuth, before, onReady }: {
  onAuth: (u: Record<string, unknown>) => void;
  // Rendered above the widget ONLY once the widget is really visible.
  before?: React.ReactNode;
  // Fired when the script loaded — lets a wrapping card unhide itself.
  onReady?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [bot, setBot] = useState("");
  const [loaded, setLoaded] = useState(false);
  // Kept in a ref so an inline `onReady` arrow doesn't remount the widget on
  // every parent render.
  const onReadyRef = useRef(onReady);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);

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
    s.onload = () => { setLoaded(true); onReadyRef.current?.(); };
    s.onerror = () => setLoaded(false); // blocked host — stay hidden
    el.appendChild(s);
    return () => { el.innerHTML = ""; };
  }, [bot, onAuth]);

  if (!bot) return null;
  return (
    <div className={loaded ? undefined : "hidden"}>
      {before}
      <div ref={box} className="flex justify-center" />
    </div>
  );
}
