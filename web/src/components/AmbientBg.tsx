import type { CSSProperties } from "react";

// The app's ambient background — the "Liquid / Energy" motif, richer premium
// pass (founder, 2026-08-29). One definition, used on Home / Mine / Wallet /
// Profile, so the four screens can never drift apart.
//
// Layers, back to front (all the real work is in globals.css `.ambient-bg`):
//   1. the page gradient (body / .app-frame) — no longer flat white
//   2. .ab-blob ×3        — slow morphing aurora blobs (teal / marigold / cyan)
//   3. .ab-grid           — a faint static circuit texture
//   4. .ab-motes > i ×12  — small diamonds drifting upward, "mining energy"
//
// ⚠️ PURELY DECORATIVE. Never interactive, never a data visualisation — same
// rule the mining-chamber rings and the claim hourglass already follow. All
// motion is transform/opacity only (compositor-safe); `prefers-reduced-motion`
// freezes every layer. `-z-10` keeps it behind every real element (see the
// .app-frame stacking-context note in globals.css for why that works).
export function AmbientBg({ variant }: { variant?: "mine" }) {
  return (
    <div
      className={`ambient-bg -z-10${variant === "mine" ? " ambient-bg--mine" : ""}`}
      aria-hidden="true"
    >
      <span className="ab-blob ab-blob-1" />
      <span className="ab-blob ab-blob-2" />
      <span className="ab-blob ab-blob-3" />
      <span className="ab-grid" />
      <span className="ab-motes">
        {Array.from({ length: 12 }).map((_, i) => (
          <i key={i} style={{ "--i": i } as CSSProperties} />
        ))}
      </span>
    </div>
  );
}
