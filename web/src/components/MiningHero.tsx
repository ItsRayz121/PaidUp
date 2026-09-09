"use client";

// The /mine hero — the founder's own rendered concept as the base art, with
// the live motion layered over it (founder, 2026-09-08).
//
// ⚠️ THIS REPLACED A HAND-DRAWN SVG HOURGLASS, AND THAT WAS A DELIBERATE
// TRADE, NOT AN UPGRADE IN EVERY DIRECTION. The founder sent a 3D render and
// asked for the real screen to match it; vector shapes do not reach a render's
// shading, so the render itself is the base layer. What that costs us is
// written down here so nobody "restores" the old component thinking it was
// only ever worse:
//   • The art is FIXED. The sand level in the upper bulb and the coin pile in
//     the lower one are pixels in `mine-hero-v1.webp`, so neither can move.
//     The old component's coin split tracked the fraction of the session
//     elapsed (founder ask, 2026-08-30); that is retired here. It was always
//     explicitly decorative — the countdown next to this hero is, and always
//     was, the number a user should trust — but it IS a reversal, and if the
//     founder wants it back the fix is a render of the same scene with an
//     EMPTY glass, which this component could then fill live.
//   • It is one raster, so it cannot re-theme. See `.mh-wrap` in globals.css:
//     the panel paints its own dark ground in BOTH skins, because a dark 3D
//     render dropped on the light skin's white card reads as a broken image.
//
// ⚠️ THE OVERLAY IS REGISTERED TO THE ART IN IMAGE PIXELS, AND THREE THINGS
// HOLD THAT ALIGNMENT. The SVG's viewBox is the asset's exact pixel size, the
// wrapper's `aspect-ratio` is that same ratio, and the art is painted with
// `background-size: 100% 100%`. Change any one of them and every coordinate
// below drifts off the thing it is pointing at. Positions were MEASURED off a
// 50px grid composited over the asset, not estimated:
//   centre x 388 · neck y 285 · baked pile x 325..450, y 340..405 · brass
//   base top y 415 · platform ring y ~470 · medallion (383, 58).
// If the asset is ever re-cropped or replaced, re-measure with a grid first.
import { useEffect } from "react";

// The asset's intrinsic size. The viewBox, the CSS aspect-ratio and every
// coordinate in this file are all in these units.
const ART_W = 770;
const ART_H = 528;

const CX = 388;
const NECK_Y = 285;

// Grains suspended in the upper bulb, drifting toward the neck. Kept well
// inside the glass silhouette so none of them needs clipping — a particle
// that crosses the glass edge and gets clipped away mid-fall reads as a
// flicker, not as sand.
const UPPER_GRAINS = [
  { x: 352, y: 178, r: 2.2, delay: 0 },
  { x: 402, y: 170, r: 1.8, delay: 0.8 },
  { x: 372, y: 196, r: 2.4, delay: 1.7 },
  { x: 424, y: 190, r: 1.9, delay: 2.5 },
  { x: 344, y: 206, r: 2 , delay: 3.3 },
  { x: 396, y: 214, r: 2.3, delay: 0.4 },
  { x: 366, y: 234, r: 1.7, delay: 2.1 },
  { x: 412, y: 240, r: 2.1, delay: 1.2 },
];

// The stream through the neck. ⚠️ THE NECK GLASS IS ONLY ~16px WIDE HERE
// (x 380..396), so these x values stay inside 383..393 and the motion is
// straight down. Widen the spread and the dots visibly leave the glass.
const STREAM_DOTS = [
  { x: 388, r: 2.6, delay: 0 },
  { x: 385, r: 2, delay: 0.3 },
  { x: 391, r: 2.2, delay: 0.62 },
  { x: 387, r: 2.4, delay: 0.94 },
  { x: 390, r: 1.9, delay: 1.26 },
  { x: 386, r: 2.3, delay: 1.58 },
];

// Grains settling through the lower bulb, fanning out below the neck.
const LOWER_GRAINS = [
  { x: 360, y: 322, r: 2, delay: 0.5 },
  { x: 414, y: 330, r: 1.8, delay: 1.4 },
  { x: 348, y: 356, r: 2.2, delay: 2.3 },
  { x: 428, y: 362, r: 1.9, delay: 0.9 },
  { x: 376, y: 312, r: 1.7, delay: 3.1 },
  { x: 400, y: 316, r: 2.1, delay: 2 },
];

// ⚠️ COINS SPAWN BELOW THE NECK, NOT ABOVE IT, AND THAT IS FORCED BY THE ART.
// A coin matched to the baked pile is ~26px across and the neck glass is ~16px
// — a coin cannot be drawn passing through it without visibly overflowing the
// glass. So they fade in just under the neck, where the bulb has already
// widened, and drop onto the pile. `x` is where each one lands, chosen to sit
// on top of the baked pile rather than beside it.
const DROP_COINS = [
  { x: 388, delay: 0 },
  { x: 372, delay: 2.6 },
  { x: 404, delay: 5.2 },
];

// Gold sparkles, placed over areas where the render already has its own gold
// bokeh so the live ones read as part of the same field.
const SPARKS = [
  { x: 120, y: 128, r: 3, delay: 0 },
  { x: 236, y: 186, r: 2.2, delay: 1.1 },
  { x: 176, y: 300, r: 2.6, delay: 2.4 },
  { x: 648, y: 124, r: 2.8, delay: 0.6 },
  { x: 592, y: 214, r: 2.2, delay: 3.2 },
  { x: 684, y: 316, r: 3.2, delay: 1.8 },
  { x: 208, y: 430, r: 2.4, delay: 2.9 },
  { x: 604, y: 424, r: 2.6, delay: 0.3 },
];

