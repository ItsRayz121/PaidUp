// Control experiment: the cheapest possible endpoint (no auth, no database).
// If this also collapses, the ceiling is the process/host, not the queries.
import http from 'k6/http';
import { check } from 'k6';
const BASE = __ENV.BASE || 'http://127.0.0.1:4100';
export const options = {
  scenarios: { h: { executor:'constant-arrival-rate', rate:Number(__ENV.RATE||500),
    timeUnit:'1s', duration:__ENV.DUR||'30s',
    preAllocatedVUs:200, maxVUs:2000 } },
};
export default function () {
  const r = http.get(`${BASE}/health`);
  check(r, { '200': (x) => x.status === 200 });
}
