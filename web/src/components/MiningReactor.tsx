// The mining reactor — a small live "core" shown on /mine's speed panel
// (design direction A / "the Wallet look").
//
// ⚠️ PURELY DECORATIVE, and it reflects state that is ALREADY TRUE: it spins
// and pulses only while `active` (a real mining session is running) and sits
// paused + desaturated otherwise — exactly the rule the .mining-chamber rings
// and the claim hourglass already follow. It never stands in for the ROZI
// figure; the number and the countdown next to it are the exact values. All
// motion is transform / opacity (see globals.css `.reactor`); reduced-motion
// freezes it.
export function MiningReactor({ active, size = 84 }: { active: boolean; size?: number }) {
  return (
    <div
      className={`reactor mx-auto${active ? "" : " is-idle"}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span className="r-ring" />
      <span className="r-ring" />
      <span className="r-ring" />
      <span className="r-spin" />
      <span className="r-core" />
    </div>
  );
}
