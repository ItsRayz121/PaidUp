"use client";

// The "claim your ROZI" hourglass — turned brass caps and columns, rounded
// glass bulbs, filled with real RoziPay-mark coins instead of sand (founder,
// 2026-08-13, refined from a photo reference + a coins-not-sand request;
// rebuilt to a rendered reference 2026-09-08).
//
// ⚠️ IT IS ALL PLAIN SVG SHAPES AND GRADIENTS, AND THERE IS NOT ONE FILTER IN
// HERE ON PURPOSE. Every glow — the halo, the arc sweeps, the lamp in the
// crown, the pool above the neck, the plinth — is a radial or linear gradient.
// feGaussianBlur would be the obvious way to get the same look and is the one
// thing that would make this artwork genuinely expensive to paint on the
// low-end Android phones this app is built for, on a screen that is already
// running AmbientBg's blurred aurora layers behind it.
//
// ⚠️ THE COIN COUNT IS PURELY DECORATIVE, NEVER A READING OF THE REAL AMOUNT.
// `s.claimableMicro` (the real, exact ROZI figure) is already shown as text
// right next to this component, unchanged — that is the number a user should
// trust. A fixed coin count here is the same choice the mining-chamber rings
// and gem-glint already make (CLAUDE.md): decorative motion that reflects a
// real STATE ("something is ready"), never a number nobody asked this widget
// to compute. Do not wire HOURGLASS_COIN_COUNT to claimableMicro — a claim of
// 0.004 ROZI would round to zero visible coins, and a big one would overflow
// the glass; neither is what this animation is for.
//
// Two modes, chosen by whether `progress` is passed:
//
// 1. Pour-once (progress omitted): plays ONCE per mount, then settles into a
//    static glowing "ready" state. Only ever mounted while `s.claimableMicro
//    > 0` is already true, or right after a session starts (app/mine/page.tsx)
//    — a real state transition, never a fake countdown against a timer
//    nothing backs.
//
// 2. Session-controlled (progress = 0..1, founder ask 2026-08-28): the coin
//    split tracks how far through the CURRENT MINING SESSION we are — 0 =
//    every coin in the top bulb, 1 = all settled at the bottom. This is what
//    makes the hourglass live on screen for the whole session instead of
//    just the first few seconds. Still purely decorative: the fraction
//    reflects ELAPSED TIME (session start → expiry), never the real ROZI
//    amount — same rule as above, just against a different real state.
import { useEffect, useRef } from "react";

// ⚠️ THE VIEWBOX HAS NEGATIVE ORIGIN MARGIN ON PURPOSE, AND NOTHING BELOW
// MOVED TO GET IT. The gold frame's platform and the crystals beside it need
// room outside the old 160x246 box, and the obvious way to make room — shift
// every element right and down — would silently break the coin packing, whose
// slot maths is hard-centred on x = 80 (see generateSlots). Growing the box
// outward instead keeps x = 80 the centre and leaves NECK, TOP_BULB, BOT_BULB
// and both clip paths byte-for-byte the values they have always had.
const VB_X = -24;
const VB_Y = -12;
const VB_W = 208;
const VB_H = 270;
const NECK = { x: 80, y: 120 };
const TOP_BULB = { wideY: 30, narrowY: 112, maxHalf: 34, minHalf: 5, rowStep: 13, spacing: 13 };
const BOT_BULB = { wideY: 210, narrowY: 130, maxHalf: 34, minHalf: 5, rowStep: 13, spacing: 13 };
export const HOURGLASS_COIN_COUNT = 14;
const SVG_NS = "http://www.w3.org/2000/svg";

// The gold dust that spreads out around the glass while a session runs
// (founder, 2026-09-08). Positions are HAND-PLACED, not random, for two
// reasons: a random field would differ between the server-rendered markup and
// the client's first render, and a random field would sooner or later drop a
// bright dot straight onto the R medallion or the neck, which are the two
// things on this artwork that must stay clean.
//
// `dir` is which way the mote drifts, and it is always AWAY from the centre of
// the frame — that is the whole difference between a field that reads as
// spreading outward and one that reads as dots blinking in place.
const GOLD_MOTES: {
  x: number;
  y: number;
  r: number;
  dir: "l" | "r" | "u" | "d";
  delay: number;
  dur: number;
}[] = [
  { x: -14, y: 52, r: 1.6, dir: "l", delay: 0, dur: 7 },
  { x: -6, y: 100, r: 1.1, dir: "l", delay: 1.9, dur: 8.2 },
  { x: -18, y: 148, r: 1.9, dir: "l", delay: 3.4, dur: 6.6 },
  { x: 4, y: 196, r: 1.3, dir: "l", delay: 4.8, dur: 7.6 },
  { x: 150, y: 44, r: 1.7, dir: "r", delay: 0.7, dur: 7.9 },
  { x: 170, y: 92, r: 1.2, dir: "r", delay: 2.6, dur: 6.9 },
  { x: 156, y: 132, r: 1.5, dir: "r", delay: 4.1, dur: 8.4 },
  { x: 174, y: 180, r: 1.8, dir: "r", delay: 1.2, dur: 7.2 },
  { x: 140, y: 210, r: 1.1, dir: "r", delay: 5.5, dur: 6.4 },
  { x: 50, y: -2, r: 1.4, dir: "u", delay: 2.2, dur: 8 },
  { x: 112, y: -6, r: 1.2, dir: "u", delay: 3.9, dur: 7.4 },
  { x: 30, y: 20, r: 1, dir: "u", delay: 5.1, dur: 6.8 },
  { x: 46, y: 244, r: 1.5, dir: "d", delay: 1.5, dur: 7.7 },
  { x: 116, y: 246, r: 1.3, dir: "d", delay: 3, dur: 8.6 },
];

