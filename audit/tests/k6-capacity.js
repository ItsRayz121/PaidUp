import http from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";

// Do not run against production or third parties. Use an approved isolated API.
// TOKENS_FILE is a JSON array of unique test-user bearer tokens generated for
// that environment. One shared account would hide locks, cache misses, and
// per-user data growth.
const baseUrl = (__ENV.BASE_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
const tokens = new SharedArray("tokens", () =>
  JSON.parse(open(__ENV.TOKENS_FILE || "./tokens.json")));
const targetRps = Number(__ENV.TARGET_RPS || 10);
const duration = __ENV.DURATION || "2m";

export const options = {
  scenarios: {
    realistic_read_mix: {
      executor: "constant-arrival-rate",
      rate: targetRps,
      timeUnit: "1s",
      duration,
      preAllocatedVUs: Number(__ENV.PREALLOCATED_VUS || Math.max(20, targetRps)),
      maxVUs: Number(__ENV.MAX_VUS || Math.max(100, targetRps * 3)),
    },
  },
  thresholds: {
    checks: ["rate>0.99"],
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<750", "p(99)<1500"],
    dropped_iterations: ["count==0"],
  },
};

const journeys = [
  ["wallet_balance", "/wallet/balance", 45],
  ["task_feed", "/tasks", 25],
  ["mining_state", "/mining/state", 15],
  ["notifications", "/notifications", 10],
  ["profile", "/profile", 5],
];

function pickJourney() {
  let roll = Math.random() * 100;
  for (const j of journeys) {
    roll -= j[2];
    if (roll < 0) return j;
  }
  return journeys[0];
}

export default function () {
  const token = tokens[(__VU - 1) % tokens.length];
  const [name, path] = pickJourney();
  const res = http.get(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "x-device-id": `audit-vu-${__VU}`,
    },
    tags: { journey: name },
    timeout: "10s",
  });
  check(res, { [`${name}: status 200`]: (r) => r.status === 200 });
  sleep(Number(__ENV.THINK_SECONDS || 0));
}

