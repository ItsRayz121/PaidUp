// Builds the two derived /mine hero assets from the founder's own render
// (web/public/brand/mine-hero-v1.webp), plus the geometry the component needs
// to line up with them. Run it from api/ (it needs sharp):
//
//   node mine-hero-assets.cjs
//
// ⚠️ THIS IS A ONE-OFF, KEPT BECAUSE IT IS THE ONLY RECORD OF HOW THE ASSETS
// WERE MADE. If the render is ever re-cropped or replaced, every coordinate in
// here is measured against the OLD framing and must be re-measured — see the
// grid method in components/MiningHero.tsx's header.
//
// WHY IT EXISTS. The render bakes a full pile of nine coins into the lower
// bulb, which is why the 2026-09-08 hero had to retire the progress-linked
// coin split the founder asked for on 2026-08-30: you cannot empty a glass
// made of pixels. So we make an EMPTY glass and a separate PILE, and the
// component fills the one with the other as the session runs.
//
// It emits three files:
//   web/public/brand/mine-hero-empty-v1.webp  the render with the pile removed
//   web/public/brand/mine-hero-pile-v1.webp   the nine coins, cut out, alpha
//   web/src/components/mineHeroPile.ts        the coin geometry, generated
//
// ⚠️ THE GEOMETRY IS GENERATED, NOT COPIED. The component clips that sprite
// per coin, so its ellipses and the ones the sprite's alpha was cut with have
// to be the same numbers. Two hand-kept copies would drift, and the symptom
// would be a thin crescent of empty glass around a coin — which is exactly the
// kind of thing nobody notices in a diff.
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const SRC = path.join(__dirname, "../web/public/brand/mine-hero-v1.webp");
const OUT_EMPTY = path.join(__dirname, "../web/public/brand/mine-hero-empty-v1.webp");
const OUT_PILE = path.join(__dirname, "../web/public/brand/mine-hero-pile-v1.webp");
const OUT_TS = path.join(__dirname, "../web/src/components/mineHeroPile.ts");

// ---------------------------------------------------------------------------
// The pile, measured off the render. Each coin's centre came from walking out
// from its dark "R" mark to the gold rim's edges and taking the midpoint; the
// radii are from the one coin with no neighbour touching it (30 x 25 px),
// since a neighbouring coin's gold truncates that walk and makes the others
// read narrower than they really are.
//
// Order is the order they are REVEALED in: bottom row left to right, then the
// middle row, then the top two. A heap builds from the bottom.
const PILE = [
  { x: 331.0, y: 398 }, { x: 362.5, y: 398 }, { x: 395.5, y: 398 }, { x: 430.5, y: 397 },
  { x: 348.0, y: 378 }, { x: 378.5, y: 377 }, { x: 411.5, y: 384 },
  { x: 374.0, y: 351 }, { x: 393.5, y: 358 },
];
// A shade over the measured 15 / 12.5. ⚠️ ERR LARGE, NEVER SMALL. Too big
// borrows a ring of the neighbouring coin's own gold, which is invisible; too
// small leaves a crescent of the empty glass showing around the coin, which
// reads as a rendering fault.
const RX = 15.6;
const RY = 13.1;
const FEATHER = 1.2;
// The crop, with a couple of pixels of margin around the union above.
const CROP = { x: 313, y: 335, w: 137, h: 80 };

// ---------------------------------------------------------------------------
// Part 1 — the empty glass.
//
// The pile is removed by a harmonic (Laplace) inpaint: the coin pixels are
// detected, the mask is dilated so no boundary sample sits in the coins' own
// gold glow, and the hole is then filled by repeatedly averaging each masked
// pixel with its four neighbours until it settles. The boundary is the
// render's own glass, so the fill lands on exactly the colours the glass
// already has.