// How long the start-of-session flourish runs before `onSettled` fires. Matches
// the ~2.2s the old hourglass pour took, so app/mine/page.tsx's hand-off from
// the flourish to the running-session view is unchanged.
const POUR_MS = 2200;

export function MiningHero({
  variant = "mining",
  className = "",
  onSettled,
}: {
  // "mining" — a session is running. "pour" — the flourish right after the
  // start tap, which calls onSettled when it finishes. "ready" — the claim
  // card, where the whole panel sits in a warmer, stronger glow.
  variant?: "mining" | "pour" | "ready";
  className?: string;
  onSettled?: () => void;
}) {
  useEffect(() => {
    if (variant !== "pour" || !onSettled) return;
    const id = setTimeout(onSettled, POUR_MS);
    return () => clearTimeout(id);
    // onSettled is read once at mount, the same contract the old component
    // had — a caller passing a fresh function identity per render must not
    // restart the flourish.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant]);

  return (
    <div
      className={`mh-wrap mh-${variant} ${className}`}
      style={{ aspectRatio: `${ART_W} / ${ART_H}` }}
      aria-hidden="true"
    >
      <div className="mh-art" />
      <svg className="mh-fx" viewBox={`0 0 ${ART_W} ${ART_H}`} width="100%" height="100%">
        <defs>
          <radialGradient id="mhNeckGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#c8fff6" stopOpacity="0.85" />
            <stop offset="40%" stopColor="#3fe4d8" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#3fe4d8" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="mhBaseGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#7ff6ea" stopOpacity="0.5" />
            <stop offset="55%" stopColor="#2fd6cc" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#2fd6cc" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="mhMedGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#fff6da" stopOpacity="0.7" />
            <stop offset="50%" stopColor="#ffd98a" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#ffd98a" stopOpacity="0" />
          </radialGradient>
          {/* The bright core of the stream, brightest at the neck and dying
              out as it reaches the pile. */}
          <linearGradient id="mhStream" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#eafffb" stopOpacity="0.9" />
            <stop offset="35%" stopColor="#5cf0e2" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#3fe4d8" stopOpacity="0" />
          </linearGradient>
          {/* ⚠️ THESE THREE COLOURS WERE SAMPLED OUT OF THE ASSET, NOT PICKED.
              A dropping coin lands on the pile the render already shows, so
              any mismatch is side by side and obvious — the first attempt used
              the app's own marigold accent and read as orange next to the
              render's yellow-gold. Measured off the baked pile: brightest rim
              #f3d72e, face around #e8fff5, and the mark a near-black teal
              #003c38. Re-sample if the asset is ever replaced. */}
          <linearGradient id="mhCoinRim" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#fff9c4" />
            <stop offset="52%" stopColor="#f3d72e" />
            <stop offset="100%" stopColor="#b58f0a" />
          </linearGradient>
        </defs>

        {/* Glows first, so the live motion reads on top of them. */}
        <ellipse className="mh-glow-base" cx={CX} cy={468} rx={252} ry={38} fill="url(#mhBaseGlow)" />
        <circle className="mh-glow-neck" cx={CX} cy={NECK_Y} r={62} fill="url(#mhNeckGlow)" />
        <circle className="mh-glow-med" cx={383} cy={58} r={40} fill="url(#mhMedGlow)" />

        {/* The flow: grains above the neck, the stream through it, grains
            settling below. Together this is the top-to-bottom movement. */}
        <g className="mh-upper">
          {UPPER_GRAINS.map((g, i) => (
            <circle
              key={i}
              className="mh-grain"
              cx={g.x}
              cy={g.y}
              r={g.r}
              style={{ animationDelay: `${g.delay}s` }}
            />
          ))}
        </g>

        <rect className="mh-stream-core" x={384.5} y={262} width={7} height={84} rx={3.5} fill="url(#mhStream)" />
        <g className="mh-stream">
          {STREAM_DOTS.map((d, i) => (
            <circle
              key={i}
              className="mh-stream-dot"
              cx={d.x}
              cy={262}
              r={d.r}
              style={{ animationDelay: `${d.delay}s` }}
            />
          ))}
        </g>

        <g className="mh-lower">
          {LOWER_GRAINS.map((g, i) => (
            <circle
              key={i}
              className="mh-grain mh-grain-low"
              cx={g.x}
              cy={g.y}
              r={g.r}
              style={{ animationDelay: `${g.delay}s` }}
            />
          ))}
        </g>

        {/* Tokens dropping onto the pile the render already shows collected. */}
        <g className="mh-coins">
          {DROP_COINS.map((c, i) => (
            <g key={i} className="mh-coin" style={{ animationDelay: `${c.delay}s` }}>
              <g transform={`translate(${c.x},302)`}>
                <circle r={12} fill="url(#mhCoinRim)" />
                <circle r={9} fill="#e8fff5" />
                <text
                  y={0.5}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={11}
                  fontWeight={800}
                  fill="#003c38"
                >
                  R
                </text>
              </g>
            </g>
          ))}
        </g>

        <g className="mh-sparks">
          {SPARKS.map((s, i) => (
            <circle
              key={i}
              className="mh-spark"
              cx={s.x}
              cy={s.y}
              r={s.r}
              style={{ animationDelay: `${s.delay}s` }}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}
