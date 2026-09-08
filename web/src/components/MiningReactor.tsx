// The mining reactor — the live "core" that is /mine's hero.
//
// ⚠️ PURELY DECORATIVE, and it reflects state that is ALREADY TRUE: it spins
// and pulses only while `active` (a real mining session is running) and sits
// paused + desaturated otherwise — exactly the rule the .mining-chamber rings
// and the claim hourglass already follow. It never stands in for the ROZI
// figure; the number and the countdown next to it are the exact values. All
// motion is transform / opacity (see globals.css `.reactor`); reduced-motion
// freezes it.
//
// Drawn as SVG rather than stacked CSS circles (founder, 2026-09-08, from a
// rendered mockup): the mockup's detail — an etched tick ring, two capped
// gauge arcs, a brushed inner bezel, a gold-rimmed core — is geometry, and
// geometry belongs in a viewBox. The pulse rings stay HTML spans because they
// bloom OUTSIDE the disc and would need a viewBox with dead margin all round.
//
// ⚠️ THE TWO GAUGE ARCS ARE STATIC AND MUST STAY STATIC. They never move and
// never fill, so they cannot read as "progress toward" anything — the same
// reason the single marigold arc they replace was static (founder,
// 2026-08-30). The only thing that rotates is the sweep, which has no start
// and no end.

// Ticks are generated rather than hand-listed: 72 of them at 5° apart, every
// sixth one longer and brighter, which is what makes the ring read as an
// etched instrument face instead of a dashed border.
const TICKS = Array.from({ length: 72 }, (_, i) => {
  const major = i % 6 === 0;
  const a = (i * 5 * Math.PI) / 180;
  const sin = Math.sin(a);
  const cos = -Math.cos(a);
  const r1 = major ? 68 : 71;
  const r2 = 78;
  return {
    key: i,
    x1: 100 + sin * r1,
    y1: 100 + cos * r1,
    x2: 100 + sin * r2,
    y2: 100 + cos * r2,
    major,
  };
});

