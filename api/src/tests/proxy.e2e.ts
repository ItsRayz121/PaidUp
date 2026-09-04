// Does req.ip resolve to the real user behind a proxy — and can a client forge it?
// The IP fraud rules (ip_reuse, referral-ring-by-IP), the per-IP rate limits and
// the postback IP pin all read req.ip, so both answers have to be right.
//
// ⚠️ THIS SUITE EARNED ITS KEEP ON 2026-09-04. Upgrading Fastify 5.10.0 → 5.12.3
// (to clear GHSA-3m5p-2c4r-xxw2, audit finding A-06) SILENTLY BROKE req.ip, and
// this is the only thing that noticed. The advisory's own fix was to neuter
// numeric `trustProxy`, so the hop count this app had used since it was written
// stopped resolving X-Forwarded-For at all — req.ip became the socket peer, i.e.
// the edge proxy's address, identical for every request. Nothing threw. Per-IP
// rate limiting would have become one global bucket (a self-inflicted login
// lockout) and every IP fraud rule would have compared everyone to everyone.
//
// The replacement is what the audit's remediation asked for: name the trusted
// NETWORKS rather than count hops. proxy-addr walks X-Forwarded-For from the
// right, skipping trusted addresses, and returns the first untrusted one — so a
// client prepending a forged entry still loses, because the value the real edge
// appended sits to its right.
import Fastify from "fastify";
import { config } from "../config.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

// `remoteAddress` is the socket peer — in production, whatever machine actually
// opened the connection to us. That is the address the trust list is judged
// against, so every case below has to state it.
async function ipSeenBy(trust: unknown, xff: string, remoteAddress: string): Promise<string> {
  const app = Fastify({ trustProxy: trust as never });
  app.get("/ip", async (req) => ({ ip: req.ip }));
  await app.ready();
  const res = await app.inject({
    method: "GET", url: "/ip", remoteAddress,
    ...(xff ? { headers: { "x-forwarded-for": xff } } : {}),
  });
  await app.close();
  return res.json().ip;
}

const CLIENT = "203.0.113.42";   // the real user
const EDGE = "10.0.0.7";         // the platform's edge, as the socket sees it
const CGNAT_EDGE = "100.64.1.2"; // ...on a host that uses carrier-grade NAT space
const FORGED = "1.2.3.4";        // what an attacker claims to be

// The list the app actually ships with. Reading it from config rather than
// restating it is the point: this suite must fail if the default is ever
// changed to something that does not work.
const TRUST = config.trustProxy;
console.log(`\n(trustProxy in use: ${JSON.stringify(TRUST)})`);

console.log("\n-- the shipped default resolves the real user --");
check("behind a private-network edge, req.ip is the real user",
  await ipSeenBy(TRUST, CLIENT, EDGE) === CLIENT);
check("...and behind a carrier-grade-NAT edge too (uniquelocal does NOT cover 100.64/10)",
  await ipSeenBy(TRUST, CLIENT, CGNAT_EDGE) === CLIENT);
check("...and over loopback, which is how this suite and local dev connect",
  await ipSeenBy(TRUST, CLIENT, "127.0.0.1") === CLIENT);
check("through two trusted hops, req.ip is still the real user",
  await ipSeenBy(TRUST, `${CLIENT}, 10.0.0.9`, EDGE) === CLIENT);

console.log("\n-- forging is still refused --");
{
  // The edge APPENDS what it observed, so the attacker's invented entry is to
  // the LEFT of the true one and never wins.
  const spoofed = await ipSeenBy(TRUST, `${FORGED}, ${CLIENT}`, EDGE);
  check("a client CANNOT forge its IP by prepending X-Forwarded-For", spoofed === CLIENT,
    `got ${spoofed} (a forged value here would defeat every IP fraud rule)`);

  const spoofedTrue = await ipSeenBy(true, `${FORGED}, ${CLIENT}`, EDGE);
  check("...and trustProxy:true WOULD have been forgeable (why we never use it)",
    spoofedTrue === FORGED, `got ${spoofedTrue}`);
}

console.log("\n-- the regression the Fastify upgrade introduced --");
{
  // Pinned deliberately. If a future Fastify restores hop counts, this check
  // fails and someone reads this comment instead of quietly reintroducing a
  // configuration that has been broken once already.
  const hops = await ipSeenBy(1, CLIENT, EDGE);
  check("a numeric hop count is DEAD on this Fastify — it returns the socket peer",
    hops === EDGE, `got ${hops}`);
  check("the app does not use a hop count", typeof TRUST !== "number");
}

console.log("\n-- untrusted and absent cases fail safe --");
{
  // If the edge ever presents a PUBLIC address, the list does not match it and
  // req.ip falls back to that address. Wrong, but safe — and server.ts logs a
  // warning when it sees exactly this shape, because otherwise it is silent.
  check("an UNTRUSTED (public) peer is not believed",
    await ipSeenBy(TRUST, CLIENT, "8.8.8.8") === "8.8.8.8");
  check("with no X-Forwarded-For at all, req.ip is the peer",
    await ipSeenBy(TRUST, "", "8.8.8.8") === "8.8.8.8");
  const none = await ipSeenBy(false, CLIENT, EDGE);
  check("without trustProxy, req.ip ignores the real client (the original bug)",
    none !== CLIENT, `got ${none}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
