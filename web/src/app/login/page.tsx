"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { ShieldIcon, CheckIcon, ArrowRightIcon, StarIcon } from "@/components/icons";
import { requestCode, verifyCode, setSession, getToken } from "@/lib/api";

// Email verification sign-in (no SMS OTP — founder decision, cost).
// Real: calls /auth/email/request then /auth/email/verify, stores the session.
export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [ref, setRef] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in? Skip to the app. Also read a referral code from the URL.
  useEffect(() => {
    if (getToken()) router.replace("/");
    const params = new URLSearchParams(window.location.search);
    const r = params.get("ref");
    if (r) setRef(r);
  }, [router]);

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const codeOk = /^\d{6}$/.test(code);

  async function sendCode() {
    setBusy(true); setError(null);
    try {
      await requestCode(email.trim());
      setStep("code");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  async function verify() {
    setBusy(true); setError(null);
    try {
      const { token, user } = await verifyCode(email.trim(), code, ref);
      setSession(token, user);
      router.replace(user.role ? "/staff" : "/");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="flex min-h-[100dvh] flex-col px-5 pt-10 pb-8">
      <div className="mb-8 flex items-center gap-2">
        <span className="grid h-11 w-11 place-items-center rounded-2xl bg-brand text-accent">
          <StarIcon size={24} />
        </span>
        <div>
          <p className="num text-xl font-bold text-brand-ink leading-none">PaidUp</p>
          <p className="text-xs text-muted">Earn and get real cash</p>
        </div>
      </div>

      {error && (
        <p className="mb-4 rounded-xl bg-danger-tint p-3 text-sm text-danger">{error}</p>
      )}

      {step === "email" ? (
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-brand-ink">Sign in or join</h1>
          <p className="mt-1 text-muted">We will email you a code. No password to remember.</p>
          {ref && (
            <p className="mt-3 rounded-lg bg-accent-tint p-2.5 text-sm text-accent-ink">
              You were invited with code <span className="font-bold">{ref}</span>. Nice!
            </p>
          )}

          <label htmlFor="email" className="mt-6 mb-2 block font-semibold text-brand-ink">Your email</label>
          <input
            id="email" type="email" inputMode="email" autoComplete="email"
            placeholder="name@email.com" value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-xl border border-line bg-card p-3.5 text-lg text-brand-ink outline-none placeholder:text-muted/60"
          />
          <div className="mt-5">
            <Button variant="primary" disabled={!emailOk || busy} onClick={sendCode}>
              {busy ? "Sending…" : <>Send me a code <ArrowRightIcon size={18} /></>}
            </Button>
          </div>
          <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-muted">
            <ShieldIcon size={14} /> We keep your email safe. We never share it.
          </p>
        </div>
      ) : (
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-brand-ink">Check your email</h1>
          <p className="mt-1 text-muted">
            We sent a 6-number code to <span className="font-semibold text-brand-ink">{email}</span>.
          </p>

          <label htmlFor="code" className="mt-6 mb-2 block font-semibold text-brand-ink">Enter the code</label>
          <input
            id="code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
            placeholder="123456" value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            className="num w-full rounded-xl border border-line bg-card p-3.5 text-center text-3xl tracking-[0.4em] text-brand-ink outline-none placeholder:text-muted/40"
          />
          <div className="mt-5">
            <Button variant="accent" disabled={!codeOk || busy} onClick={verify}>
              {busy ? "Checking…" : <><CheckIcon size={18} /> Verify and continue</>}
            </Button>
          </div>
          <button onClick={() => { setStep("email"); setError(null); }}
            className="mt-4 w-full text-center text-sm font-semibold text-brand">
            Use a different email
          </button>
        </div>
      )}
    </div>
  );
}
