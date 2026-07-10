"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { ShieldIcon, CheckIcon, ArrowRightIcon, StarIcon } from "@/components/icons";

// Email verification sign-in (founder decision: no SMS OTP — too costly).
// Two steps: enter email -> enter the 6-digit code we email you.
// Telegram verify is the planned cheaper fallback (not built yet).
// DEMO: no real email is sent; any 6 digits move you forward.

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const codeOk = /^\d{6}$/.test(code);

  return (
    <div className="flex min-h-[100dvh] flex-col px-5 pt-10 pb-8">
      {/* Brand */}
      <div className="mb-8 flex items-center gap-2">
        <span className="grid h-11 w-11 place-items-center rounded-2xl bg-brand text-accent">
          <StarIcon size={24} />
        </span>
        <div>
          <p className="num text-xl font-bold text-brand-ink leading-none">PaidUp</p>
          <p className="text-xs text-muted">Earn and get real cash</p>
        </div>
      </div>

      {step === "email" ? (
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-brand-ink">Sign in or join</h1>
          <p className="mt-1 text-muted">We will email you a code. No password to remember.</p>

          <label htmlFor="email" className="mt-6 mb-2 block font-semibold text-brand-ink">
            Your email
          </label>
          <input
            id="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="name@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-xl border border-line bg-card p-3.5 text-lg text-brand-ink outline-none placeholder:text-muted/60"
          />

          <div className="mt-5">
            <Button variant="primary" disabled={!emailOk} onClick={() => setStep("code")}>
              Send me a code <ArrowRightIcon size={18} />
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
            We sent a 6-number code to{" "}
            <span className="font-semibold text-brand-ink">{email}</span>.
          </p>

          <label htmlFor="code" className="mt-6 mb-2 block font-semibold text-brand-ink">
            Enter the code
          </label>
          <input
            id="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            className="num w-full rounded-xl border border-line bg-card p-3.5 text-center text-3xl tracking-[0.4em] text-brand-ink outline-none placeholder:text-muted/40"
          />

          <div className="mt-5">
            <Button variant="accent" disabled={!codeOk} onClick={() => router.push("/")}>
              <CheckIcon size={18} /> Verify and continue
            </Button>
          </div>

          <button
            onClick={() => setStep("email")}
            className="mt-4 w-full text-center text-sm font-semibold text-brand"
          >
            Use a different email
          </button>
        </div>
      )}
    </div>
  );
}
