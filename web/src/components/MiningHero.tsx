"use client";

// The /mine hero — the founder's own rendered concept as the base art, with a
// live, session-linked fill layered over it (founder, 2026-09-08; the
// top-to-bottom journey asked for and specified 2026-09-09).
//
// ⚠️ THE ART IS THE "SESSION JUST STARTED" STATE, AND THAT IS WHY IT IS THIS
// RENDER AND NOT THE OTHER ONE. mine-hero-v2 has its upper bulb FULL of liquid
// and its lower bulb EMPTY. Every layer here therefore only ever ADDS to the
// render — a cover that grows downward to reveal the drain, a pool that rises,
// a pile that grows. Nothing has to erase the render's own pixels.
//   That distinction is the whole reason this works. The first attempt at a
//   live fill (2026-09-08, reverted on sight) was built on mine-hero-v1, which
//   has the drained top and the full coin pile already painted in — the END
//   state — so animating it meant inpainting the pile out of the glass, and an
//   inpainted patch of dark glass never matched the render around it. If the
//   base art is ever swapped, swap it for another START-state render, or this
//   component goes back to being an erasure problem.
//
// ⚠️ THE OVERLAY IS REGISTERED TO THE ART IN IMAGE PIXELS, AND THREE THINGS
// HOLD THAT ALIGNMENT: the SVG's viewBox is the asset's exact pixel size, the
// wrapper's `aspect-ratio` is that same ratio, and the art is painted with
// `background-size: 100% 100%` (see `.mh-art` in globals.css). Change any one
// of them and every coordinate below drifts off the thing it points at.
//
// Every number here was MEASURED off a 50px grid composited over the asset and
// confirmed by drawing the bulb masks back over it — not estimated. If the
// asset is re-cropped or replaced, re-measure the same way first: the mask fit
// is the only thing standing between this and a teal fill spilling over a
// brass rim.
import { useEffect, useId, type CSSProperties } from "react";

// The asset's intrinsic size. The viewBox, the CSS aspect-ratio and every
// coordinate in this file are in these units.
const ART_W = 1515;
const ART_H = 1038;

// ⚠️ The two bulbs do not share a centre line — this is a hand-made render,
// not a symmetric drawing. Measured: the upper bulb sits ~2px right of the
// lower one. Using one centre for both puts a meniscus visibly off-axis.
const CX_UP = 755;
const CX_LO = 753;

const NECK_Y = 517;
// Where the render's own baked liquid surface sits, so this is where the live
// surface starts before it begins riding down toward the neck.
// ⚠️ AT PROGRESS 0 NOTHING AT ALL IS PAINTED OVER THE ART, and that is a
// promise worth keeping: the drain group is not rendered at all below p=0.001
// and no token has settled yet, so a session that has just started shows the
// founder's render exactly as approved. The only overlays are the glows,
// grains and sparkles that were already there before any of this.
const LIQ_TOP = 352;
// The glass floor of the lower bulb, where it meets the brass base.
const BULB_BOTTOM = 792;
// The pool's surface at progress 0 and at progress 1.
const POOL_FLOOR = 786;
const POOL_CREST = 672;

// Bulb interior half-widths, [y, halfWidth]. These trace the inside of the
// glass a few px shy of the rim, so a fill can never bleed onto the brass.
const UPPER_BULB: [number, number][] = [
  [234, 128], [250, 141], [270, 148], [300, 151], [330, 145], [355, 130],
  [380, 110], [405, 92], [430, 66], [455, 44], [480, 28], [500, 19], [NECK_Y, 15],
];
const LOWER_BULB: [number, number][] = [
  [NECK_Y, 15], [535, 22], [560, 39], [585, 60], [610, 82], [635, 103],
  [660, 120], [690, 136], [720, 146], [745, 148], [765, 142], [780, 125],
  [BULB_BOTTOM, 96],
];