// The lower bulb's interior, in asset pixels. Kept clear of the brass columns
// (x < 306, x > 460) and of the brass base rim, whose top edge is y 406 — a
// boundary sample taken from the rim would bleed gold up into the glass.
const BOX = { x0: 310, x1: 452, y0: 334, y1: 405 };
// ⚠️ 14 WAS MEASURED, NOT PICKED, AND SMALLER VALUES FAIL IN A SPECIFIC WAY.
// At 5 and at 8 the fill still leaves a soft triangular mound — the ghost of
// the pile, a pile-shaped glow with no pile in it — because the boundary is
// still inside the coins' own baked glow at those radii. It clears at ~11 and
// is comfortably gone at 14; past ~20 the fill starts flattening the glass's
// own inner highlight curves. Compared at 5 / 8 / 11 / 14 / 17 / 20 at
// browser size, not guessed.
const DILATE = 14;
const ITERS = 900;

async function buildEmpty() {
  const { data, info } = await sharp(SRC).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const idx = (x, y) => (y * width + x) * channels;

  // Gold: red clearly above blue. The glass's own highlights are cyan-white
  // (blue >= green), so this separates coin from glass cleanly.
  const seed = new Uint8Array(width * height);
  for (let y = BOX.y0; y <= BOX.y1; y++) {
    for (let x = BOX.x0; x <= BOX.x1; x++) {
      const o = idx(x, y);
      const r = data[o], b = data[o + 2];
      if (r - b > 55 && r > 140) seed[y * width + x] = 1;
    }
  }
  // Fill the enclosed interiors. The detector only sees each coin's gold
  // RIM — its pale face and the dark teal "R" on it are not gold, and left
  // behind they show up as a row of floating letters on empty glass. So the
  // background is flooded inward from the box's top and side edges through
  // non-gold pixels, and any non-gold pixel the flood cannot reach is inside
  // a coin. ⚠️ The BOTTOM edge is deliberately not a flood seed: the lowest
  // coins are cut off by the brass rim, so their interiors are open downward
  // and a flood from there would leak straight into them.
  const reach = new Uint8Array(width * height);
  const stack = [];
  const push = (x, y) => {
    if (x < BOX.x0 || x > BOX.x1 || y < BOX.y0 || y > BOX.y1) return;
    const i = y * width + x;
    if (reach[i] || seed[i]) return;
    reach[i] = 1;
    stack.push(i);
  };
  for (let x = BOX.x0; x <= BOX.x1; x++) push(x, BOX.y0);
  for (let y = BOX.y0; y <= BOX.y1; y++) { push(BOX.x0, y); push(BOX.x1, y); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % width, y = (i - x) / width;
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
  }
  for (let y = BOX.y0; y <= BOX.y1; y++) {
    for (let x = BOX.x0; x <= BOX.x1; x++) {
      const i = y * width + x;
      if (!reach[i]) seed[i] = 1;
    }
  }

  const mask = new Uint8Array(width * height);
  for (let y = BOX.y0; y <= BOX.y1; y++) {
    for (let x = BOX.x0; x <= BOX.x1; x++) {
      let hit = 0;
      for (let dy = -DILATE; dy <= DILATE && !hit; dy++) {
        for (let dx = -DILATE; dx <= DILATE; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (dx * dx + dy * dy > DILATE * DILATE) continue;
          if (seed[ny * width + nx]) { hit = 1; break; }
        }
      }
      if (hit) mask[y * width + x] = 1;
    }
  }

  // Seed the hole with a per-row horizontal ramp between its two glass
  // anchors, so the relaxation starts close to the answer.
  const cur = Float32Array.from(data);
  for (let y = BOX.y0; y <= BOX.y1; y++) {
    let x = BOX.x0;
    while (x <= BOX.x1) {
      if (!mask[y * width + x]) { x++; continue; }
      let e = x;
      while (e <= BOX.x1 && mask[y * width + e]) e++;
      const lo = idx(x - 1, y), hi = idx(e, y);
      for (let k = x; k < e; k++) {
        const t = (k - x + 1) / (e - x + 1);
        const o = idx(k, y);
        for (let c = 0; c < 3; c++) cur[o + c] = data[lo + c] * (1 - t) + data[hi + c] * t;
      }
      x = e;
    }
  }

  // Jacobi relaxation. ⚠️ At the mask's bottom row the pixel BELOW is the
  // brass rim, so that neighbour is dropped (a no-flux edge) rather than used
  // — otherwise the rim's gold is pulled up into the glass.
  const next = Float32Array.from(cur);
  for (let it = 0; it < ITERS; it++) {
    for (let y = BOX.y0; y <= BOX.y1; y++) {
      for (let x = BOX.x0; x <= BOX.x1; x++) {
        if (!mask[y * width + x]) continue;
        const o = idx(x, y);
        const useDown = y < BOX.y1;
        for (let c = 0; c < 3; c++) {
          let s = cur[idx(x - 1, y) + c] + cur[idx(x + 1, y) + c] + cur[idx(x, y - 1) + c];
          let n = 3;
          if (useDown) { s += cur[idx(x, y + 1) + c]; n = 4; }
          next[o + c] = s / n;
        }
      }
    }
    cur.set(next);
  }

  const out = Buffer.from(data);
  let masked = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    masked++;
    const o = i * channels;
    for (let c = 0; c < 3; c++) out[o + c] = Math.max(0, Math.min(255, Math.round(cur[o + c])));
  }

  await sharp(out, { raw: { width, height, channels } }).webp({ quality: 84 }).toFile(OUT_EMPTY);
  console.log(`empty glass: ${masked} px repainted -> ${path.basename(OUT_EMPTY)}`);
}

