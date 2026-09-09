// The four milestones on /mine/roadmap, and what state each is in today.
//
// Dates only. The per-milestone island artwork that used to live here
// (`art`/`width`/`height`, four 1.3 MB PNGs) went unused when the page moved
// to the single baked "connected world" scene, and was deleted 2026-09-09 —
// the page only ever reads `key` to look the copy up in the deck.
export const ROADMAP_STEPS = [
  { key: "launch", start: "2026-08-01", end: "2026-09-30" },
  { key: "kyc", start: "2026-10-01", end: "2026-11-30" },
  { key: "dex", start: "2026-12-01", end: "2026-12-31" },
  { key: "cex", start: "2027-01-01", end: "2027-01-31" },
] as const;

export type RoadmapState = "done" | "active" | "upcoming" | "planned" | "scheduled";

// ISO calendar days keep the end date inclusive, including its final second.
// UTC gives every device the same schedule regardless of its local timezone.
export function roadmapStates(day: string | null): RoadmapState[] {
  if (day === null) return ROADMAP_STEPS.map(() => "scheduled");
  const states: RoadmapState[] = ROADMAP_STEPS.map((step) => {
    if (day > step.end) return "done";
    if (day >= step.start) return "active";
    return "planned";
  });
  const next = states.indexOf("planned");
  if (next >= 0) states[next] = "upcoming";
  return states;
}