/** Linear interpolation across a half-width table. */
function halfAt(table: [number, number][], y: number): number {
  if (y <= table[0][0]) return table[0][1];
  const last = table[table.length - 1];
  if (y >= last[0]) return last[1];
  for (let i = 1; i < table.length; i++) {
    const [y1, h1] = table[i];
    if (y <= y1) {
      const [y0, h0] = table[i - 1];
      return h0 + ((h1 - h0) * (y - y0)) / (y1 - y0);
    }
  }
  return last[1];
}

/** The interior of a bulb as a closed path, for use as a clip. */
function bulbPath(table: [number, number][], cx: number): string {
  const right = table.map(([y, h]) => `${cx + h} ${y}`);
  const left = table.map(([y, h]) => `${cx - h} ${y}`).reverse();
  return `M ${right.concat(left).join(" L ")} Z`;
}

const UPPER_PATH = bulbPath(UPPER_BULB, CX_UP);
const LOWER_PATH = bulbPath(LOWER_BULB, CX_LO);

// Grains suspended in the upper bulb, drifting toward the neck.
const UPPER_GRAINS = [
  { x: 700, y: 380, r: 4.2, delay: 0 },
  { x: 800, y: 372, r: 3.6, delay: 0.8 },
  { x: 736, y: 412, r: 4.6, delay: 1.7 },
  { x: 812, y: 404, r: 3.8, delay: 2.5 },
  { x: 690, y: 428, r: 4, delay: 3.3 },
  { x: 762, y: 444, r: 4.4, delay: 0.4 },
  { x: 728, y: 470, r: 3.4, delay: 2.1 },
  { x: 786, y: 462, r: 4.1, delay: 1.2 },
];

// ⚠️ THE NECK GLASS IS ONLY 30px WIDE HERE (x 738..768), so these x values stay
// inside 745..762 and the motion is straight down. Widen the spread and the
// dots visibly leave the glass.
const STREAM_DOTS = [
  { x: 753, r: 5, delay: 0 },
  { x: 747, r: 4, delay: 0.3 },
  { x: 759, r: 4.4, delay: 0.62 },
  { x: 750, r: 4.8, delay: 0.94 },
  { x: 757, r: 3.8, delay: 1.26 },
  { x: 745, r: 4.6, delay: 1.58 },
];

// Grains settling through the lower bulb, fanning out below the neck.
const LOWER_GRAINS = [
  { x: 700, y: 622, r: 4, delay: 0.5 },
  { x: 806, y: 638, r: 3.6, delay: 1.4 },
  { x: 676, y: 690, r: 4.4, delay: 2.3 },
  { x: 828, y: 700, r: 3.8, delay: 0.9 },
  { x: 730, y: 602, r: 3.4, delay: 3.1 },
  { x: 778, y: 610, r: 4.2, delay: 2 },
];

// ⚠️ THE TWO RADII DIFFER ON PURPOSE, AND ONLY ONE OF THEM IS FREE.
// FLIGHT_R is bounded by the NECK: the glass there is 30px across, so a token
// any larger cannot pass through without visibly overlapping it. A settled
// token passes through nothing, so it is sized to the founder's reference
// instead — v1's render shows a chunky heap of a few big coins, and a pile
// built at neck size reads as a scatter of little rings however well it is
// stacked. Nothing morphs between the two: a token in flight vanishes at its
// landing point rather than growing into a settled one.
const COIN_R = 19;
const FLIGHT_R = 13;