type BulbCfg = typeof TOP_BULB;
type Slot = { x: number; y: number };

function halfWidthAt(y: number, cfg: BulbCfg): number {
  const t = Math.min(1, Math.max(0, (y - cfg.wideY) / (cfg.narrowY - cfg.wideY)));
  return cfg.maxHalf - (cfg.maxHalf - cfg.minHalf) * Math.pow(t, 0.85);
}

// Packs `count` coin slots row by row, starting from the bulb's WIDE end.
// Top-bulb rows start at the wide top (farthest from the neck), so slot 0
// there drains FIRST — matching how a real hourglass empties (the remaining
// sand always stays connected to the neck). Bottom-bulb rows start at the
// wide base, so slot 0 there is the first place a falling coin settles,
// exactly like sand piling up from the floor before it reaches the neck.
function generateSlots(count: number, cfg: BulbCfg): Slot[] {
  const dir = cfg.narrowY > cfg.wideY ? 1 : -1;
  const rows: Slot[][] = [];
  let y = cfg.wideY;
  let total = 0;
  let guard = 0;
  while (total < count && guard < 60) {
    guard++;
    const halfW = halfWidthAt(y, cfg);
    const perRow = Math.max(1, Math.floor((halfW * 2) / cfg.spacing));
    const row: Slot[] = [];
    const startX = 80 - ((perRow - 1) * cfg.spacing) / 2;
    for (let i = 0; i < perRow && total < count; i++) {
      row.push({ x: startX + i * cfg.spacing, y });
      total++;
    }
    rows.push(row);
    y += dir * cfg.rowStep;
    if (dir === 1 && y > cfg.narrowY) break;
    if (dir === -1 && y < cfg.narrowY) break;
  }
  return rows.flat().slice(0, count);
}

// A gold rim with the real RoziPay mark on a light face — the same
// medallion-on-a-badge treatment RoziMark uses elsewhere, not a raw
// recolored logo (a raster mark does not recolor cleanly) and not a plain
// gold dot (the founder's own "use the real logo" ask).
function makeCoin(): SVGGElement {
  const g = document.createElementNS(SVG_NS, "g");
  const ring = document.createElementNS(SVG_NS, "circle");
  ring.setAttribute("r", "5.2");
  ring.setAttribute("class", "hg-coin-ring");
  const face = document.createElementNS(SVG_NS, "circle");
  face.setAttribute("r", "4.1");
  face.setAttribute("class", "hg-coin-face");
  const img = document.createElementNS(SVG_NS, "image");
  img.setAttributeNS("http://www.w3.org/1999/xlink", "href", "/brand/logo-mark.png");
  img.setAttribute("href", "/brand/logo-mark.png");
  img.setAttribute("x", "-3.1");
  img.setAttribute("y", "-3.1");
  img.setAttribute("width", "6.2");
  img.setAttribute("height", "6.2");
  img.setAttribute("preserveAspectRatio", "xMidYMid meet");
  g.append(ring, face, img);
  return g;
}

// How many of the HOURGLASS_COIN_COUNT coins should already be settled at a
// given point through the session — exported so a caller can show a matching
// "X of N" counter next to the glass without duplicating this floor/clamp.
export function hourglassDroppedCount(progress: number): number {
  return Math.min(HOURGLASS_COIN_COUNT, Math.max(0, Math.floor(progress * HOURGLASS_COIN_COUNT)));
}

