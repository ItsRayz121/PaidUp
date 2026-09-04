// AUDIT-ONLY load test. Models real earner SCREEN VISITS (each iteration issues
// the same fan-out of API calls the Next.js screen actually makes on mount),
// using a constant-arrival-rate executor so a slow server does NOT silently
// reduce the offered load.
//
// Run:  k6 run -e STAGE=<rate> -e DUR=60s k6-journeys.js
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const BASE = __ENV.BASE || 'http://127.0.0.1:4100';
const RATE = Number(__ENV.STAGE || 10);      // screen visits per second
const DUR = __ENV.DUR || '60s';

const users = new SharedArray('users', () =>
  JSON.parse(open(__ENV.TOKENS || './tokens.json')));

const screenTime = new Trend('screen_duration', true);
const screenErr = new Counter('screen_errors');
const perScreen = {
  home: new Trend('screen_home', true),
  mine: new Trend('screen_mine', true),
  wallet: new Trend('screen_wallet', true),
  tasks: new Trend('screen_tasks', true),
  refer: new Trend('screen_refer', true),
};

export const options = {
  discardResponseBodies: false,
  scenarios: {
    screens: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DUR,
      preAllocatedVUs: Math.max(50, RATE * 4),
      maxVUs: Math.max(400, RATE * 30),
    },
  },
  thresholds: {
    // Provisional engineering gates, stated as assumptions in the report.
    'http_req_failed': ['rate<0.01'],
    'http_req_duration': ['p(95)<750', 'p(99)<1500'],
    'dropped_iterations': ['count<1'],
  },
};

// Fan-out per screen, taken from the client audit of what each page calls on mount.
const SCREENS = {
  home:   ['/features', '/content/home', '/mining/state', '/wallet/balance', '/notifications'],
  mine:   ['/mining/state', '/mining/rigs', '/mining/history', '/mining/boosters'],
  wallet: ['/wallet/balance', '/wallet/ledger', '/usdt', '/withdrawals',
           '/withdrawals/addresses', '/mining/state', '/wallet/bnb/withdrawals',
           '/wallet/usdt-task-rewards'],
  tasks:  ['/tasks'],
  refer:  ['/referrals/me', '/leaderboard'],
};

function pickScreen() {
  const r = Math.random();
  if (r < 0.35) return 'home';
  if (r < 0.65) return 'mine';
  if (r < 0.85) return 'wallet';
  if (r < 0.95) return 'tasks';
  return 'refer';
}

export default function () {
  const u = users[Math.floor(Math.random() * users.length)];
  const name = pickScreen();
  const paths = SCREENS[name];
  const headers = {
    Authorization: `Bearer ${u.t}`,
    'x-device-id': u.d,
    'content-type': 'application/json',
  };

  const t0 = Date.now();
  // The real screens fire their calls in parallel, so this does too.
  const responses = http.batch(paths.map((p) => ({
    method: 'GET', url: `${BASE}${p}`, params: { headers, tags: { path: p } },
  })));
  const dt = Date.now() - t0;

  screenTime.add(dt);
  perScreen[name].add(dt);

  let ok = true;
  for (let i = 0; i < responses.length; i++) {
    const r = responses[i];
    const good = check(r, {
      [`200 ${paths[i]}`]: (x) => x.status === 200,
    });
    if (!good) { ok = false; }
  }
  if (!ok) screenErr.add(1);
}
