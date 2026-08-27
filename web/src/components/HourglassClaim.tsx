"use client";

// The "claim your ROZI" hourglass — wood caps, black metal posts, rounded
// glass bulbs, filled with real RoziPay-mark coins instead of sand (founder,
// 2026-08-13, refined from a photo reference + a coins-not-sand request).
//
// ⚠️ THE COIN COUNT IS PURELY DECORATIVE, NEVER A READING OF THE REAL AMOUNT.
// `s.claimableMicro` (the real, exact ROZI figure) is already shown as text
// right next to this component, unchanged — that is the number a user should
// trust. A fixed coin count here is the same choice the mining-chamber rings
// and gem-glint already make (CLAUDE.md): decorative motion that reflects a
// real STATE ("something is ready"), never a number nobody asked this widget
// to compute. Do not wire COIN_COUNT to claimableMicro — a claim of 0.004
// ROZI would round to zero visible coins, and a big one would overflow the
// glass; neither is what this animation is for.
//
// The pour plays ONCE per mount, then settles into a static glowing "ready"
// state. It is only ever mounted while `s.claimableMicro > 0` is already
// true (see app/mine/page.tsx), so the animation is triggered by a real state
// transition (unclaimed ROZI newly existing, or the page loading with some
// already waiting) — never a fake countdown against a timer nothing backs.
import { useEffect, useRef } from "react";

const VB_W = 160;
const VB_H = 246;
const NECK = { x: 80, y: 120 };
const TOP_BULB = { wideY: 30, narrowY: 112, maxHalf: 34, minHalf: 5, rowStep: 13, spacing: 13 };
const BOT_BULB = { wideY: 210, narrowY: 130, maxHalf: 34, minHalf: 5, rowStep: 13, spacing: 13 };
const COIN_COUNT = 14;
const SVG_NS = "http://www.w3.org/2000/svg";

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

export function HourglassClaim({
  className = "",
  onSettled,
}: {
  className?: string;
  // Fires once, the moment the pour finishes and the glass settles into its
  // static "ready" glow — lets a caller (e.g. the Start Mining button) swap
  // this decorative overlay back out for the real state view without
  // duplicating this file's pour-duration math anywhere else.
  onSettled?: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const topGroupRef = useRef<SVGGElement>(null);
  const botGroupRef = useRef<SVGGElement>(null);
  const travelGroupRef = useRef<SVGGElement>(null);
  const splashRef = useRef<SVGCircleElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const topGroup = topGroupRef.current;
    const botGroup = botGroupRef.current;
    const travelGroup = travelGroupRef.current;
    const splash = splashRef.current;
    if (!wrap || !topGroup || !botGroup || !travelGroup || !splash) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const topSlots = generateSlots(COIN_COUNT, TOP_BULB);
    const botSlots = generateSlots(COIN_COUNT, BOT_BULB);

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

      const travel = makeCoin();
      travelGroup!.appendChild(travel);
      const start = next.pos;
      const dur = 340;
      const t0 = performance.now();
      function frame(now: number) {
        if (cancelled) return;
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
        }
      }
      requestAnimationFrame(frame);
    }

    const dropEveryMs = Math.max(140, 1800 / COIN_COUNT);
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
    // Deliberately []: the pour is a one-time mount effect (this file's own
    // header), so onSettled is read from the closure captured at mount, not
    // re-subscribed if a caller passes a new function identity on re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={wrapRef} className={`hg-wrap relative mx-auto ${className}`} aria-hidden="true">
      <svg viewBox={`0 0 ${VB_W} ${VB_H}`} width="100%" height="100%">
        <defs>
          <linearGradient id="hgWoodGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#8a4a30" />
            <stop offset="100%" stopColor="#42210f" />
          </linearGradient>
          <linearGradient id="hgCoinGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ffd77a" />
            <stop offset="100%" stopColor="#e08e00" />
          </linearGradient>
          <linearGradient id="hgCoinFaceGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="100%" stopColor="#eaf6f2" />
          </linearGradient>
          <linearGradient id="hgMetalGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#4a4e54" />
            <stop offset="50%" stopColor="#2b2d31" />
            <stop offset="100%" stopColor="#1c1d20" />
          </linearGradient>
          <clipPath id="hgTopBulbClip">
            <path d="M40,26 L120,26 Q118,66 100,86 Q92,100 80,118 Q68,100 60,86 Q42,66 40,26 Z" />
          </clipPath>
          <clipPath id="hgBottomBulbClip">
            <path d="M40,214 L120,214 Q118,174 100,154 Q92,140 80,122 Q68,140 60,154 Q42,174 40,214 Z" />
          </clipPath>
        </defs>

        {/* wood caps */}
        <rect x="26" y="6" width="108" height="18" rx="4" fill="url(#hgWoodGrad)" stroke="#20100a" strokeWidth="1" />
        <rect x="31" y="9" width="98" height="3" rx="1.5" fill="#c98a5e" opacity="0.5" />
        <rect x="26" y="214" width="108" height="18" rx="4" fill="url(#hgWoodGrad)" stroke="#20100a" strokeWidth="1" />
        <rect x="31" y="217" width="98" height="3" rx="1.5" fill="#c98a5e" opacity="0.35" />
        <circle cx="46" cy="238" r="4" fill="#1c1c1c" />
        <circle cx="114" cy="238" r="4" fill="#1c1c1c" />

        {/* metal posts */}
        <rect x="30" y="24" width="5" height="190" rx="2.5" fill="url(#hgMetalGrad)" />
        <rect x="125" y="24" width="5" height="190" rx="2.5" fill="url(#hgMetalGrad)" />
        <circle cx="32.5" cy="22" r="5" fill="#2b2d31" />
        <circle cx="32.5" cy="216" r="5" fill="#2b2d31" />
        <circle cx="127.5" cy="22" r="5" fill="#2b2d31" />
        <circle cx="127.5" cy="216" r="5" fill="#2b2d31" />

        {/* glass — a light phone background means a white-on-white stroke
            disappears, so this uses a visible dark rim + a soft teal tint
            rather than a translucent white line on a translucent white fill. */}
        <path d="M40,26 L120,26 Q118,66 100,86 Q92,100 80,118 Q68,100 60,86 Q42,66 40,26 Z" fill="rgba(190,222,220,0.28)" stroke="rgba(8,47,54,0.55)" strokeWidth="2" />
        <path d="M40,214 L120,214 Q118,174 100,154 Q92,140 80,122 Q68,140 60,154 Q42,174 40,214 Z" fill="rgba(190,222,220,0.28)" stroke="rgba(8,47,54,0.55)" strokeWidth="2" />
        <path d="M46,32 Q44,60 58,80" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2.2" strokeLinecap="round" />

        {/* tokens, populated imperatively above — see this file's header for why */}
        <g ref={topGroupRef} clipPath="url(#hgTopBulbClip)" />
        <g ref={botGroupRef} clipPath="url(#hgBottomBulbClip)" />
        <g ref={travelGroupRef} />
        <circle ref={splashRef} className="hg-splash" cx="80" cy="122" r="8" fill="none" stroke="var(--color-accent)" strokeWidth="1.6" />
      </svg>
      <span className="hg-sparkle s1" />
      <span className="hg-sparkle s2" />
      <span className="hg-sparkle s3" />
    </div>
  );
}