export function MiningReactor({ active, size = 200 }: { active: boolean; size?: number }) {
  return (
    <div
      className={`reactor mx-auto${active ? "" : " is-idle"}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span className="r-ring" />
      <span className="r-ring" />
      <span className="r-ring" />
      <svg className="r-svg" viewBox="0 0 200 200" width="100%" height="100%">
        <defs>
          <radialGradient id="rDisc" cx="42%" cy="34%" r="78%">
            <stop offset="0%" stopColor="#0f3a41" />
            <stop offset="58%" stopColor="#08222a" />
            <stop offset="100%" stopColor="#04141b" />
          </radialGradient>
          <linearGradient id="rBezel" x1="0" y1="0" x2="0.4" y2="1">
            <stop offset="0%" stopColor="#5ff0e4" stopOpacity="0.55" />
            <stop offset="55%" stopColor="#12707a" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#8ef7ee" stopOpacity="0.4" />
          </linearGradient>
          <linearGradient id="rBand" x1="0.2" y1="0" x2="0.8" y2="1">
            <stop offset="0%" stopColor="#123c45" />
            <stop offset="46%" stopColor="#061a21" />
            <stop offset="100%" stopColor="#0e333c" />
          </linearGradient>
          <linearGradient id="rGoldRim" x1="0.1" y1="0" x2="0.9" y2="1">
            <stop offset="0%" stopColor="#ffe6a6" />
            <stop offset="42%" stopColor="#f2a417" />
            <stop offset="100%" stopColor="#9a5c05" />
          </linearGradient>
          <radialGradient id="rCore" cx="34%" cy="26%" r="88%">
            <stop offset="0%" stopColor="#e6fffb" />
            <stop offset="14%" stopColor="#8df2e9" />
            <stop offset="40%" stopColor="#2ec9c1" />
            <stop offset="72%" stopColor="#0d8188" />
            <stop offset="100%" stopColor="#032f38" />
          </radialGradient>
          {/* An inner shadow around the rim — without it the orb is a flat
              disc of colour rather than something with a surface. */}
          <radialGradient id="rCoreShade" cx="50%" cy="50%" r="50%">
            <stop offset="80%" stopColor="#000000" stopOpacity="0" />
            <stop offset="100%" stopColor="#01222a" stopOpacity="0.42" />
          </radialGradient>
          <linearGradient id="rSweep" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#5ff0e4" stopOpacity="0" />
            <stop offset="100%" stopColor="#a8fff6" stopOpacity="0.95" />
          </linearGradient>
        </defs>

        {/* the face */}
        <circle cx="100" cy="100" r="96" fill="url(#rDisc)" />
        <circle cx="100" cy="100" r="95.2" fill="none" stroke="url(#rBezel)" strokeWidth="1.6" />
        <circle cx="100" cy="100" r="88" fill="none" stroke="#0d454e" strokeWidth="6" opacity="0.5" />

        {/* the two gauge arcs — static, see the header */}
        <path
          className="r-arc r-arc-brand"
          d="M37.78 162.22 A88 88 0 0 1 84.72 13.34"
          fill="none"
          stroke="#3fe4d8"
          strokeWidth="7"
          strokeLinecap="round"
        />
        <path
          className="r-arc r-arc-gold"
          d="M144 23.79 A88 88 0 0 1 176.21 144"
          fill="none"
          stroke="#f2a417"
          strokeWidth="7"
          strokeLinecap="round"
        />

        {/* etched instrument ring */}
        <g className="r-ticks">
          {TICKS.map((t) => (
            <line
              key={t.key}
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
              stroke={t.major ? "#5fd8d0" : "#2b7d82"}
              strokeWidth={t.major ? 1.6 : 1}
              opacity={t.major ? 0.85 : 0.5}
            />
          ))}
        </g>

        {/* the one moving part: a sweep with no start and no end */}
        <g className="r-sweep">
          <path
            d="M26.3 74 A78 78 0 0 1 100 22"
            fill="none"
            stroke="url(#rSweep)"
            strokeWidth="5"
            strokeLinecap="round"
          />
          <circle cx="100" cy="22" r="2.6" fill="#d7fffa" />
        </g>

        {/* brushed inner bezel */}
        <circle cx="100" cy="100" r="64" fill="url(#rBand)" />
        <circle cx="100" cy="100" r="64" fill="none" stroke="#1d6a72" strokeWidth="1.2" opacity="0.8" />
        <circle cx="100" cy="100" r="56" fill="none" stroke="#0a2b33" strokeWidth="5" />
        <circle cx="100" cy="100" r="53" fill="none" stroke="#3ec9c2" strokeWidth="0.9" opacity="0.45" />

        {/* gold rim + core */}
        <circle cx="100" cy="100" r="48" fill="none" stroke="url(#rGoldRim)" strokeWidth="3.2" />
        <circle className="r-core" cx="100" cy="100" r="44" fill="url(#rCore)" />
        <circle cx="100" cy="100" r="44" fill="url(#rCoreShade)" />
        <ellipse cx="85" cy="80" rx="17" ry="10" fill="#ffffff" opacity="0.3" transform="rotate(-26 85 80)" />
        <path d="M68 122 Q100 140 132 122" fill="none" stroke="#bdfff7" strokeWidth="2" opacity="0.18" />
        <text
          className="r-mark"
          x="100"
          y="100"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="46"
          fontWeight="800"
        >
          R
        </text>

        {/* the mockup's drifting motes */}
        <circle className="r-mote m1" cx="46" cy="46" r="1.8" fill="#ffd98a" />
        <circle className="r-mote m2" cx="160" cy="66" r="1.5" fill="#8ef7ee" />
        <circle className="r-mote m3" cx="150" cy="158" r="1.7" fill="#ffd98a" />
        <circle className="r-mote m4" cx="42" cy="140" r="1.4" fill="#8ef7ee" />
      </svg>
    </div>
  );
}
