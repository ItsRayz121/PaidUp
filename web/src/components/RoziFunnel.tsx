"use client";

// The "collecting ROZI" funnel — a flat, geometric vault shape in the app's
// own brand colours, replacing the old wood/metal/glass hourglass
// (components/HourglassClaim.tsx, deleted) after the founder reviewed the
// redesign mockup and asked to "switch to the minimal funnel" (2026-08-30).
//
// Why the switch: the ornate hourglass fought the rest of the redesign, which
// is all thin glowing rings and gradients (the MiningReactor language). It was
// also re-tuned twice in a week — the skeuomorphic direction was not settling.
// The funnel reads instantly as "ROZI is collecting → it is ready", is a
// fraction of the code, has no imperative DOM building, and — because it is
// drawn entirely with `--color-brand` / `--color-accent` tokens — needs no
// per-theme override to look right on the dark (default) skin.
//
// ⚠️ PURELY DECORATIVE — NEVER A READING OF THE REAL AMOUNT. The exact ROZI
// figure is shown as text right next to every use of this component. `fill`
// here is a 0..1 fraction of ELAPSED SESSION TIME (or 1 in the claim / pour
// state), the same rule the MiningReactor and the old hourglass followed:
// motion that reflects a real STATE, never a number this widget computed. Do
// NOT wire `fill` to claimableMicro — a tiny claim would round to an empty
// funnel and a large one would look identical to a medium one.
//
// Modes:
//   <RoziFunnel fill={p} />           running session — the catch fills as p (0..1) grows
//   <RoziFunnel fill={1} ready />     claim card — full, marigold, glowing
//   <RoziFunnel pour onSettled={…} /> a session just started — one-shot 0 → 1 fill

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

export function RoziFunnel({
  fill = 1,
  ready = false,
  pour = false,
  onSettled,
  className = "",
}: {
  // 0..1 — how full the catch triangle is. Ignored in `pour` mode.
  fill?: number;
  // Marigold + glow + sparkles instead of the plain teal "collecting" look.
  ready?: boolean;
  // One-shot: mount empty, fill to full on the next frame, then call
  // onSettled() once the CSS transition has had time to finish — lets the
  // caller swap this decorative overlay back out for the real running view
  // without duplicating the transition-duration math.
  pour?: boolean;
  onSettled?: () => void;
  className?: string;
}) {
  const [poured, setPoured] = useState(!pour);
  const settledRef = useRef(false);

  useEffect(() => {
    if (!pour) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const raf = requestAnimationFrame(() => setPoured(true));
    const done = setTimeout(() => {
      if (settledRef.current) return;
      settledRef.current = true;
      onSettled?.();
    }, reduce ? 60 : 1000);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(done);
    };
    // Mount-only: `pour` and `onSettled` are passed consistently for a given
    // usage site, and onSettled is read from the closure captured here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const level = pour ? (poured ? 1 : 0) : Math.min(1, Math.max(0, fill));

  return (
    <div
      className={`rozi-funnel ${ready ? "is-ready" : ""} ${className}`}
      style={{ "--fill": level } as CSSProperties}
      aria-hidden="true"
    >
      <svg viewBox="0 0 120 150" width="100%" height="100%">
        <defs>
          <clipPath id="rf-catch-clip">
            <path d="M22 78 H98 L60 146 Z" />
          </clipPath>
        </defs>

        {/* the funnel mouth — an open outline that "catches" ROZI */}
        <path className="rf-mouth" d="M14 20 H106 L60 72 Z" />
        <line className="rf-neck" x1="60" y1="70" x2="60" y2="80" />

        {/* the catch: a faint outline, plus a fill that rises from the base.
            The fill rect exactly covers the catch's vertical span (y 78..146),
            so a top `inset()` of (1 - fill) of its own height rises cleanly. */}
        <path className="rf-catch-line" d="M22 78 H98 L60 146 Z" />
        <g clipPath="url(#rf-catch-clip)">
          <rect className="rf-fill" x="0" y="78" width="120" height="68" />
        </g>

        {/* a mote sliding through the neck while it is still collecting */}
        <circle className="rf-mote" cx="60" cy="22" r="3.2" />
      </svg>
      <span className="rf-spark s1" />
      <span className="rf-spark s2" />
      <span className="rf-spark s3" />
    </div>
  );
}