// ---------------------------------------------------------------------------
// Part 2 — the pile, cut out of the same render.
//
// ⚠️ THE COINS ARE THE RENDER'S OWN PIXELS, NOT A REDRAW, AND THAT IS THE
// WHOLE POINT. Hand-matched vector coins were tried first, at several sizes,
// face ratios and rim gradients, and none of them sat convincingly next to the
// render's own shading — each read as too bright, too flat, or too large.
// Cutting the real ones out costs 5KB and is exact by construction.
async function buildPile() {
  const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, channels } = info;
  const out = Buffer.alloc(CROP.w * CROP.h * 4, 0);
  for (let j = 0; j < CROP.h; j++) {
    for (let i = 0; i < CROP.w; i++) {
      const x = CROP.x + i, y = CROP.y + j;
      // Alpha is the union of the nine ellipses, feathered at the boundary so
      // the cut is not a hard ring.
      let a = 0;
      for (const c of PILE) {
        const d = Math.hypot((x - c.x) / RX, (y - c.y) / RY);
        const v = Math.max(0, Math.min(1, (1 - d) * (RX / FEATHER) + 0.5));
        if (v > a) a = v;
      }
      if (a <= 0) continue;
      const s = (y * width + x) * channels, o = (j * CROP.w + i) * 4;
      out[o] = data[s]; out[o + 1] = data[s + 1]; out[o + 2] = data[s + 2];
      out[o + 3] = Math.round(a * 255);
    }
  }
  await sharp(out, { raw: { width: CROP.w, height: CROP.h, channels: 4 } })
    .webp({ quality: 92, alphaQuality: 100 })
    .toFile(OUT_PILE);
  console.log(`pile sprite: ${CROP.w}x${CROP.h} -> ${path.basename(OUT_PILE)}`);
}

function writeGeometry() {
  const body = `// GENERATED by api/mine-hero-assets.cjs — do not edit by hand.
//
// The nine coins the /mine hero fills its glass with, in the render's own
// pixel coordinates. These are the same ellipses the pile sprite's alpha was
// cut with, which is why this file is generated rather than kept in step by
// hand: the two drifting apart shows up as a crescent of empty glass around a
// coin, and nothing about that is visible in a diff.
//
// Order is the order they are revealed in — bottom row left to right, then the
// middle row, then the top two, because a heap builds from the bottom.

/** Where the sprite sits in the art, and how big it is. */
export const PILE_SPRITE = { x: ${CROP.x}, y: ${CROP.y}, w: ${CROP.w}, h: ${CROP.h} } as const;

/** The cut-out radius of one coin. */
export const PILE_RX = ${RX};
export const PILE_RY = ${RY};

/** Coin centres, in reveal order. */
export const PILE_COINS: ReadonlyArray<{ x: number; y: number }> = [
${PILE.map((c) => `  { x: ${c.x}, y: ${c.y} },`).join("\n")}
];
`;
  fs.writeFileSync(OUT_TS, body);
  console.log(`geometry:    ${PILE.length} coins -> ${path.basename(OUT_TS)}`);
}

(async () => {
  await buildEmpty();
  await buildPile();
  writeGeometry();
})();