/**
 * The settled pile.
 *
 * ⚠️ THE JITTER AND THE OVERLAP ARE THE WHOLE POINT, NOT DECORATION. The first
 * version laid 18 identical coins out on an even 7/6/5 lattice and it read as
 * bubble wrap — a grid of little rings, not a heap of money. What fixes it is
 * what fixes any pile: coins that overlap (gap 32 against a 38px coin), sit at
 * slightly different heights and angles, and are not all the same size.
 *
 * ⚠️ THE OFFSETS ARE HAND-AUTHORED, NEVER Math.random(). This component is
 * server-rendered, so a random field differs between the server's HTML and the
 * client's first render — React would report a hydration mismatch, and the pile
 * would visibly jump on load.
 *
 * FILL order is bottom row first (a heap grows upward). PAINT order is the
 * reverse — see the sort at the call site — because on screen a lower coin is
 * a NEARER coin, so the bottom row has to be drawn last to overlap the rows
 * behind it. Getting those two the same way round makes the heap look inverted.
 *
 * 12 tokens across an 8h session is one landing roughly every 40 minutes: often
 * enough that the screen is visibly different at hour 7 than at hour 1, rare
 * enough that it never reads as a slot machine.
 */
type PileCoin = { x: number; y: number; r: number; rot: number };
const PILE: PileCoin[] = (() => {
  // [row y, count, per-coin dy, per-coin rotation]. Front (nearest, widest)
  // row first — that is also the fill order.
  const rows: [number, number, number[], number[]][] = [
    [766, 5, [0, 3, -2, 2, -1], [-8, 6, -3, 11, -6]],
    [740, 4, [2, -2, 1, -1], [4, -9, 8, -2]],
    [716, 3, [-1, 2, 0], [-5, 7, -10]],
  ];
  const gap = 32;
  const out: PileCoin[] = [];
  for (const [y, n, dys, rots] of rows) {
    const slots = Array.from({ length: n }, (_, i) => i);
    // Centre-outward within a row: a heap fills from the middle of the mound.
    slots.sort(
      (a, b) => Math.abs(a - (n - 1) / 2) - Math.abs(b - (n - 1) / 2),
    );
    for (const i of slots) {
      out.push({
        x: CX_LO + (i - (n - 1) / 2) * gap,
        y: y + dys[i],
        // A pile of identical discs still reads as a pattern. ±1px is enough.
        r: COIN_R + (i % 3 === 0 ? 1 : i % 3 === 1 ? -1 : 0),
        rot: rots[i],
      });
    }
  }
  return out;
})();

// The tokens in flight: each begins visibly inside the upper chamber, is drawn
// in to the narrow neck, then fans out to its landing spot in the lower one.
const DROP_COINS = [
  { x: 706, y: 400, landX: 712, landY: 742, delay: 0 },
  { x: 758, y: 424, landX: 756, landY: 756, delay: 2.6 },
  { x: 806, y: 398, landX: 800, landY: 740, delay: 5.2 },
];

// Gold sparkles, placed over areas where the render already has its own gold
// bokeh so the live ones read as part of the same field.
const SPARKS = [
  { x: 210, y: 185, r: 6, delay: 0 },
  { x: 450, y: 360, r: 4.4, delay: 1.1 },
  { x: 340, y: 590, r: 5.2, delay: 2.4 },
  { x: 1300, y: 245, r: 5.6, delay: 0.6 },
  { x: 1060, y: 420, r: 4.4, delay: 3.2 },
  { x: 1360, y: 680, r: 6.4, delay: 1.8 },
  { x: 405, y: 900, r: 4.8, delay: 2.9 },
  { x: 1120, y: 890, r: 5.2, delay: 0.3 },
];

// How long the start-of-session flourish runs before `onSettled` fires. Matches
// the ~2.2s the old pour took, so app/mine/page.tsx's hand-off from the
// flourish to the running-session view is unchanged.
const POUR_MS = 2200;

/**
 * One ROZI token. Colours are sampled from the render — see mhCoinRim.
 *
 * ⚠️ THE DARK OUTER STROKE IS WHAT MAKES A PILE READABLE. Without it, coins
 * that overlap merge into one gold blob, because the rim gradient's outer edge
 * is nearly the same value as the next coin's inner edge. It costs nothing on a
 * single coin in flight and it is the difference between a heap and a smear.
 */
