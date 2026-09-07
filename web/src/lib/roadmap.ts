export const ROADMAP_STEPS = [
  { key: "launch", start: "2026-08-01", end: "2026-09-30", art: "/roadmap/island-mining-v2.png", width: 1440, height: 1092 },
  { key: "kyc", start: "2026-10-01", end: "2026-11-30", art: "/roadmap/island-kyc-v2.png", width: 1402, height: 1122 },
  { key: "dex", start: "2026-12-01", end: "2026-12-31", art: "/roadmap/island-trading-v2.png", width: 1461, height: 1076 },
  { key: "cex", start: "2027-01-01", end: "2027-01-31", art: "/roadmap/island-global-v2.png", width: 1536, height: 1024 },
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
