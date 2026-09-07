// Decorative isometric-style illustrations for /mine/roadmap only. Brand /
// marketing art, deliberately kept OUT of icons.tsx (that file is
// outline-only, functional UI icons — see its own header). Same reasoning
// tokenIcons.tsx already used to split itself out.
//
// Every fill/stroke below reads a CSS custom property (var(--color-brand),
// etc.) rather than a hardcoded hex — that is what lets one illustration
// render correctly in both the light theme and the default dark "Deep
// Vault" theme with zero theme-detection code (founder, 2026-09-07: "keep
// the app look either light or dark, just illustrate as shown"). Never
// hardcode a color here; if a new shade is needed, it belongs in
// globals.css as a token, not inline in this file.
//
// Purely decorative — same rule as AmbientBg and the mining-chamber rings:
// never interactive, never load-bearing for meaning (every illustration
// sits beside real text that says the same thing in words).

function Ground({ cx, cy, rx, ry }: { cx: number; cy: number; rx: number; ry: number }) {
  return (
    <>
      <ellipse cx={cx} cy={cy + 5} rx={rx} ry={ry} fill="var(--color-line)" opacity={0.5} />
      <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="var(--color-brand-tint)" stroke="var(--color-line)" />
    </>
  );
}

function Tree({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <rect x={-2} y={6} width={4} height={9} rx={1} fill="var(--color-brand-ink)" opacity={0.5} />
      <path d="M0 -16 L11 8 L-11 8 Z" fill="var(--color-success)" />
      <path d="M0 -8 L8 8 L-8 8 Z" fill="var(--color-success)" opacity={0.85} />
    </g>
  );
}

/** The hero mountain scene: a winding trail to a flagged summit. */
export function MountainHero({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 320 210" className={className} aria-hidden="true">
      {/* soft clouds */}
      <g className="rm-cloud" opacity={0.55}>
        <ellipse cx="46" cy="34" rx="26" ry="10" fill="var(--color-card)" />
        <ellipse cx="66" cy="30" rx="18" ry="9" fill="var(--color-card)" />
      </g>
      <g className="rm-cloud rm-cloud-2" opacity={0.4}>
        <ellipse cx="272" cy="58" rx="22" ry="8" fill="var(--color-card)" />
        <ellipse cx="256" cy="54" rx="14" ry="7" fill="var(--color-card)" />
      </g>

      {/* mountain body — back peak, then front peak on top for depth */}
      <path d="M40 190 L150 26 L200 92 L232 190 Z" fill="var(--color-brand-tint)" />
      <path d="M90 190 L182 10 L292 190 Z" fill="var(--color-brand)" />
      <path d="M182 10 L214 58 L166 58 Z" fill="var(--color-card)" opacity={0.9} />
      <path
        d="M90 190 L182 10 L292 190 L246 190 L182 78 L118 190 Z"
        fill="var(--color-brand-ink)"
        opacity={0.18}
      />

      {/* winding trail */}
      <path
        d="M182 22 C 158 66, 214 82, 176 118 C 146 148, 214 150, 190 190"
        fill="none"
        stroke="var(--color-card)"
        strokeWidth={5}
        strokeLinecap="round"
        strokeDasharray="1 13"
        opacity={0.9}
      />

      {/* summit flag */}
      <g className="rm-flag" transform="translate(182 10)">
        <rect x={-1.5} y={-38} width={3} height={38} rx={1.5} fill="var(--color-brand-ink)" />
        <rect x={1.5} y={-38} width={22} height={16} rx={3} fill="var(--color-brand)" />
        <text x={12.5} y={-26.5} textAnchor="middle" fontSize={11} fontWeight={700} fill="var(--color-card)">R</text>
      </g>

      <Tree x={54} y={182} scale={1.15} />
      <Tree x={272} y={182} scale={1.3} />
      <Tree x={296} y={192} scale={0.9} />
    </svg>
  );
}

