"use client";

// The mirror of "Connect Telegram" (founder, 2026-07-18): a Telegram-first
// account adds an email + password so the SAME account works on the website.
// Three small steps in one card: pick email + password → type the code we
// emailed → done. Only shows for accounts still on their synthetic Telegram
// placeholder address; once a real email exists it renders a quiet
// "connected" row instead.
import { useState } from "react";
import { Card, Button } from "./ui";
import { MailIcon, CheckIcon } from "./icons";
import { useI18n } from "@/lib/i18n";
import {
  startEmailLink, confirmEmailLink, getToken, setSession, type SessionUser,
} from "@/lib/api";

const inputClass =
  "w-full rounded-xl border border-line bg-card p-3 text-brand-ink outline-none placeholder:text-muted/60";

export function ConnectEmailCard({ user }: { user: SessionUser }) {
  const { t } = useI18n();
  const [step, setStep] = useState<"form" | "code" | "done">(
    user.hasEmail === false ? "form" : "done",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Nothing to do for accounts that already have a real email (or sessions
  // stored before this feature existed, where hasEmail is unknown).
  if (user.hasEmail !== false && step !== "done") return null;
  if (user.hasEmail !== false && step === "done" && !email) return null;

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const passwordOk = password.length >= 8;
  const codeOk = /^\d{6}$/.test(code);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await startEmailLink(email.trim(), password);
      setStep("code");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const r = await confirmEmailLink(email.trim(), code);
      const token = getToken();
      if (token) setSession(token, r.user); // every screen learns the new email
      setStep("done");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (step === "done") {
    return (
      <Card className="flex items-center gap-3 p-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
          <MailIcon size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-brand-ink">{t("profile.emailConnected")}</p>
          <p className="truncate text-sm text-muted">{t("profile.emailConnectedHint")}</p>
        </div>
        <CheckIcon size={20} className="shrink-0 text-success" />
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-tint text-brand">
          <MailIcon size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-brand-ink">{t("profile.emailTitle")}</p>
          <p className="text-sm text-muted">{t("profile.emailHint")}</p>
        </div>
      </div>

      {step === "form" && (
        <div className="mt-3 space-y-2.5">
          <input
            type="email" inputMode="email" autoComplete="email"
            placeholder={t("login.emailPlaceholder")}
            value={email} onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
          />
          <input
            type="password" autoComplete="new-password"
            placeholder={t("profile.emailPasswordPlaceholder")}
            value={password} onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
          />
          <Button onClick={send} disabled={!emailOk || !passwordOk || busy} variant="primary" size="md">
            {t("profile.emailSend")}
          </Button>
        </div>
      )}

      {step === "code" && (
        <div className="mt-3 space-y-2.5">
          <p className="text-sm text-brand-ink">{t("profile.emailCodeSent", { email: email.trim() })}</p>
          <input
            inputMode="numeric" autoComplete="one-time-code" maxLength={6}
            placeholder="123456"
            value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            className={`${inputClass} num text-center text-xl tracking-widest`}
          />
          <Button onClick={confirm} disabled={!codeOk || busy} variant="primary" size="md">
            {t("profile.emailConfirm")}
          </Button>
          <button onClick={() => { setStep("form"); setCode(""); setError(null); }}
            className="block w-full text-center text-sm font-semibold text-brand">
            {t("profile.emailBack")}
          </button>
        </div>
      )}

      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </Card>
  );
}
