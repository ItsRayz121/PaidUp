"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { LangToggle } from "@/components/LangToggle";
import { ShieldIcon, CheckIcon, ArrowRightIcon, StarIcon } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import {
  register, verifyEmail, login, forgotPassword, resetPassword, loginWithTelegram,
  setSession, getToken, ApiError, type SessionUser,
} from "@/lib/api";

type Mode = "login" | "register" | "verify" | "forgot" | "reset";

const inputClass =
  "w-full rounded-xl border border-line bg-card p-3.5 text-lg text-brand-ink outline-none placeholder:text-muted/60";

// Telegram login is a fallback that stays hidden until a bot username is set
// (and TELEGRAM_BOT_TOKEN on the backend). Inlined at build time by Next.
const TG_BOT = process.env.NEXT_PUBLIC_TELEGRAM_BOT;

// Mounts Telegram's Login Widget. It calls the global set here with the signed
// user payload, which we forward to the backend for server-side verification.
function TelegramLoginButton({ onAuth }: { onAuth: (u: Record<string, unknown>) => void }) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!TG_BOT || !el) return;
    (window as unknown as { onTelegramAuth?: (u: Record<string, unknown>) => void }).onTelegramAuth = onAuth;
    const s = document.createElement("script");
    s.src = "https://telegram.org/js/telegram-widget.js?22";
    s.async = true;
    s.setAttribute("data-telegram-login", TG_BOT);
    s.setAttribute("data-size", "large");
    s.setAttribute("data-radius", "12");
    s.setAttribute("data-request-access", "write");
    s.setAttribute("data-onauth", "onTelegramAuth(user)");
    el.appendChild(s);
    return () => { el.innerHTML = ""; };
  }, [onAuth]);
  if (!TG_BOT) return null;
  return (
    <div className="mt-6">
      <div className="mb-4 flex items-center gap-3 text-xs text-muted">
        <span className="h-px flex-1 bg-line" /> {t("login.or")} <span className="h-px flex-1 bg-line" />
      </div>
      <div ref={box} className="flex justify-center" />
    </div>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [ref, setRef] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Already signed in? Skip to the app. Also read a referral code from the URL.
  useEffect(() => {
    if (getToken()) router.replace("/");
    const params = new URLSearchParams(window.location.search);
    const r = params.get("ref");
    if (r) setRef(r);
  }, [router]);

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const passwordOk = password.length >= 8;
  const codeOk = /^\d{6}$/.test(code);

  function go(next: Mode) {
    setMode(next); setError(null); setInfo(null); setCode("");
  }

  function finish(res: { token: string; user: SessionUser }) {
    setSession(res.token, res.user);
    router.replace(res.user.role ? "/staff" : "/");
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); }
    catch (e) {
      // Login of an unverified account returns 403 and sends a fresh code —
      // move the user to the verify screen instead of showing an error.
      if (e instanceof ApiError && e.status === 403 && mode === "login") {
        setInfo(t("login.msg.verifyPrompt"));
        setMode("verify");
      } else {
        setError((e as Error).message);
      }
    }
    finally { setBusy(false); }
  }

  const doRegister = () => run(async () => {
    await register(email.trim(), password, ref);
    setInfo(t("login.msg.codeSent", { email: email.trim() }));
    setMode("verify");
  });
  const doVerify = () => run(async () => finish(await verifyEmail(email.trim(), code)));
  const doLogin = () => run(async () => finish(await login(email.trim(), password)));
  const doForgot = () => run(async () => {
    await forgotPassword(email.trim());
    setInfo(t("login.msg.forgotSent"));
    setMode("reset");
  });
  const doReset = () => run(async () => finish(await resetPassword(email.trim(), code, password)));

  // Telegram widget callback. Kept stable (deps: router) so the widget script
  // mounts once, not on every keystroke. Reads any referral code from the URL.
  const onTelegramAuth = useCallback((u: Record<string, unknown>) => {
    setBusy(true); setError(null);
    const r = new URLSearchParams(window.location.search).get("ref") ?? undefined;
    loginWithTelegram({ ...u, ...(r ? { ref: r } : {}) })
      .then((res) => { setSession(res.token, res.user); router.replace(res.user.role ? "/staff" : "/"); })
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  }, [router]);

  return (
    <div className="flex min-h-[100dvh] flex-col px-5 pt-10 pb-8">
      <div className="mb-8 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-brand text-accent">
            <StarIcon size={24} />
          </span>
          <div>
            <p className="num text-xl font-bold text-brand-ink leading-none">PaidUp</p>
            <p className="text-xs text-muted">{t("login.tagline")}</p>
          </div>
        </div>
        <LangToggle />
      </div>

      {error && <p className="mb-4 rounded-xl bg-danger-tint p-3 text-sm text-danger">{error}</p>}
      {info && <p className="mb-4 rounded-xl bg-accent-tint p-3 text-sm text-accent-ink">{info}</p>}

      {/* ---- LOG IN ---- */}
      {mode === "login" && (
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-brand-ink">{t("login.login.title")}</h1>
          <p className="mt-1 text-muted">{t("login.login.subtitle")}</p>

          <label htmlFor="email" className="mt-6 mb-2 block font-semibold text-brand-ink">{t("login.yourEmail")}</label>
          <input id="email" type="email" inputMode="email" autoComplete="email"
            placeholder={t("login.emailPlaceholder")} value={email}
            onChange={(e) => setEmail(e.target.value)} className={inputClass} />

          <label htmlFor="password" className="mt-4 mb-2 block font-semibold text-brand-ink">{t("login.password")}</label>
          <input id="password" type="password" autoComplete="current-password"
            placeholder={t("login.passwordPlaceholder")} value={password}
            onChange={(e) => setPassword(e.target.value)} className={inputClass} />

          <button onClick={() => go("forgot")}
            className="mt-2 block text-sm font-semibold text-brand">{t("login.forgot")}</button>

          <div className="mt-5">
            <Button variant="primary" disabled={!emailOk || !password || busy} onClick={doLogin}>
              {busy ? t("login.loggingIn") : <>{t("login.logIn")} <ArrowRightIcon size={18} /></>}
            </Button>
          </div>
          <button onClick={() => go("register")}
            className="mt-4 w-full text-center text-sm font-semibold text-brand">
            {t("login.newHere")}
          </button>

          <TelegramLoginButton onAuth={onTelegramAuth} />
        </div>
      )}

      {/* ---- REGISTER ---- */}
      {mode === "register" && (
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-brand-ink">{t("login.register.title")}</h1>
          <p className="mt-1 text-muted">{t("login.register.subtitle")}</p>
          {ref && (
            <p className="mt-3 rounded-lg bg-accent-tint p-2.5 text-sm text-accent-ink">
              {t("login.invitedWith", { code: ref })}
            </p>
          )}

          <label htmlFor="email" className="mt-6 mb-2 block font-semibold text-brand-ink">{t("login.yourEmail")}</label>
          <input id="email" type="email" inputMode="email" autoComplete="email"
            placeholder={t("login.emailPlaceholder")} value={email}
            onChange={(e) => setEmail(e.target.value)} className={inputClass} />

          <label htmlFor="password" className="mt-4 mb-2 block font-semibold text-brand-ink">{t("login.makePassword")}</label>
          <input id="password" type="password" autoComplete="new-password"
            placeholder={t("login.min8Placeholder")} value={password}
            onChange={(e) => setPassword(e.target.value)} className={inputClass} />
          <p className="mt-1.5 text-xs text-muted">{t("login.passwordHint")}</p>

          <div className="mt-5">
            <Button variant="primary" disabled={!emailOk || !passwordOk || busy} onClick={doRegister}>
              {busy ? t("login.sending") : <>{t("login.createAccount")} <ArrowRightIcon size={18} /></>}
            </Button>
          </div>
          <button onClick={() => go("login")}
            className="mt-4 w-full text-center text-sm font-semibold text-brand">
            {t("login.haveAccount")}
          </button>
          <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-muted">
            <ShieldIcon size={14} /> {t("login.emailSafe")}
          </p>

          <TelegramLoginButton onAuth={onTelegramAuth} />
        </div>
      )}

      {/* ---- VERIFY EMAIL (after register / unverified login) ---- */}
      {mode === "verify" && (
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-brand-ink">{t("login.verify.title")}</h1>
          <p className="mt-1 text-muted">{t("login.verify.subtitle", { email })}</p>

          <label htmlFor="code" className="mt-6 mb-2 block font-semibold text-brand-ink">{t("login.enterCode")}</label>
          <input id="code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
            placeholder="123456" value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            dir="ltr"
            className="num w-full rounded-xl border border-line bg-card p-3.5 text-center text-3xl tracking-[0.4em] text-brand-ink outline-none placeholder:text-muted/40" />

          <div className="mt-5">
            <Button variant="accent" disabled={!codeOk || busy} onClick={doVerify}>
              {busy ? t("login.checking") : <><CheckIcon size={18} /> {t("login.verifyContinue")}</>}
            </Button>
          </div>
          <button onClick={() => go("login")}
            className="mt-4 w-full text-center text-sm font-semibold text-brand">{t("login.backToLogin")}</button>
        </div>
      )}

      {/* ---- FORGOT PASSWORD ---- */}
      {mode === "forgot" && (
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-brand-ink">{t("login.forgot.title")}</h1>
          <p className="mt-1 text-muted">{t("login.forgot.subtitle")}</p>

          <label htmlFor="email" className="mt-6 mb-2 block font-semibold text-brand-ink">{t("login.yourEmail")}</label>
          <input id="email" type="email" inputMode="email" autoComplete="email"
            placeholder={t("login.emailPlaceholder")} value={email}
            onChange={(e) => setEmail(e.target.value)} className={inputClass} />

          <div className="mt-5">
            <Button variant="primary" disabled={!emailOk || busy} onClick={doForgot}>
              {busy ? t("login.sending") : <>{t("login.sendCode")} <ArrowRightIcon size={18} /></>}
            </Button>
          </div>
          <button onClick={() => go("login")}
            className="mt-4 w-full text-center text-sm font-semibold text-brand">{t("login.backToLogin")}</button>
        </div>
      )}

      {/* ---- RESET PASSWORD ---- */}
      {mode === "reset" && (
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-brand-ink">{t("login.reset.title")}</h1>
          <p className="mt-1 text-muted">{t("login.reset.subtitle", { email })}</p>

          <label htmlFor="code" className="mt-6 mb-2 block font-semibold text-brand-ink">{t("login.code")}</label>
          <input id="code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
            placeholder="123456" value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            dir="ltr"
            className="num w-full rounded-xl border border-line bg-card p-3.5 text-center text-2xl tracking-[0.3em] text-brand-ink outline-none placeholder:text-muted/40" />

          <label htmlFor="password" className="mt-4 mb-2 block font-semibold text-brand-ink">{t("login.newPassword")}</label>
          <input id="password" type="password" autoComplete="new-password"
            placeholder={t("login.min8Placeholder")} value={password}
            onChange={(e) => setPassword(e.target.value)} className={inputClass} />

          <div className="mt-5">
            <Button variant="accent" disabled={!codeOk || !passwordOk || busy} onClick={doReset}>
              {busy ? t("login.saving") : <><CheckIcon size={18} /> {t("login.saveContinue")}</>}
            </Button>
          </div>
          <button onClick={() => go("login")}
            className="mt-4 w-full text-center text-sm font-semibold text-brand">{t("login.backToLogin")}</button>
        </div>
      )}
    </div>
  );
}
