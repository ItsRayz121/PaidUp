// Does req.ip resolve to the real user behind a proxy — and can a client forge it?
// The IP fraud rules (ip_reuse, referral-ring-by-IP) and the postback IP pin all
// read req.ip, so both answers have to be right.
import Fastify from "fastify";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

// Railway forwards "<client>" and appends nothing we control; Cloudflare+Railway
// would forward "<client>, <cf>". A malicious client can PREPEND entries.
async function ipSeenBy(hops: number | boolean, xff: string): Promise<string> {
  const app = Fastify({ trustProxy: hops as never });
  app.get("/ip", async (req) => ({ ip: req.ip }));
  await app.ready();
  const res = await app.inject({ method: "GET", url: "/ip", headers: { "x-forwarded-for": xff } });
  await app.close();
  return res.json().ip;
}

const CLIENT = "203.0.113.42";   // the real user
const RAILWAY = "10.0.0.7";      // Railway's edge, as seen by us
const FORGED = "1.2.3.4";        // what an attacker claims to be

console.log("\n-- no trustProxy (the bug: everyone looks identical) --");
const none = await ipSeenBy(false, `${CLIENT}`);
check("without trustProxy, req.ip ignores the real client", none !== CLIENT, `got ${none}`);

console.log("\n-- trustProxy: 1 (Railway only, api on DNS-only) --");
const one = await ipSeenBy(1, `${CLIENT}`);
check("req.ip is the real user", one === CLIENT, `got ${one}`);

// The attack `trustProxy: true` would allow: client prepends a fake entry.
const spoofed = await ipSeenBy(1, `${FORGED}, ${CLIENT}`);
check("a client CANNOT forge its IP by prepending X-Forwarded-For", spoofed === CLIENT,
  `got ${spoofed} (a forged value here would defeat every IP fraud rule)`);

const spoofedTrue = await ipSeenBy(true, `${FORGED}, ${CLIENT}`);
check("...and trustProxy:true WOULD have been forgeable (why we use a hop count)",
  spoofedTrue === FORGED, `got ${spoofedTrue}`);

console.log("\n-- trustProxy: 2 (Cloudflare orange-cloud in front of Railway) --");
const two = await ipSeenBy(2, `${CLIENT}, ${RAILWAY}`);
check("req.ip is the real user through two hops", two === CLIENT, `got ${two}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
