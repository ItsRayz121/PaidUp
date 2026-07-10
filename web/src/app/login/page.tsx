"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { ShieldIcon, CheckIcon, ArrowRightIcon, StarIcon } from "@/components/icons";
import {
  register, verifyEmail, login, forgotPassword, resetPassword,
  setSession, getToken, ApiError, type SessionUser,
} from "@/lib/api";

type Mode = "login" | "register" | "verify" | "forgot" | "reset";

const inputClass =
  "w-full rounded-xl border border-line bg-card p-3.5 text-lg text-brand-ink outline-none placeholder:text-muted/60";

export default function LoginPage() {
  const router = useRouter();
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
        setInfo("Please check your email for a code to verify your account.");
        setMode("verify");
      } else {
        setError((e as Error).message);
      }
    }
    finally { setBusy(false); }
  }

  const doRegister = () => run(async () => {
    await register(email.trim(), password, ref);
    setInfo(`We sent a 6-number code to ${email.trim()}.`);
    setMode("verify");
  });
  const doVerify = () => run(async () => finish(await verifyEmail(email.trim(), code)));
  const doLogin = () => run(async () => finish(await login(email.trim(), password)));
  const doForgot = () => run(async () => {
    await forgotPassword(email.trim());
    setInfo("If that email has an account, we sent a code to it.");
    setMode("reset");
  });
  const doReset = () => run(async () => finish(await resetPassword(email.trim(), code, password)));

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

      {error && <p className="mb-4 rounded-xl bg-danger-tint p-3 text-sm text-danger">{error}</p>}
      {info && <p className="mb-4 rounded-xl bg-accent-tint p-3 text-sm text-accent-ink">{info}</p>}

      {/* ---- LOG IN ---- */}
      {mode === "login" && (
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-brand-ink">Log in</h1>
          <p className="mt-1 text-muted">Welcome back. Enter your email and password.</p>

          <label htmlFor="email" className="mt-6 mb-2 block font-semibold text-brand-ink">Your email</label>
          <input id="email" type="email" inputMode="email" autoComplete="email"
            placeholder="name@email.com" value={email}
            onChange={(e) => setEmail(e.target.value)} className={inputClass} />

          <label htmlFor="password" className="mt-4 mb-2 block font-semibold text-brand-ink">Password</label>
          <input id="password" type="password" autoComplete="current-password"
            placeholder="Your password" value={password}
            onChange={(e) => setPassword(e.target.value)} className={inputClass} />

          <button onClick={() => go("forgot")}
            className="mt-2 block text-sm font-semibold text-brand">Forgot password?</button>

          <div className="mt-5">
            <Button variant="primary" disabled={!emailOk || !password || busy} onClick={doLogin}>
              {busy ? "Logging in…" : <>Log in <ArrowRightIcon size={18} /></>}
            </Button>
          </div>
          <button onClick={() => go("register")}
            className="mt-4 w-full text-center text-sm font-semibold text-brand">
            New here? Create an account
          </button>
        </div>
      )}

      {/* ---- REGISTER ---- */}
      {mode === "register" && (
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-brand-ink">Create an account</h1>
          <p className="mt-1 text-muted">We will email you one code to confirm your address.</p>
          {ref && (
            <p className="mt-3 rounded-lg bg-accent-tint p-2.5 text-sm text-accent-ink">
              You were invited with code <span className="font-bold">{ref}</span>. Nice!
            </p>
          )}

          <label htmlFor="email" className="mt-6 mb-2 block font-semibold text-brand-ink">Your email</label>
          <input id="email" type="email" inputMode="email" autoComplete="email"
            placeholder="name@email.com" value={email}
            onChange={(e) => setEmail(e.target.value)} className={inputClass} />

          <label htmlFor="password" className="mt-4 mb-2 block font-semibold text-brand-ink">Make a password</label>
          <input id="password" type="password" autoComplete="new-password"
            placeholder="At least 8 letters" value={password}
            onChange={(e) => setPassword(e.target.value)} className={inputClass} />
          <p className="mt-1.5 text-xs text-muted">Use 8 letters or more. Keep it safe.</p>

          <div className="mt-5">
            <Button variant="primary" disabled={!emailOk || !passwordOk || busy} onClick={doRegister}>
              {busy ? "Sending…" : <>Create account <ArrowRightIcon size={18} /></>}
            </Button>
          </div>
          <button onClick={() => go("login")}
            className="mt-4 w-full text-center text-sm font-semibold text-brand">
            Already have an account? Log in
          </button>
          <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-muted">
            <ShieldIcon size={14} /> We keep your email safe. We never share it.
          </p>
        </div>
      )}

      {/* ---- VERIFY EMAIL (after register / unverified login) ---- */}
      {mode === "verify" && (
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-brand-ink">Check your email</h1>
          <p className="mt-1 text-muted">
            We sent a 6-number code to <span className="font-semibold text-brand-ink">{email}</span>.
          </p>

          <label htmlFor="code" className="mt-6 mb-2 block font-semibold text-brand-ink">Enter the code</label>
          <input id="code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
            placeholder="123456" value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            className="num w-full rounded-xl border border-line bg-card p-3.5 text-center text-3xl tracking-[0.4em] text-brand-ink outline-none placeholder:text-muted/40" />

          <div className="mt-5">
            <Button variant="accent" disabled={!codeOk || busy} onClick={doVerify}>
              {busy ? "Checking…" : <><CheckIcon size={18} /> Verify and continue</>}
            </Button>
          </div>
          <button onClick={() => go("login")}
            className="mt-4 w-full text-center text-sm font-semibold text-brand">Back to log in</button>
        </div>
      )}

      {/* ---- FORGOT PASSWORD ---- */}
      {mode === "forgot" && (
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-brand-ink">Forgot password</h1>
          <p className="mt-1 text-muted">Enter your email. We will send a code to set a new password.</p>

          <label htmlFor="email" className="mt-6 mb-2 block font-semibold text-brand-ink">Your email</label>
          <input id="email" type="email" inputMode="email" autoComplete="email"
            placeholder="name@email.com" value={email}
            onChange={(e) => setEmail(e.target.value)} className={inputClass} />

          <div className="mt-5">
            <Button variant="primary" disabled={!emailOk || busy} onClick={doForgot}>
              {busy ? "Sending…" : <>Send code <ArrowRightIcon size={18} /></>}
            </Button>
          </div>
          <button onClick={() => go("login")}
            className="mt-4 w-full text-center text-sm font-semibold text-brand">Back to log in</button>
        </div>
      )}

      {/* ---- RESET PASSWORD ---- */}
      {mode === "reset" && (
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-brand-ink">Set a new password</h1>
          <p className="mt-1 text-muted">
            Enter the code we sent to <span className="font-semibold text-brand-ink">{email}</span> and a new password.
          </p>

          <label htmlFor="code" className="mt-6 mb-2 block font-semibold text-brand-ink">Code</label>
          <input id="code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
            placeholder="123456" value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            className="num w-full rounded-xl border border-line bg-card p-3.5 text-center text-2xl tracking-[0.3em] text-brand-ink outline-none placeholder:text-muted/40" />

          <label htmlFor="password" className="mt-4 mb-2 block font-semibold text-brand-ink">New password</label>
          <input id="password" type="password" autoComplete="new-password"
            placeholder="At least 8 letters" value={password}
            onChange={(e) => setPassword(e.target.value)} className={inputClass} />

          <div className="mt-5">
            <Button variant="accent" disabled={!codeOk || !passwordOk || busy} onClick={doReset}>
              {busy ? "Saving…" : <><CheckIcon size={18} /> Save and continue</>}
            </Button>
          </div>
          <button onClick={() => go("login")}
            className="mt-4 w-full text-center text-sm font-semibold text-brand">Back to log in</button>
        </div>
      )}
    </div>
  );
}
