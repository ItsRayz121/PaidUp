import assert from "node:assert/strict";
import test from "node:test";
import { roadmapStates } from "../src/lib/roadmap.ts";

test("cached HTML has neutral states until the browser supplies today's date", () => {
  assert.deepEqual(roadmapStates(null), Array(4).fill("scheduled"));
});

for (const [day, expected] of [
  ["2026-07-31", ["upcoming", "planned", "planned", "planned"]],
  ["2026-08-01", ["active", "upcoming", "planned", "planned"]],
  ["2026-09-30", ["active", "upcoming", "planned", "planned"]],
  ["2026-10-01", ["done", "active", "upcoming", "planned"]],
  ["2026-11-30", ["done", "active", "upcoming", "planned"]],
  ["2026-12-01", ["done", "done", "active", "upcoming"]],
  ["2026-12-31", ["done", "done", "active", "upcoming"]],
  ["2027-01-01", ["done", "done", "done", "active"]],
  ["2027-01-31", ["done", "done", "done", "active"]],
  ["2027-02-01", ["done", "done", "done", "done"]],
]) {
  test(`schedule boundaries on ${day}`, () => {
    assert.deepEqual(roadmapStates(day), expected);
  });
}