export function HourglassClaim({
  className = "",
  onSettled,
  progress,
  working = false,
}: {
  className?: string;
  // Fires once, the moment the pour finishes and the glass settles into its
  // static "ready" glow — lets a caller (e.g. the Start Mining button) swap
  // this decorative overlay back out for the real state view without
  // duplicating this file's pour-duration math anywhere else. Pour-once mode
  // only; ignored in session-controlled mode.
  onSettled?: () => void;
  // Session-controlled mode — see the file header. Pass 0..1 (fraction of the
  // session elapsed) and the split updates as the value changes across
  // re-renders; omit for the original one-shot pour.
  progress?: number;
  // "Working" mode (founder, 2026-08-29): while a mining session is running,
  // the coins sit SETTLED in the bottom bulb — the same low, full look as the
  // "ready" state — with a gentle looping glow and a spark trickling through
  // the neck, instead of draining one coin an hour from the top bulb (which
  // read as a broken, half-empty glass). Overrides `progress`.
  working?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const topGroupRef = useRef<SVGGElement>(null);
  const botGroupRef = useRef<SVGGElement>(null);
  const travelGroupRef = useRef<SVGGElement>(null);
  const splashRef = useRef<SVGCircleElement>(null);
  // Session mode's "apply this progress value" function, set up once at mount
  // and invoked again by the second effect below whenever `progress` changes.
  // This is what lets coins already on screen keep their DOM identity — only
  // the newly-crossed coin animates — instead of tearing the whole glass down
  // and rebuilding it on every one-second tick from the parent's countdown.
  const applyProgressRef = useRef<((p: number) => void) | null>(null);
  // Captured once: which mode this mount is in never changes mid-life, since
  // callers pass `progress` / `working` consistently for a given usage site.
  const initialProgressRef = useRef(progress);
  const workingRef = useRef(working);

  useEffect(() => {
    const wrap = wrapRef.current;
    const topGroup = topGroupRef.current;
    const botGroup = botGroupRef.current;
    const travelGroup = travelGroupRef.current;
    const splash = splashRef.current;
    if (!wrap || !topGroup || !botGroup || !travelGroup || !splash) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const sessionMode = initialProgressRef.current !== undefined;

    // Both of the modes that mean "a session is running right now" turn the
    // gold dust up: it drifts outward instead of only twinkling in place. The
    // pour-once / ready state deliberately does NOT get it — that state
    // already has its own marigold glow and corner sparkles, and stacking a
    // third gold motion on top just reads as noise.
    if (sessionMode || workingRef.current) wrap.classList.add("hg-mining");

    const topSlots = generateSlots(HOURGLASS_COIN_COUNT, TOP_BULB);
    const botSlots = generateSlots(HOURGLASS_COIN_COUNT, BOT_BULB);

    // "Working" mode: every coin settled in the bottom bulb, no pour, plus a
    // looping glow + neck trickle (CSS on .hg-working). The countdown text
    // beside this widget is what tells the user how far through the session
    // they are — this visual only says "the machine is running".
    if (workingRef.current) {
      botSlots.forEach((pos) => {
        const coin = makeCoin();
        coin.setAttribute("transform", `translate(${pos.x},${pos.y})`);
        botGroup.appendChild(coin);
      });
      wrap.classList.add("hg-working");
      return;
    }

    // Shared by both modes: animate one coin falling from `start` (a top-bulb
    // slot) through the neck to `destPos` (a bottom-bulb slot), then settle it
    // and play the splash ring.
    function animateOne(start: Slot, destPos: Slot, onDone: () => void) {
      const travel = makeCoin();
      travelGroup!.appendChild(travel);
      const dur = 340;
      const t0 = performance.now();
      function frame(now: number) {
        const p = Math.min(1, (now - t0) / dur);
        let x: number, y: number;
        if (p < 0.5) {
          const q = p / 0.5;
          x = start.x + (NECK.x - start.x) * q;
          y = start.y + (NECK.y - start.y) * q;
        } else {
          const q = (p - 0.5) / 0.5;
          x = NECK.x + (destPos.x - NECK.x) * q;
          y = NECK.y + (destPos.y - NECK.y) * q;
        }
        travel.setAttribute("transform", `translate(${x},${y})`);
        if (p < 1) {
          requestAnimationFrame(frame);
        } else {
          travel.remove();
          const settled = makeCoin();
          settled.setAttribute("transform", `translate(${destPos.x},${destPos.y})`);
          botGroup!.appendChild(settled);
          splash!.classList.remove("play");
          void splash!.getBBox();
          splash!.classList.add("play");
          onDone();
        }
      }
      requestAnimationFrame(frame);
    }

    if (sessionMode) {
      // A queue of coins still sitting in the top bulb, in drop order — slot 0
      // drains first (generateSlots' own header explains why).
      const queue = topSlots.map((pos) => {
        const el = makeCoin();
        el.setAttribute("transform", `translate(${pos.x},${pos.y})`);
        topGroup.appendChild(el);
        return { el, pos };
      });
      let dropped = 0;
      let cancelled = false;

      // Places `n` coins straight into the bottom bulb with no travel
      // animation — used for the initial "we opened the app 3 hours into an
      // 8-hour session" state, and for reduced-motion catch-up.
      function placeInstantly(n: number) {
        for (let i = 0; i < n && queue.length > 0; i++) {
          const next = queue.shift()!;
          next.el.remove();
          const destPos = botSlots[dropped] ?? { x: 80, y: 200 };
          const settled = makeCoin();
          settled.setAttribute("transform", `translate(${destPos.x},${destPos.y})`);
          // Non-null assertion: this is a hoisted function declaration, so TS
          // does not carry the guard's narrowing in — same reason the
          // pour-once mode's animateOne() already needed one below.
          botGroup!.appendChild(settled);
          dropped++;
        }
      }

      // The destination slot is allocated synchronously (dropped++ happens
      // before the animation resolves) so two coins catching up back-to-back
      // — e.g. the tab was backgrounded and progress jumped by more than one
      // coin's worth — never both animate toward the same bottom slot.
      function dropNext() {
        const next = queue.shift();
        if (!next) return;
        next.el.remove();
        const destPos = botSlots[dropped] ?? { x: 80, y: 200 };
        dropped++;
        animateOne(next.pos, destPos, () => {});
      }

      const initialTarget = hourglassDroppedCount(initialProgressRef.current ?? 0);
      placeInstantly(initialTarget);
      if (dropped >= HOURGLASS_COIN_COUNT) wrap.classList.add("ready");

      applyProgressRef.current = (p: number) => {
        if (cancelled) return;
        const target = hourglassDroppedCount(p);
        if (reduceMotion) {
          placeInstantly(target - dropped);
        } else {
          while (dropped < target && queue.length > 0) dropNext();
        }
        if (dropped >= HOURGLASS_COIN_COUNT) wrap.classList.add("ready");
      };

      return () => {
        cancelled = true;
        applyProgressRef.current = null;
      };
    }

    // ---- pour-once mode (unchanged behavior) ----
    if (reduceMotion) {
      // No pour: land straight on the settled, glowing "ready" state so a
      // reduced-motion user still sees what it means, just without motion.
      botSlots.forEach((pos) => {
        const coin = makeCoin();
        coin.setAttribute("transform", `translate(${pos.x},${pos.y})`);
        botGroup.appendChild(coin);
      });
      wrap.classList.add("ready");
      onSettled?.();
      return;
    }

    const queue = topSlots.map((pos) => {
      const el = makeCoin();
      el.setAttribute("transform", `translate(${pos.x},${pos.y})`);
      topGroup.appendChild(el);
      return { el, pos };
    });

    let fillIndex = 0;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    function dropOne() {
      const next = queue.shift();
      if (!next) return;
      next.el.remove();
      const destPos = botSlots[fillIndex] ?? { x: 80, y: 200 };
      fillIndex++;
      animateOne(next.pos, destPos, () => {});
    }

    const dropEveryMs = Math.max(140, 1800 / HOURGLASS_COIN_COUNT);
    intervalId = setInterval(() => {
      dropOne();
      if (queue.length === 0) {
        if (intervalId) clearInterval(intervalId);
        intervalId = null;
        setTimeout(() => {
          if (!cancelled) {
            wrap.classList.add("ready");
            onSettled?.();
          }
        }, 380);
      }
    }, dropEveryMs);

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
    // Deliberately []: each mode is a one-time mount effect — sessionMode
    // reacts to later progress changes through applyProgressRef (see the
    // effect below) rather than by re-running this setup; pour-once mode
    // reads onSettled from the closure captured at mount, not re-subscribed
    // if a caller passes a new function identity on re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Feeds later progress values to the running session effect above without
  // tearing down and rebuilding the coins already on screen.
  useEffect(() => {
    if (progress === undefined) return;
    applyProgressRef.current?.(progress);
  }, [progress]);

  return (
    <div ref={wrapRef} className={`hg-wrap relative mx-auto ${className}`} aria-hidden="true">
      <svg viewBox={`${VB_X} ${VB_Y} ${VB_W} ${VB_H}`} width="100%" height="100%">
        <defs>
          {/* Brass, lit from the upper left — one gradient shared by every
              frame part so the cap, the posts and the base all agree about
              where the light falls. */}
          <linearGradient id="hgGold" x1="0" y1="0" x2="1" y2="0.3">
            <stop offset="0%" stopColor="#7d4c05" />
            <stop offset="18%" stopColor="#f7d68a" />
            <stop offset="42%" stopColor="#f2a417" />
            <stop offset="70%" stopColor="#c07a06" />
            <stop offset="100%" stopColor="#6b3f03" />
          </linearGradient>
          {/* Plate faces are lit TOP-DOWN, not left-right: a stack of turned
              plates only reads as having thickness if each one's own top edge
              catches the light and its underside falls into shadow. */}
          <linearGradient id="hgPlate" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffeab4" />
            <stop offset="32%" stopColor="#f2a417" />
            <stop offset="100%" stopColor="#673d03" />
          </linearGradient>
          <linearGradient id="hgGoldPost" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#5e3702" />
            <stop offset="14%" stopColor="#c98708" />
            <stop offset="30%" stopColor="#ffe6ab" />
            <stop offset="54%" stopColor="#e39a0d" />
            <stop offset="82%" stopColor="#8d5304" />
            <stop offset="100%" stopColor="#432601" />
          </linearGradient>
          <linearGradient id="hgGlass" x1="0.12" y1="0" x2="0.9" y2="1">
            <stop offset="0%" stopColor="#d8fffa" stopOpacity="0.5" />
            <stop offset="30%" stopColor="#66e0d8" stopOpacity="0.26" />
            <stop offset="72%" stopColor="#1e9aa0" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#9ff3ea" stopOpacity="0.38" />
          </linearGradient>
          {/* The broad soft highlight that makes glass read as glass — a wide
              wash down the lit side, not the thin hairline stroke that was
              doing this job on its own before. */}
          <linearGradient id="hgSheen" x1="0" y1="0" x2="1" y2="0.35">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.5" />
            <stop offset="48%" stopColor="#ffffff" stopOpacity="0.07" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          {/* The lamp in the crown, and the shaft of light it throws down
              through the upper glass. */}
          <radialGradient id="hgTopLight" cx="50%" cy="10%" r="66%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.98" />
            <stop offset="22%" stopColor="#fff3cd" stopOpacity="0.62" />
            <stop offset="52%" stopColor="#ffd98a" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#ffd98a" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="hgShaft" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.42" />
            <stop offset="38%" stopColor="#bdf6ee" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#3fe4d8" stopOpacity="0" />
          </linearGradient>
          {/* The bright pool of lit grains that gathers just above the neck. */}
          <radialGradient id="hgPool" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#f0fffb" stopOpacity="0.95" />
            <stop offset="42%" stopColor="#3fe4d8" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#3fe4d8" stopOpacity="0" />
          </radialGradient>
          {/* Ambient depth behind the whole piece, so the frame sits IN a
              scene instead of on a flat card. */}
          <radialGradient id="hgHalo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#2fd6cc" stopOpacity="0.2" />
            <stop offset="52%" stopColor="#12898f" stopOpacity="0.09" />
            <stop offset="100%" stopColor="#0b3d47" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="hgMedGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#fff6da" stopOpacity="0.85" />
            <stop offset="46%" stopColor="#ffd98a" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#ffd98a" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="hgPlatform" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#3fe4d8" stopOpacity="0.55" />
            <stop offset="60%" stopColor="#16bdb6" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#16bdb6" stopOpacity="0" />
          </radialGradient>
          {/* The arc strokes fade at BOTH ends on purpose — an arc that stops
              dead reads as a shape someone forgot to finish, where one that
              dissolves reads as a sweep of light. The gradient runs down the
              path's own bounding box (default objectBoundingBox units), so it
              keeps fading correctly if a radius or span is ever retuned. */}
          {/* ⚠️ THE ARC COLOURS COME FROM CSS CLASSES, NOT `stopColor`
              ATTRIBUTES, BECAUSE THEY HAVE TO CHANGE WITH THE SKIN. These
              near-white teal and gold values are tuned for the dark vault
              card; on the light skin the same artwork sits on a #ffffff card,
              where the gold arc and the gold dust are simply invisible. A
              presentation attribute cannot hold a `var()`, so the stop colour
              is set in globals.css off a theme variable — which is also what
              keeps the both-ends fade instead of flattening the arc to one
              solid colour per theme. */}
          <linearGradient id="hgArcT" x1="0" y1="0" x2="0" y2="1">
            <stop className="hg-stop-t-edge" offset="0%" stopOpacity="0" />
            <stop className="hg-stop-t-mid" offset="46%" stopOpacity="0.95" />
            <stop className="hg-stop-t-edge" offset="100%" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="hgArcG" x1="0" y1="0" x2="0" y2="1">
            <stop className="hg-stop-g-edge" offset="0%" stopOpacity="0" />
            <stop className="hg-stop-g-mid" offset="50%" stopOpacity="0.95" />
            <stop className="hg-stop-g-edge" offset="100%" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="hgCrystalA" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#7ff0e6" />
            <stop offset="100%" stopColor="#0e5560" />
          </linearGradient>
          <linearGradient id="hgCrystalB" x1="1" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2fa9a6" />
            <stop offset="100%" stopColor="#07323c" />
          </linearGradient>
          <linearGradient id="hgCoinGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ffd77a" />
            <stop offset="100%" stopColor="#e08e00" />
          </linearGradient>
          <linearGradient id="hgCoinFaceGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="100%" stopColor="#eaf6f2" />
          </linearGradient>
          <clipPath id="hgTopBulbClip">
            <path d="M40,26 L120,26 Q118,66 100,86 Q92,100 80,118 Q68,100 60,86 Q42,66 40,26 Z" />
          </clipPath>
          <clipPath id="hgBottomBulbClip">
            <path d="M40,214 L120,214 Q118,174 100,154 Q92,140 80,122 Q68,140 60,154 Q42,174 40,214 Z" />
          </clipPath>
        </defs>

        {/* ---- the scene behind the glass ---------------------------------
            Halo first, then the two arc sweeps. Everything in this block is
            a static fill or an opacity breathe — and there is deliberately no
            blur filter anywhere in this file: a soft radial gradient buys the
            same glow for a fraction of the paint cost on the low-end Android
            phones this app is built for. */}
        <ellipse cx="80" cy="118" rx="102" ry="126" fill="url(#hgHalo)" />
        {/* ⚠️ NOT ONE OF THESE CARRIES AN `opacity` ATTRIBUTE, AND THAT IS
            DELIBERATE. Each arc's brightness lives entirely in globals.css,
            because a CSS rule (never mind a keyframe) always beats an SVG
            presentation attribute — so an `opacity="0.16"` here would read as
            the wide glow's real value while doing absolutely nothing. Every
            arc's resting AND animated opacity is set by its class there,
            including the reduced-motion fallbacks. */}
        <g className="hg-arcs">
          <path className="hg-arc hg-arc-wide" d="M-4.8,175 A100,100 0 0 1 -0.9,63.2" fill="none" stroke="url(#hgArcT)" strokeWidth="7" strokeLinecap="round" />
          <path className="hg-arc" d="M-4.8,175 A100,100 0 0 1 -0.9,63.2" fill="none" stroke="url(#hgArcT)" strokeWidth="2" strokeLinecap="round" />
          <path className="hg-arc hg-arc-thin hg-arc-b" d="M0.3,154.2 A86,86 0 0 1 2.1,85.7" fill="none" stroke="url(#hgArcT)" strokeWidth="1.1" strokeLinecap="round" />
          <path className="hg-arc hg-arc-wide hg-arc-c" d="M161.4,71.1 A96,96 0 0 1 159.6,175.7" fill="none" stroke="url(#hgArcG)" strokeWidth="7" strokeLinecap="round" />
          <path className="hg-arc hg-arc-c" d="M161.4,71.1 A96,96 0 0 1 159.6,175.7" fill="none" stroke="url(#hgArcG)" strokeWidth="2" strokeLinecap="round" />
          <path className="hg-arc hg-arc-thin hg-arc-d" d="M175.9,87.1 A102,102 0 0 1 175.9,156.9" fill="none" stroke="url(#hgArcG)" strokeWidth="1.1" strokeLinecap="round" />
        </g>

        {/* the lit plinth it stands on */}
        <ellipse cx="80" cy="240" rx="82" ry="18" fill="url(#hgPlatform)" />
        <ellipse cx="80" cy="240" rx="56" ry="9" fill="#05202a" opacity="0.68" />
        <ellipse cx="80" cy="240" rx="56" ry="9" fill="none" stroke="#3fe4d8" strokeWidth="1.4" opacity="0.9" />
        <ellipse cx="80" cy="239" rx="42" ry="6" fill="none" stroke="#1c7f86" strokeWidth="0.9" opacity="0.7" />
        <path d="M40,243 Q80,250 120,243" fill="none" stroke="#9ff3ea" strokeWidth="1" strokeLinecap="round" opacity="0.45" />

        {/* Crystal shards. Each one is a five-sided shard — two SHOULDERS
            below an off-centre tip — split into a lit face and a shadowed
            face by a ridge, with a glint at the tip and low rubble around the
            base.

            ⚠️ NEVER DRAW THESE AS SYMMETRIC TRIANGLES WITH A CENTRED RIDGE.
            Two earlier attempts did (first tall and narrow, then wide and
            low) and both read unmistakably as PINE TREES, not crystal — in
            this teal palette a triangle with a light half and a dark half
            around a vertical spine is exactly a stylised conifer, and six of
            them along a base is a treeline. What actually reads as crystal is
            the asymmetry: an off-centre tip, shoulders that break the
            silhouette, and no two shards the same height.
            ⚠️ FOUR SHARDS, NOT SIX. Evenly spaced repeats along the plinth
            read as scenery however each one is drawn. */}
        <g className="hg-crystals">
          {/* left, tall shard */}
          <path d="M-2,241 L2,212 L13,184 L14,240 Z" fill="url(#hgCrystalB)" />
          <path d="M14,240 L13,184 L24,205 L28,238 Z" fill="url(#hgCrystalA)" />
          <path d="M13,184 L14,240" stroke="#b8fff4" strokeWidth="0.9" opacity="0.75" fill="none" />
          <path d="M2,212 L13,184 L24,205" stroke="#8ff8ec" strokeWidth="0.7" opacity="0.5" fill="none" />
          <circle cx="13" cy="185" r="1.7" fill="#e6fffc" opacity="0.9" />
          {/* left, short shard in front */}
          <path d="M-24,242 L-22,228 L-14,208 L-13,242 Z" fill="url(#hgCrystalB)" />
          <path d="M-13,242 L-14,208 L-6,222 L-4,242 Z" fill="url(#hgCrystalA)" opacity="0.9" />
          <path d="M-14,208 L-13,242" stroke="#b8fff4" strokeWidth="0.7" opacity="0.6" fill="none" />
          {/* right, tall shard */}
          <path d="M162,241 L158,212 L147,184 L146,240 Z" fill="url(#hgCrystalB)" />
          <path d="M146,240 L147,184 L136,205 L132,238 Z" fill="url(#hgCrystalA)" />
          <path d="M147,184 L146,240" stroke="#b8fff4" strokeWidth="0.9" opacity="0.75" fill="none" />
          <path d="M158,212 L147,184 L136,205" stroke="#8ff8ec" strokeWidth="0.7" opacity="0.5" fill="none" />
          <circle cx="147" cy="185" r="1.7" fill="#e6fffc" opacity="0.9" />
          {/* right, short shard in front */}
          <path d="M184,242 L182,228 L174,208 L173,242 Z" fill="url(#hgCrystalB)" />
          <path d="M173,242 L174,208 L166,222 L164,242 Z" fill="url(#hgCrystalA)" opacity="0.9" />
          <path d="M174,208 L173,242" stroke="#b8fff4" strokeWidth="0.7" opacity="0.6" fill="none" />
          {/* Low rubble on the plinth. Wide and flat, so it can only ever
              read as broken crystal lying down. */}
          <path d="M34,242 L44,236 L51,242 Z" fill="url(#hgCrystalA)" opacity="0.75" />
          <path d="M-12,243 L-4,239 L3,243 Z" fill="url(#hgCrystalA)" opacity="0.55" />
          <path d="M126,242 L116,236 L109,242 Z" fill="url(#hgCrystalA)" opacity="0.75" />
          <path d="M172,243 L164,239 L157,243 Z" fill="url(#hgCrystalA)" opacity="0.55" />
        </g>

        {/* ---- the brass frame ----------------------------------------
            Everything here is decoration around the glass. The two bulb
            paths and the neck below keep the EXACT coordinates the coin
            packing is built on; nothing in this block may move them.

            ⚠️ THE BASE IS DRAWN BEFORE THE GLASS AND MUST STAY THERE. The
            bottom bulb's first settled coin row sits at y = 210 and a coin is
            r = 5.2, so it spans 204.8..215.2 — straight through the base's top
            plate. Drawing the brass afterwards (which is how a real glass
            seats into its frame) hides most of that row. */}

        {/* base: three turned plates, a dark seam between them, and feet */}
        <rect x="17" y="206.4" width="126" height="8.6" rx="4" fill="url(#hgGold)" stroke="#5a3502" strokeWidth="0.7" />
        <rect x="21" y="207.6" width="118" height="1.8" rx="0.9" fill="#ffeec2" opacity="0.5" />
        <rect x="17" y="214.6" width="126" height="1.5" fill="#4b2c02" opacity="0.7" />
        <rect x="19" y="215.6" width="122" height="10" rx="4.5" fill="url(#hgGold)" stroke="#5a3502" strokeWidth="0.7" />
        <rect x="23" y="217" width="114" height="2" rx="1" fill="#fff1c6" opacity="0.55" />
        <rect x="24" y="225" width="112" height="7" rx="3.5" fill="url(#hgPlate)" stroke="#5a3502" strokeWidth="0.7" />
        <rect x="34" y="231" width="20" height="5" rx="2.5" fill="#6b3f03" />
        <rect x="106" y="231" width="20" height="5" rx="2.5" fill="#6b3f03" />

        {/* Posts: a lit column, a shadowed far edge, and bands GROUPED near
            each end rather than spaced evenly — even spacing reads as a
            ladder, grouped bands read as turned metal. */}
        {[26, 123].map((px) => (
          <g key={px}>
            <rect x={px} y="24" width="11" height="184" rx="5" fill="url(#hgGoldPost)" />
            <rect x={px + 2.4} y="26" width="2.2" height="180" rx="1.1" fill="#fff0c8" opacity="0.6" />
            <rect x={px + 9.1} y="26" width="1.5" height="180" rx="0.75" fill="#3d2201" opacity="0.45" />
            {[34, 43, 105, 175, 184].map((cy) => (
              <g key={cy}>
                <rect x={px - 1.8} y={cy} width="14.6" height="7" rx="3.2" fill="url(#hgGold)" stroke="#5a3502" strokeWidth="0.6" />
                <rect x={px - 0.4} y={cy + 1} width="11.8" height="1.7" rx="0.85" fill="#ffeec2" opacity="0.5" />
              </g>
            ))}
          </g>
        ))}

        {/* top cap: the mirror of the base, plus a bead row along its lower
            edge — the one detail that most separates "a gold rectangle" from
            "a cast brass cap". */}
        <rect x="17" y="19.4" width="126" height="8.6" rx="4" fill="url(#hgGold)" stroke="#5a3502" strokeWidth="0.7" />
        <rect x="21" y="20.6" width="118" height="1.8" rx="0.9" fill="#ffeec2" opacity="0.5" />
        <g fill="url(#hgGold)" stroke="#5a3502" strokeWidth="0.3">
          {[24, 32, 40, 48, 56, 64, 72, 80, 88, 96, 104, 112, 120, 128, 136].map((bx) => (
            <circle key={bx} cx={bx} cy="24.2" r="1.9" />
          ))}
        </g>
        <rect x="17" y="18" width="126" height="1.5" fill="#4b2c02" opacity="0.7" />
        <rect x="19" y="8.4" width="122" height="10" rx="4.5" fill="url(#hgGold)" stroke="#5a3502" strokeWidth="0.7" />
        <rect x="23" y="9.8" width="114" height="2" rx="1" fill="#fff1c6" opacity="0.55" />
        <rect x="24" y="2.4" width="112" height="7" rx="3.5" fill="url(#hgPlate)" stroke="#5a3502" strokeWidth="0.7" />

        {/* the mark on the crown, lit from behind */}
        <circle cx="80" cy="2" r="19" fill="url(#hgMedGlow)" />
        <circle cx="80" cy="2" r="12.5" fill="url(#hgGold)" stroke="#5a3502" strokeWidth="0.7" />
        <circle cx="80" cy="2" r="10.4" fill="none" stroke="#ffeec2" strokeWidth="0.8" opacity="0.55" />
        <circle cx="80" cy="2" r="9.2" fill="#062028" />
        <path d="M73,-3.4 Q80,-8 87,-3.4" fill="none" stroke="#9ff3ea" strokeWidth="1" opacity="0.4" strokeLinecap="round" />
        <text x="80" y="2" textAnchor="middle" dominantBaseline="central" fontSize="11" fontWeight="800" fill="#3fe4d8">R</text>

        {/* ---- the glass -------------------------------------------------
            These two paths and the neck are the load-bearing geometry: the
            clip paths in <defs> use the same two `d` strings, and the coin
            slots are packed against TOP_BULB / BOT_BULB. Restyled here, never
            reshaped. */}
        <path d="M40,26 L120,26 Q118,66 100,86 Q92,100 80,118 Q68,100 60,86 Q42,66 40,26 Z" fill="url(#hgGlass)" stroke="#7fe4dd" strokeWidth="1.5" strokeOpacity="0.7" />
        <path d="M40,214 L120,214 Q118,174 100,154 Q92,140 80,122 Q68,140 60,154 Q42,174 40,214 Z" fill="url(#hgGlass)" stroke="#7fe4dd" strokeWidth="1.5" strokeOpacity="0.7" />

        {/* The lamp, its shaft, the lit grains falling through it, and the
            pool they gather in above the neck. All clipped to the upper bulb
            so nothing leaks over the brass. */}
        <g clipPath="url(#hgTopBulbClip)">
          <rect x="40" y="26" width="80" height="92" fill="url(#hgTopLight)" />
          <path d="M66,26 L94,26 L88,114 L72,114 Z" fill="url(#hgShaft)" />
          <path d="M42,28 Q46,66 60,88 L48,92 Q40,58 40,28 Z" fill="url(#hgSheen)" />
          <ellipse cx="80" cy="110" rx="15" ry="7" fill="url(#hgPool)" />
          <g className="hg-sand">
            <circle cx="58" cy="34" r="1.2" fill="#bffdf6" />
            <circle cx="74" cy="30" r="0.9" fill="#ffe9b5" />
            <circle cx="92" cy="36" r="1.3" fill="#bffdf6" />
            <circle cx="106" cy="42" r="1" fill="#dffffb" />
            <circle cx="64" cy="50" r="1.1" fill="#ffe9b5" />
            <circle cx="84" cy="48" r="1.4" fill="#bffdf6" />
            <circle cx="100" cy="58" r="0.9" fill="#dffffb" />
            <circle cx="72" cy="64" r="1.2" fill="#bffdf6" />
            <circle cx="88" cy="72" r="1" fill="#ffe9b5" />
            <circle cx="80" cy="86" r="1.3" fill="#dffffb" />
          </g>
          {/* A few unmoving specks, for density without another animation. */}
          <g fill="#cffff9" opacity="0.5">
            <circle cx="68" cy="42" r="0.7" />
            <circle cx="96" cy="50" r="0.6" />
            <circle cx="78" cy="58" r="0.7" />
            <circle cx="90" cy="66" r="0.6" />
          </g>
        </g>

        {/* a matching rim wash on the lower bulb, so the glass reads as one
            piece rather than a bright half and a dull half */}
        <g clipPath="url(#hgBottomBulbClip)">
          <path d="M42,212 Q44,178 58,158 L48,154 Q40,180 40,212 Z" fill="url(#hgSheen)" opacity="0.7" />
        </g>

        {/* the neck, glowing gold where the coins pass through */}
        <g className="hg-neck">
          <ellipse cx="80" cy="120" rx="20" ry="9" fill="#ffd98a" opacity="0.14" />
          <ellipse cx="80" cy="120" rx="16" ry="7" fill="#ffd98a" opacity="0.22" />
          <ellipse cx="80" cy="120" rx="8.5" ry="3.2" fill="#fff0c4" />
          <ellipse cx="80" cy="120" rx="4" ry="1.5" fill="#ffffff" />
        </g>

        {/* tokens, populated imperatively above — see this file's header for why */}
        <g ref={topGroupRef} clipPath="url(#hgTopBulbClip)" />
        <g ref={botGroupRef} clipPath="url(#hgBottomBulbClip)" />
        <g ref={travelGroupRef} />
        {/* Specular highlight, drawn AFTER the coin groups on purpose: under
            them it vanishes the moment the bottom bulb fills up. */}
        <path d="M46,32 Q44,60 58,80" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M46,208 Q44,182 56,162" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="1.8" strokeLinecap="round" />
        <circle ref={splashRef} className="hg-splash" cx="80" cy="122" r="8" fill="none" stroke="var(--color-accent)" strokeWidth="1.6" />

        {/* ⚠️ THE GOLD MOTES LIVE IN THE SVG, NOT THE WRAPPER, ON PURPOSE.
            The wrapper's existing `.hg-working::after` dot is positioned in
            percentages of the BOX against art laid out in a viewBox — which
            is exactly why it had to be re-derived by hand the last time the
            viewBox grew. These sit in the same user units as the frame, so
            they follow it for free.

            Each mote drifts AWAY from the centre (its class picks which way),
            so while a session runs the field reads as spreading outward
            rather than as dots blinking in place. */}
        <g className="hg-motes">
          {GOLD_MOTES.map((m, i) => (
            <circle
              key={i}
              className={`hg-mote hg-mote-${m.dir}`}
              cx={m.x}
              cy={m.y}
              r={m.r}
              style={{ animationDelay: `${m.delay}s`, animationDuration: `${m.dur}s` }}
            />
          ))}
        </g>
      </svg>
      <span className="hg-sparkle s1" />
      <span className="hg-sparkle s2" />
      <span className="hg-sparkle s3" />
    </div>
  );
}
