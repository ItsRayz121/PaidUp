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
//   • It is one raster, so it cannot re-theme. See `.mh-wrap` in globals.css:
//     the panel paints its own dark ground in BOTH skins, because a dark 3D
//     render dropped on the light skin's white card reads as a broken image.
//
// ⚠️ THE PILE IS LIVE AGAIN (2026-09-09), AND IT IS THE RENDER'S OWN COINS.
// The first cut of this component had to retire the progress-linked coin split
// the founder asked for on 2026-08-30, because the pile was baked into the
// art and you cannot empty a glass made of pixels. It is back: the base layer
// is now the same render with the pile INPAINTED OUT, and the nine coins are a
// separate 5KB alpha sprite cut from the original, revealed one at a time as
// the session elapses. Both files, and the geometry in `mineHeroPile.ts`, come
// out of `api/mine-hero-assets.cjs` — read that script's header before
// touching any coordinate here.
//   • Hand-drawn vector coins were tried FIRST and rejected. Several sizes,
//     face ratios and rim gradients were rendered next to the real pile and
//     every one read as too bright, too flat or too big beside the render's
//     shading. Do not re-attempt that: cutting the real coins out is exact by
//     construction and costs 5KB.
//   • It is still decorative. It tracks ELAPSED TIME, never the real ROZI
//     figure — nine coins over an eight-hour session is one coin every ~53
//     minutes, and no user should read a count off it. The countdown beside
//     this hero is, and always was, the number to trust.
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

import { PILE_COINS, PILE_RX, PILE_RY, PILE_SPRITE } from "./mineHeroPile";

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
// A coin matched to the pile is ~30px across and the neck glass is ~16px — a
// coin cannot be drawn passing through it without visibly overflowing the
// glass. So they fade in just under the neck, where the bulb has already
// widened, and drop onto the pile. `x` is where each one lands, chosen to sit
// over the pile rather than beside it.
const DROP_COINS = [
  { x: 388, delay: 0 },
  { x: 372, delay: 2.6 },
  { x: 404, delay: 5.2 },
];

// Where a dropping coin is released, in art pixels. How FAR it falls is not
// fixed: see `dropDistance` below.
const DROP_FROM_Y = 302;

// ⚠️ A DROPPING COIN HAS TO LAND ON THE PILE THAT IS ACTUALLY THERE, AND THIS
// IS NOT A FLOURISH. The fall used to be a constant 30px, which was right for
// the old always-full baked pile and is wrong the moment the glass can be
// empty: at the start of a session a coin would stop dead about 60px above the
// rim and hang in clear glass, which reads as a bug, not as motion. So the
// distance follows the surface the NEXT coin would land on.
function dropDistance(coinsShown: number): number {
  const next = PILE_COINS[Math.min(coinsShown, PILE_COINS.length - 1)];
  // A full pile has no next coin to aim at, so land one coin-height above its
  // top rather than inside it.
  const y = coinsShown >= PILE_COINS.length ? next.y - PILE_RY : next.y;
  return Math.round(y - DROP_FROM_Y);
}

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
  progress,
  className = "",
  onSettled,
}: {
  // "mining" — a session is running. "pour" — the flourish right after the
  // start tap, which calls onSettled when it finishes. "ready" — the claim
  // card, where the whole panel sits in a warmer, stronger glow.
  variant?: "mining" | "pour" | "ready";
  // How far through the session we are, 0..1 — how much of the pile has
  // collected. Only read for "mining": a "pour" has just started, so its glass
  // is empty, and "ready" means there is something waiting to be collected, so
  // its glass is full. Both of those are facts about the variant, not about
  // any number a caller could pass.
  progress?: number;
  className?: string;
  onSettled?: () => void;
}) {
  const filled =
    variant === "ready" ? 1 : variant === "pour" ? 0 : Math.min(1, Math.max(0, progress ?? 0));
  // One coin per whole 1/9th of the session. Floor, so the glass is honestly
  // empty until the first ninth is actually behind us.
  const coinsShown = Math.floor(filled * PILE_COINS.length);

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
          {/* The halo a settled coin throws onto the glass around it. The
              render had one baked in; cutting the coins out on their own
              ellipse necessarily left it behind, and without something in its
              place a revealed coin reads as pasted on. Drawn rather than
              carried in the sprite's alpha on purpose — a soft tail in the
              alpha would be made of the neighbouring coin's pixels, so it
              would show a ghost of coins that have not been collected yet. */}
          <radialGradient id="mhCoinHalo" cx="50%" cy="50%" r="50%">
            <stop offset="42%" stopColor="#e9fff8" stopOpacity="0.5" />
            <stop offset="70%" stopColor="#8ff0e2" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#8ff0e2" stopOpacity="0" />
          </radialGradient>
          {/* One clip per coin, so the shared sprite shows exactly one of the
              nine. ⚠️ These ids are fixed, and two heroes CAN be on screen at
              once (the running card and the claim card). Duplicate ids resolve
              to the first match in the document — harmless only because every
              instance defines these identically, from the same generated
              geometry. Do not make any of them depend on the instance. */}
          {PILE_COINS.map((c, i) => (
            <clipPath key={i} id={`mhPileCoin${i}`}>
              <ellipse cx={c.x} cy={c.y} rx={PILE_RX} ry={PILE_RY} />
            </clipPath>
          ))}
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

        {/* The pile that has collected so far — the render's own coins, cut
            out as a sprite and shown one clip at a time.
            ⚠️ ALL NINE ARE ALWAYS IN THE DOM; only the class changes. Slicing
            the array instead would mean the sprite is not fetched until the
            first coin is due, which on a real session is ~53 minutes after the
            screen was opened — so the first coin would pop in on a cold image
            request. Rendering them all costs one request and one decode, and
            makes revealing a coin a pure class change. */}
        <g className="mh-pile">
          {PILE_COINS.map((c, i) => (
            <g key={i} className={`mh-pile-coin${i < coinsShown ? " mh-on" : ""}`}>
              <ellipse
                className="mh-pile-halo"
                cx={c.x}
                cy={c.y + 1}
                rx={PILE_RX * 1.55}
                ry={PILE_RY * 1.55}
                fill="url(#mhCoinHalo)"
              />
              <g clipPath={`url(#mhPileCoin${i})`}>
                <image
                  href="/brand/mine-hero-pile-v1.webp"
                  x={PILE_SPRITE.x}
                  y={PILE_SPRITE.y}
                  width={PILE_SPRITE.w}
                  height={PILE_SPRITE.h}
                />
              </g>
            </g>
          ))}
        </g>

        {/* Tokens dropping onto the pile. */}
        <g className="mh-coins" style={{ ["--mh-drop" as string]: `${dropDistance(coinsShown)}px` }}>
          {DROP_COINS.map((c, i) => (
            <g key={i} className="mh-coin" style={{ animationDelay: `${c.delay}s` }}>
              {/* An ellipse, not a circle, and sized from the real coins it
                  lands among (30 x 25 px in the art — see mineHeroPile.ts).
                  It was a circle while the pile was baked and unreachable;
                  now it comes to rest touching the sprite's own coins, so a
                  mismatched shape would be side by side and obvious. */}
              <g transform={`translate(${c.x},${DROP_FROM_Y})`}>
                <ellipse rx={PILE_RX - 0.6} ry={PILE_RY - 0.6} fill="url(#mhCoinRim)" />
                <ellipse rx={(PILE_RX - 0.6) * 0.63} ry={(PILE_RY - 0.6) * 0.63} fill="#e8fff5" />
                <text
                  y={0.5}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={12}
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