function Coin({ r = COIN_R, rim }: { r?: number; rim: string }) {
  return (
    <>
      <circle r={r} fill={`url(#${rim})`} stroke="#6b5205" strokeWidth={1.4} />
      <circle r={r * 0.72} fill="#e8fff5" />
      <text
        y={0.5}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={r * 0.86}
        fontWeight={800}
        fill="#003c38"
      >
        R
      </text>
    </>
  );
}

export function MiningHero({
  variant = "mining",
  progress = 0,
  className = "",
  onSettled,
}: {
  // "mining" — a session is running. "pour" — the flourish right after the
  // start tap, which calls onSettled when it finishes. "ready" — the claim
  // card, where the whole panel sits in a warmer, stronger glow.
  variant?: "mining" | "pour" | "ready";
  /**
   * How far through the session, 0..1. Drives the drain, the pool and the pile
   * — so the glass is a picture of the countdown beside it rather than a loop
   * that merely happens to be moving.
   *
   * ⚠️ IT IS STILL DECORATIVE, AND THE COUNTDOWN IS STILL THE FIGURE TO TRUST.
   * Nobody reads 18 tokens as "6h 12m left". What this buys is that the screen
   * is visibly different late in a session than early in one, which is the
   * whole reason a progress-linked glass was asked for.
   *
   * Ignored for "pour" (pinned to 0 — a session that has just begun) and for
   * "ready" (pinned to 1 — everything has landed and is waiting to be
   * claimed). That pinning is what makes the reset free: claiming starts a new
   * session, progress returns to 0, and the liquid and the tokens are back up
   * top with no separate reset animation to keep in sync.
   */
  progress?: number;
  className?: string;
  onSettled?: () => void;
}) {
  useEffect(() => {
    if (variant !== "pour" || !onSettled) return;
    const id = setTimeout(onSettled, POUR_MS);
    return () => clearTimeout(id);
    // onSettled is read once at mount, the same contract the old component had
    // — a caller passing a fresh function identity per render must not restart
    // the flourish.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant]);

  // ⚠️ EVERY GRADIENT AND CLIP ID IS SCOPED TO THIS INSTANCE, AND THAT IS A
  // BUG FIX, NOT TIDINESS. SVG ids are DOCUMENT-scoped: `url(#mhVacated)`
  // resolves to the FIRST element with that id anywhere on the page, not to the
  // one in this component's own <defs>. `mhVacated` is the clip that confines
  // the drain to the band the liquid has left, and its height is computed from
  // progress — so with two heroes on one page, BOTH used the first one's band,
  // and the second one's drain simply never painted. Found by sampling the
  // rendered pixels and finding them identical to the untouched art (#00a591
  // against the art's own #03ad98) — invisible in the markup, and invisible in
  // a review that only ever looks at one hero at a time.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const I = {
    mhUpperBulb: `${uid}ub`,
    mhLowerBulb: `${uid}lb`,
    mhVacated: `${uid}vac`,
    mhDrain: `${uid}drain`,
    mhBeam: `${uid}beam`,
    mhPool: `${uid}pool`,
    mhMeniscus: `${uid}men`,
    mhNeckGlow: `${uid}neck`,
    mhBaseGlow: `${uid}base`,
    mhMedGlow: `${uid}med`,
    mhStream: `${uid}stream`,
    mhCoinRim: `${uid}rim`,
  };

  const p =
    variant === "ready" ? 1 : variant === "pour" ? 0 : Math.min(1, Math.max(0, progress));

  // The three things progress moves.
  const surfaceY = LIQ_TOP + (NECK_Y - LIQ_TOP) * p;
  const poolY = POOL_FLOOR - (POOL_FLOOR - POOL_CREST) * p;
  const settled = Math.round(p * PILE.length);

  const upperHalf = halfAt(UPPER_BULB, surfaceY);
  const lowerHalf = halfAt(LOWER_BULB, poolY);
  // Still draining. Below this the upper bulb is spent and nothing should be
  // falling through the neck — a stream running under an empty top bulb is the
  // one thing here that would read as a bug rather than as decoration.
  const flowing = p < 0.995 && variant !== "ready";

  return (
    <div
      className={`mh-wrap mh-${variant} ${flowing ? "mh-flowing" : ""} ${className}`}
      style={{ aspectRatio: `${ART_W} / ${ART_H}` }}
      aria-hidden="true"
    >
      <div className="mh-art" />
      <svg className="mh-fx" viewBox={`0 0 ${ART_W} ${ART_H}`} width="100%" height="100%">
        <defs>
          <clipPath id={I.mhUpperBulb}>
            <path d={UPPER_PATH} />
          </clipPath>
          <clipPath id={I.mhLowerBulb}>
            <path d={LOWER_PATH} />
          </clipPath>
          {/* Everything the liquid has left behind — intersected with the bulb
              by nesting, see the drain group below. */}
          <clipPath id={I.mhVacated}>
            <rect x={0} y={280} width={ART_W} height={Math.max(0, surfaceY - 280)} />
          </clipPath>

          {/* ⚠️ EVERY LEVEL FILL BELOW USES gradientUnits="userSpaceOnUse",
              AND THAT IS DELIBERATE. These shapes change height every second.
              With the default objectBoundingBox the gradient restretches each
              time, so the colour at a given height in the glass drifts as the
              level moves and the fill appears to change hue while it drains.
              Pinned to user space, the colour at a given y is fixed and only
              how much of it is visible changes. */}

          {/* The vacated upper bulb: empty glass, sampled from the render's own
              empty upper bulb (#2d645d high, #164f4a low, #1b5a45 mid).
              ⚠️ THE ALPHA RAMP ACROSS THE TOP IS NOT A NICETY — IT IS THE FIX
              FOR THE ONE THING THAT MADE THE FIRST VERSION LOOK PASTED ON. A
              fill that starts hard at the render's baked surface line draws a
              straight edge clean across the bulb, and a straight line inside
              blown glass reads instantly as a grey box laid over the art. So
              this starts 56px HIGHER than the surface at alpha 0 and only
              reaches full strength below it. The band it fades through is also
              exactly where the render is a little brighter — light from liquid
              that used to be sitting there — so the same ramp does the second
              job of taking that glow away with the liquid. */}
          <linearGradient id={I.mhDrain} gradientUnits="userSpaceOnUse" x1="0" y1="296" x2="0" y2="520">
            <stop offset="0%" stopColor="#24605a" stopOpacity="0" />
            <stop offset="16%" stopColor="#205c56" stopOpacity="0.42" />
            <stop offset="27%" stopColor="#1b5551" stopOpacity="0.88" />
            <stop offset="40%" stopColor="#16504c" stopOpacity="1" />
            <stop offset="100%" stopColor="#0d4145" stopOpacity="1" />
          </linearGradient>
          {/* The lamp beam the render paints down the middle of the upper bulb
              carries on through the vacated space, or drained glass reads as a
              flat card rather than as glass with a light above it.
              ⚠️ IT IS AN ELLIPSE WITH A RADIAL FADE, NOT A RECT. The first
              version used a 52px-wide rectangle and its two vertical edges were
              plainly visible as a lighter stripe down the glass — the second
              tell, after the horizontal one above, that something had been laid
              over the art. Nothing in this overlay may have a straight edge
              inside the glass unless it is a liquid surface. */}
          <radialGradient id={I.mhBeam} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#b8fff2" stopOpacity="0.19" />
            <stop offset="55%" stopColor="#8ff0e0" stopOpacity="0.07" />
            <stop offset="100%" stopColor="#8ff0e0" stopOpacity="0" />
          </radialGradient>

          {/* The pool collecting in the lower bulb. Sampled from the render's
              own liquid: brightest at the surface (#33ecdf), deepening down
              (#0bad95).
              ⚠️ IT IS DELIBERATELY NOT OPAQUE AT THE BOTTOM. Fully opaque, it
              read as flat mint paint filling the glass; letting the render's own
              bottom-of-bulb glow and its sparkles through the deep end is what
              makes it read as liquid with something behind it. */}
          <linearGradient id={I.mhPool} gradientUnits="userSpaceOnUse" x1="0" y1="660" x2="0" y2="800">
            <stop offset="0%" stopColor="#46ecdf" stopOpacity="0.95" />
            <stop offset="42%" stopColor="#12b3a1" stopOpacity="0.84" />
            <stop offset="100%" stopColor="#0a7268" stopOpacity="0.66" />
          </linearGradient>

          {/* A liquid surface seen very slightly from above: a bright core
              fading to the glass on both sides. This is what makes a moving
              level read as liquid rather than as a rectangle sliding. */}
          <linearGradient id={I.mhMeniscus} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#8ffff2" stopOpacity="0.25" />
            <stop offset="50%" stopColor="#eafffc" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#8ffff2" stopOpacity="0.25" />
          </linearGradient>

          <radialGradient id={I.mhNeckGlow} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#c8fff6" stopOpacity="0.85" />
            <stop offset="40%" stopColor="#3fe4d8" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#3fe4d8" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={I.mhBaseGlow} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#7ff6ea" stopOpacity="0.5" />
            <stop offset="55%" stopColor="#2fd6cc" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#2fd6cc" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={I.mhMedGlow} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#fff6da" stopOpacity="0.7" />
            <stop offset="50%" stopColor="#ffd98a" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#ffd98a" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={I.mhStream} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#eafffb" stopOpacity="0.9" />
            <stop offset="35%" stopColor="#5cf0e2" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#3fe4d8" stopOpacity="0" />
          </linearGradient>
          {/* ⚠️ THESE THREE COLOURS WERE SAMPLED OUT OF THE ASSET, NOT PICKED.
              A token settles into a pile lit by the render's own liquid, so any
              mismatch is side by side and obvious — an early attempt used the
              app's marigold accent and read as orange against the render's
              yellow-gold. Measured: brightest rim #f3d72e, face #e8fff5, mark a
              near-black teal #003c38. Re-sample if the asset is replaced. */}
          <linearGradient id={I.mhCoinRim} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#fff9c4" />
            <stop offset="52%" stopColor="#f3d72e" />
            <stop offset="100%" stopColor="#b58f0a" />
          </linearGradient>
        </defs>

        {/* Glows first, so everything live reads on top of them. */}
        <ellipse className="mh-glow-base" cx={CX_LO} cy={932} rx={500} ry={75} fill={`url(#${I.mhBaseGlow})`} />
        <circle className="mh-glow-neck" cx={CX_LO} cy={NECK_Y} r={120} fill={`url(#${I.mhNeckGlow})`} />
        <circle className="mh-glow-med" cx={755} cy={117} r={78} fill={`url(#${I.mhMedGlow})`} />

        {/* ---- the upper bulb draining ----------------------------------
            ⚠️ TWO NESTED CLIPS, AND THE NESTING IS THE MECHANISM. A clipPath
            holding two shapes UNIONS them; nesting one clipped group inside
            another INTERSECTS them. Intersection is what is wanted here —
            inside the bulb AND above the surface — so the beam below can be any
            soft shape and still be guaranteed never to paint over the liquid
            that has not drained yet. Flatten these into one clipPath and the
            beam appears through the remaining liquid.
            The group fades in over the first fifth of the session because the
            gradient's own soft top would otherwise darken real, untouched glass
            at progress 0. Until then the vacated band is a few pixels tall and
            there is nothing to cover. */}
        {p > 0.001 && (
          <g clipPath={`url(#${I.mhUpperBulb})`} opacity={Math.min(1, p * 5)}>
            <g clipPath={`url(#${I.mhVacated})`}>
              <rect x={0} y={280} width={ART_W} height={Math.max(0, surfaceY - 280)} fill={`url(#${I.mhDrain})`} />
              <ellipse
                cx={CX_UP}
                cy={surfaceY - 54}
                rx={36}
                ry={Math.min(124, Math.max(26, (surfaceY - 300) * 0.6))}
                fill={`url(#${I.mhBeam})`}
              />
            </g>
          </g>
        )}
        {/* The surface itself, riding down the glass. */}
        <g clipPath={`url(#${I.mhUpperBulb})`}>
          <ellipse
            cx={CX_UP}
            cy={surfaceY}
            rx={upperHalf}
            ry={Math.max(4, upperHalf * 0.16)}
            fill={`url(#${I.mhMeniscus})`}
            opacity={0.9}
          />
        </g>

        {/* ---- the flow ------------------------------------------------- */}
        {flowing && (
          <>
            <g className="mh-upper" clipPath={`url(#${I.mhUpperBulb})`}>
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
            <rect className="mh-stream-core" x={746} y={492} width={14} height={210} rx={7} fill={`url(#${I.mhStream})`} />
            <g className="mh-stream">
              {STREAM_DOTS.map((d, i) => (
                <circle
                  key={i}
                  className="mh-stream-dot"
                  cx={d.x}
                  cy={492}
                  r={d.r}
                  style={{ animationDelay: `${d.delay}s` }}
                />
              ))}
            </g>
            <g className="mh-lower" clipPath={`url(#${I.mhLowerBulb})`}>
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
          </>
        )}

        {/* ---- the lower bulb collecting -------------------------------- */}
        <g clipPath={`url(#${I.mhLowerBulb})`}>
          <rect
            x={0}
            y={poolY}
            width={ART_W}
            height={BULB_BOTTOM + 8 - poolY}
            fill={`url(#${I.mhPool})`}
          />
        </g>

        {/* The pile. Drawn over the pool and then tinted by it below the
            surface, so tokens read as sitting IN glowing liquid rather than on
            a painted band.
            ⚠️ SORTED BY y BEFORE PAINTING — see PILE's own note. Fill order is
            bottom-row-first because a heap grows upward; paint order has to be
            the opposite, because on screen a lower coin is a nearer coin and
            must overlap the ones behind it. Drop this sort and the heap looks
            inside out. `key` stays the coin's own identity, not its paint
            position, so re-sorting never makes React swap two coins' elements. */}
        <g clipPath={`url(#${I.mhLowerBulb})`}>
          {PILE.slice(0, settled)
            .map((c, i) => ({ c, i }))
            .sort((a, b) => a.c.y - b.c.y)
            .map(({ c, i }) => (
              <g key={i} transform={`translate(${c.x},${c.y}) rotate(${c.rot})`}>
                <Coin r={c.r} rim={I.mhCoinRim} />
              </g>
            ))}
          <rect
            x={0}
            y={poolY}
            width={ART_W}
            height={BULB_BOTTOM + 8 - poolY}
            fill="#12b3a1"
            opacity={0.22}
          />
          <ellipse
            cx={CX_LO}
            cy={poolY}
            rx={lowerHalf}
            ry={Math.max(4, lowerHalf * 0.14)}
            fill={`url(#${I.mhMeniscus})`}
            opacity={0.85}
          />
        </g>

        {/* ---- tokens in flight ----------------------------------------- */}
        {flowing && (
          <g className="mh-coins">
            {DROP_COINS.map((c, i) => (
              <g
                key={i}
                className="mh-coin"
                style={
                  {
                    animationDelay: `${c.delay}s`,
                    "--mh-neck-x": `${CX_LO - c.x}px`,
                    "--mh-neck-y": `${NECK_Y - c.y}px`,
                    "--mh-land-x": `${c.landX - c.x}px`,
                    "--mh-land-y": `${c.landY - c.y}px`,
                  } as CSSProperties
                }
              >
                <g transform={`translate(${c.x},${c.y})`}>
                  <Coin r={FLIGHT_R} rim={I.mhCoinRim} />
                </g>
              </g>
            ))}
          </g>
        )}

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