function Plaque({ x, y, w = 128, label }: { x: number; y: number; w?: number; label: string }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(-2)`}>
      <rect x={0} y={0} width={w} height={17} rx={4.5} fill="var(--color-brand-ink)" />
      <text
        x={w / 2}
        y={11.5}
        textAnchor="middle"
        fontSize={7}
        fontWeight={700}
        letterSpacing={0.4}
        fill="var(--color-card)"
        style={{ textTransform: "uppercase" }}
      >
        {label}
      </text>
    </g>
  );
}

type Kind = "launch" | "kyc" | "dex" | "cex";

const KIND_LABEL: Record<Kind, string> = {
  launch: "Mine together",
  kyc: "A safer community",
  dex: "More opportunity",
  cex: "A global future",
};

// Every scene below keeps its content inside y≈[16,96] — the shared budget
// that leaves room for the Ground ellipse (≈97-127) and the Plaque banner
// (≈118-135) MilestoneArt draws underneath every one of them, in a 200×160
// viewBox. Change one scene's vertical extent and it will collide with the
// platform or the sign — check both before widening anything.

function LaunchScene() {
  return (
    <>
      <Tree x={30} y={90} scale={0.85} />
      <Tree x={172} y={92} scale={0.95} />
      {/* mining badge */}
      <rect x={68} y={30} width={52} height={52} rx={14} fill="var(--color-brand)" />
      <path
        d="M94 44 l14 14 m-4 -18 l8 8 m-22 8 l6 6 -3 8 -8-3 z"
        fill="none"
        stroke="var(--color-card)"
        strokeWidth={3.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* a small rig chip beside it */}
      <g transform="translate(128 50) rotate(-6)">
        <rect x={0} y={0} width={30} height={38} rx={5} fill="var(--color-card)" stroke="var(--color-line)" />
        <circle cx={9} cy={10} r={2.4} fill="var(--color-brand)" />
        <circle cx={21} cy={10} r={2.4} fill="var(--color-brand)" />
        <rect x={6} y={19} width={18} height={3} rx={1.5} fill="var(--color-line)" />
        <rect x={6} y={26} width={12} height={3} rx={1.5} fill="var(--color-line)" />
      </g>
    </>
  );
}

function KycScene() {
  return (
    <>
      <path
        d="M100 20 L130 30 V56 C130 78 116 90 100 96 C84 90 70 78 70 56 V30 Z"
        fill="var(--color-brand)"
      />
      <circle cx={100} cy={54} r={9} fill="var(--color-card)" />
      <path d="M87 80 c0-9 6-14 13-14 s13 5 13 14" fill="var(--color-card)" />
      <g transform="translate(112 62) rotate(8)">
        <rect x={0} y={0} width={40} height={27} rx={5} fill="var(--color-card)" stroke="var(--color-line)" />
        <circle cx={9} cy={10} r={4.5} fill="var(--color-brand-tint)" stroke="var(--color-brand)" />
        <rect x={18} y={6} width={16} height={2.6} rx={1.3} fill="var(--color-line)" />
        <rect x={18} y={11.5} width={12} height={2.6} rx={1.3} fill="var(--color-line)" />
        <rect x={5} y={20} width={30} height={2.6} rx={1.3} fill="var(--color-brand-tint)" />
      </g>
    </>
  );
}

function DexScene() {
  const bars = [8, 18, 11, 24, 15, 20];
  return (
    <>
      <rect x={44} y={26} width={112} height={62} rx={8} fill="var(--color-card)" stroke="var(--color-line)" />
      <g transform="translate(58 80)">
        {bars.map((h, i) => (
          <rect
            key={i}
            x={i * 15}
            y={-h}
            width={7}
            height={h}
            rx={1.5}
            fill={i % 2 === 0 ? "var(--color-success)" : "var(--color-danger)"}
          />
        ))}
      </g>
      <g transform="translate(50 92)">
        <rect x={0} y={0} width={38} height={16} rx={8} fill="var(--color-success)" />
        <text x={19} y={11} textAnchor="middle" fontSize={7.5} fontWeight={700} fill="var(--color-card)">BUY</text>
      </g>
      <g transform="translate(112 92)">
        <rect x={0} y={0} width={38} height={16} rx={8} fill="var(--color-danger)" />
        <text x={19} y={11} textAnchor="middle" fontSize={7.5} fontWeight={700} fill="var(--color-card)">SELL</text>
      </g>
      <circle cx={34} cy={40} r={9} fill="var(--color-pending-tint)" stroke="var(--color-pending)" strokeWidth={1.5} />
      <circle cx={172} cy={58} r={7} fill="var(--color-pending-tint)" stroke="var(--color-pending)" strokeWidth={1.5} />
    </>
  );
}

function CexScene() {
  const buildings = [
    { x: 38, w: 20, h: 40 },
    { x: 62, w: 24, h: 68 },
    { x: 158, w: 18, h: 30 },
  ];
  return (
    <>
      {buildings.map((b, i) => (
        <rect
          key={i}
          x={b.x}
          y={94 - b.h}
          width={b.w}
          height={b.h}
          rx={3}
          fill={i % 2 === 0 ? "var(--color-brand)" : "var(--color-brand-ink)"}
          opacity={i % 2 === 0 ? 1 : 0.85}
        />
      ))}
      <g transform="translate(74 18)">
        <rect x={-9} y={-9} width={18} height={18} rx={5} fill="var(--color-brand)" />
        <text x={0} y={4} textAnchor="middle" fontSize={11} fontWeight={700} fill="var(--color-card)">R</text>
      </g>
      <circle cx={128} cy={86} r={20} fill="var(--color-brand-tint)" stroke="var(--color-brand)" strokeWidth={1.5} opacity={0.92} />
      <path
        d="M108 86 h40 M128 66 v40 M115 75 q13 11 26 0 M115 97 q13 -11 26 0"
        fill="none"
        stroke="var(--color-brand)"
        strokeWidth={1}
        opacity={0.6}
      />
    </>
  );
}

const SCENES = { launch: LaunchScene, kyc: KycScene, dex: DexScene, cex: CexScene };

/** One floating "island" illustration per roadmap milestone. */
export function MilestoneArt({ kind, className = "" }: { kind: Kind; className?: string }) {
  const Scene = SCENES[kind];
  return (
    <svg viewBox="0 0 200 160" className={className} aria-hidden="true">
      <Ground cx={100} cy={112} rx={84} ry={15} />
      <Scene />
      <Plaque x={36} y={118} label={KIND_LABEL[kind]} />
    </svg>
  );
}
