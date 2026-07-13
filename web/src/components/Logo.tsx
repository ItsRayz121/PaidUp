"use client";

// The RoziPay brand mark.
//
// The artwork lives in web/public/brand/ as real image files. If a file is
// missing the <img> fires onError and we fall back to the wordmark in type,
// so a missing asset degrades to plain text instead of a broken-image icon on
// every screen in the app.
//
//   brand/logo-mark.png  — the square R icon (square, transparent or white bg)
//   brand/logo-full.png  — the full lockup: icon + "RoziPay" wordmark
import { useState } from "react";

export function LogoMark({ size = 32, className = "" }: { size?: number; className?: string }) {
  // The letter mark shows by DEFAULT; the real art swaps in only once it has
  // actually loaded. This means a missing or slow logo file never flashes the
  // browser's broken-image glyph — the branded "R" is always what's on screen
  // until a real image is confirmed good. Until the founder adds the file, the
  // "R" simply stays.
  const [loaded, setLoaded] = useState(false);

  return (
    <span
      style={{ width: size, height: size }}
      className={`relative grid shrink-0 place-items-center overflow-hidden rounded-[22%] ${loaded ? "" : "bg-brand"} ${className}`}
    >
      {!loaded && (
        <span style={{ fontSize: size * 0.55 }} className="font-bold leading-none text-white" aria-hidden>R</span>
      )}
      {/* Deliberately a plain <img>, not next/image: next/image's optimizer
          fetches the file server-side and 400s loudly when it's absent, before
          any client fallback can run. A plain <img> 404s quietly on the client.
          The asset is a tiny icon, so optimization buys ~nothing. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/logo-mark.png"
        alt=""
        width={size}
        height={size}
        onLoad={() => setLoaded(true)}
        style={{ width: size, height: size, display: loaded ? "block" : "none" }}
        className="object-contain"
      />
    </span>
  );
}

// Icon + wordmark + tagline. Used on the login screen, where there is room to
// let the brand breathe.
export function LogoLockup({ tagline, size = 44 }: { tagline?: string; size?: number }) {
  // Prefer the real lockup artwork (icon + wordmark + tagline in one image). If
  // it is missing or slow, we fall back to the mark + typed wordmark below, the
  // same graceful-degradation trick LogoMark uses — a missing file never shows
  // the browser's broken-image glyph on the login screen.
  const [loaded, setLoaded] = useState(false);

  return (
    <div className="flex items-center gap-2.5">
      {/* The full-lockup image already contains the tagline, so when it loads we
          hide the text fallback (including its separate tagline line). */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/logo-full.png"
        alt="RoziPay"
        onLoad={() => setLoaded(true)}
        style={{ height: size * 1.15, width: "auto", display: loaded ? "block" : "none" }}
        className="object-contain"
      />
      {!loaded && (
        <>
          <LogoMark size={size} />
          <div>
            <p className="text-xl font-bold leading-none text-brand-ink">
              Rozi<span className="text-brand">Pay</span>
            </p>
            {tagline && (
              <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
                {tagline}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
