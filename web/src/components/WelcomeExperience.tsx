"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { LogoMark } from "./Logo";
import { TasksIcon, MineIcon, ReferIcon } from "./icons";
import "./WelcomeExperience.css";

// A short, premium welcome shown ONCE, right after sign-in, before the user
// first reaches the home screen. It sits on top of the real home page (which is
// already mounted and loading its data underneath), so tapping "Let's start"
// just dissolves this overlay away — no reload, no second copy of home.
//
// FIRST-TIME GATING. There is no account-level onboarding flag on the session
// (see SessionUser in lib/api.ts), so completion is stored per user in
// localStorage under `rozipay.welcome.<userId>`. It is written ONLY when the
// button is tapped — never just because the animation loaded — and the key is
// scoped to the signed-in user so a second account on the same phone gets its
// own welcome.
//
// DEV REPLAY. In a non-production build, `/?welcome=1` (or `?welcome=replay`)
// forces the welcome to show again regardless of the stored flag. The check is
// compiled out of production, so a normal user has no way to re-trigger it.

const seenKey = (userId: string) => `rozipay.welcome.${userId}`;

// Entrance length before the overlay settles into its calm idle loop. Kept in
// sync with the timing map in WelcomeExperience.css — it must be >= the last
// one-shot (the button sweep, which ends ~2.8s) so nothing is cut mid-flight.
const ENTRANCE_MS = 2900;
// Exit dissolve length — matches the `.we-exiting` animations in the CSS.
const EXIT_MS = 640;

// SVG line + spark geometry, in the constellation's 0..100 viewBox. The three
// points sit at the same coordinates as the `.we-node-*` anchors in the CSS.
const LINES = ["M50 50 L50 15", "M50 50 L83 72", "M50 50 L17 72"];

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Decide once, at mount, whether this user should see the welcome. Reads
// localStorage (an external system), so it lives here rather than in an effect —
// same pattern as the lazy `useState` initializers in InstallPrompt.tsx.
function decideShow(userId: string | undefined): boolean {
  if (typeof window === "undefined" || !userId) return false;

  if (process.env.NODE_ENV !== "production") {
    try {
      const q = new URLSearchParams(window.location.search).get("welcome");
      if (q !== null && q !== "0" && q !== "false") return true;
    } catch {
      /* malformed URL — fall through to the stored flag */
    }
  }

  try {
    return window.localStorage.getItem(seenKey(userId)) !== "1";
  } catch {
    // Storage blocked (private mode): show it; nothing will persist, so it may
    // reappear next visit — acceptable, and rare in this market.
    return true;
  }
}

type Phase = "enter" | "idle" | "exiting";

export function WelcomeExperience({ userId }: { userId: string | undefined }) {
  const [reduced] = useState(prefersReducedMotion);
  const [show, setShow] = useState(() => decideShow(userId));
  const [phase, setPhase] = useState<Phase>(reduced ? "idle" : "enter");
  const ctaRef = useRef<HTMLButtonElement>(null);

  // Hand the entrance over to the calm idle loop after it has played once.
  // Reduced motion never enters this branch — `phase` starts at "idle".
  useEffect(() => {
    if (!show || reduced) return;
    const id = window.setTimeout(() => setPhase("idle"), ENTRANCE_MS);
    return () => window.clearTimeout(id);
  }, [show, reduced]);

  // Move focus to the primary action so it works immediately for keyboard and
  // screen-reader users, without waiting for the animation.
  useEffect(() => {
    if (!show) return;
    const id = window.setTimeout(() => ctaRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [show]);

  // Stop the home screen behind the overlay from scrolling while it's open.
  useEffect(() => {
    if (!show) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [show]);

  const dismiss = useCallback(() => {
    // Completion is recorded HERE — on the tap — and only here.
    if (userId) {
      try {
        window.localStorage.setItem(seenKey(userId), "1");
      } catch {
        /* storage blocked — the welcome may show again next visit; acceptable */
      }
    }
    if (reduced) {
      setShow(false);
      return;
    }
    setPhase("exiting");
    window.setTimeout(() => setShow(false), EXIT_MS);
  }, [userId, reduced]);

  // Single-action modal: keep focus on the button.
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Tab") {
      e.preventDefault();
      ctaRef.current?.focus();
    }
  }, []);

  if (!show) return null;

  const rootClass = [
    "we-root",
    phase === "idle" ? "we-idle" : "",
    phase === "exiting" ? "we-exiting" : "",
    reduced ? "we-reduced" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={rootClass}
      role="dialog"
      aria-modal="true"
      aria-labelledby="we-headline"
      aria-describedby="we-sub"
      onKeyDown={onKeyDown}
    >
      <div className="we-portal" aria-hidden="true" />

      <div className="we-stage">
        <div className="we-constellation" aria-hidden="true">
          <svg
            className="we-net"
            viewBox="0 0 100 100"
            preserveAspectRatio="xMidYMid meet"
          >
            <defs>
              <path id="we-p1" d={LINES[0]} pathLength={1} />
              <path id="we-p2" d={LINES[1]} pathLength={1} />
              <path id="we-p3" d={LINES[2]} pathLength={1} />
            </defs>

            {LINES.map((d, i) => (
              <g key={d} style={{ "--d": `${0.34 + i * 0.14}s` } as CSSProperties}>
                <path className="we-line-glow" d={d} />
                <path className="we-line-core" d={d} pathLength={1} />
              </g>
            ))}

            {/* One spark at a time, ~every 4s, round-robin across the three
                paths. Native SVG timing — no animation library. Not rendered
                at all under reduced motion. */}
            {!reduced &&
              LINES.map((_, i) => {
                const n = i + 1;
                // Round-robin: s1 at 3.2s (just after the entrance), then each
                // next spark 2.7s after the previous ends -> one spark every
                // ~4s, only ever one moving at a time. s1 re-arms off s3.
                const begin =
                  n === 1 ? "3.2s; we-s3.end+2.7s" : `we-s${i}.end+2.7s`;
                return (
                  <g className="we-spark" key={`spark-${n}`}>
                    <circle className="we-spark-halo" r="2.6" />
                    <circle className="we-spark-core" r="1.1" />
                    <animateMotion
                      id={`we-s${n}`}
                      dur="1.3s"
                      begin={begin}
                      fill="remove"
                    >
                      <mpath href={`#we-p${n}`} />
                    </animateMotion>
                    <set
                      attributeName="opacity"
                      to="1"
                      begin={`we-s${n}.begin`}
                      dur="1.3s"
                    />
                  </g>
                );
              })}
          </svg>

          <div className="we-logo-wrap">
            <span className="we-logo-halo" aria-hidden="true" />
            <span className="we-ripple" aria-hidden="true" />
            <span className="we-logo">
              <LogoMark size={92} />
            </span>
          </div>

          <div
            className="we-node we-node-tasks"
            style={{ "--nd": "0.8s" } as CSSProperties}
          >
            <span className="we-node-dot">
              <span className="we-node-halo" />
              <TasksIcon size={22} />
            </span>
            <span className="we-node-label">Tasks</span>
          </div>
          <div
            className="we-node we-node-mining"
            style={{ "--nd": "0.95s" } as CSSProperties}
          >
            <span className="we-node-dot">
              <span className="we-node-halo" />
              <MineIcon size={22} />
            </span>
            <span className="we-node-label">Mining</span>
          </div>
          <div
            className="we-node we-node-friends"
            style={{ "--nd": "1.1s" } as CSSProperties}
          >
            <span className="we-node-dot">
              <span className="we-node-halo" />
              <ReferIcon size={22} />
            </span>
            <span className="we-node-label">Friends</span>
          </div>
        </div>

        <div className="we-copy">
          <h1 id="we-headline" className="we-headline">
            Make your spare time count.
          </h1>
          <p id="we-sub" className="we-sub">
            Earn from simple tasks. Mine ROZI. Grow with friends.
          </p>
          <button
            ref={ctaRef}
            type="button"
            className="we-cta"
            onClick={dismiss}
          >
            <span className="we-cta-label">Let&apos;s start</span>
          </button>
          <p className="we-tagline">Your RoziPay journey starts here</p>
        </div>
      </div>
    </div>
  );
}
