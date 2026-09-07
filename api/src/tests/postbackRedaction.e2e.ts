// E2E for postback log redaction (audit finding A-08).
//
//   npm run test:postbackredaction
import { initDb, sql, now, newId } from "../db.ts";
import { config } from "../config.ts";
import { tickPostbackRedaction } from "../postbackRedaction.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

await initDb();

async function mkRow(daysOld: number, raw: string | null) {
  const id = newId();
  const at = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
  await sql.run(
    "INSERT INTO postback_log (id, network, external_id, verified, outcome, raw, created_at) VALUES (?,?,?,?,?,?,?)",
    id, "cpx", `ext-${id.slice(0, 6)}`, 1, "credited", raw, at,
  );
  return id;
}

const rowOf = (id: string) => sql.get<{ raw: string | null; network: string; outcome: string }>(
  "SELECT raw, network, outcome FROM postback_log WHERE id = ?", id,
);

console.log("\n-- postback log redaction --");
{
  const old = await mkRow(config.postbackLogRetentionDays + 10, JSON.stringify({ ip: "1.2.3.4", secret: "abc" }));
  const fresh = await mkRow(1, JSON.stringify({ ip: "5.6.7.8" }));
  const alreadyRedacted = await mkRow(
    config.postbackLogRetentionDays + 30, JSON.stringify({ redacted: true }),
  );
  const noRaw = await mkRow(config.postbackLogRetentionDays + 30, null);

  const r1 = await tickPostbackRedaction();
  check("it redacted the one row past the retention window", r1.redacted === 1, JSON.stringify(r1));

  const oldRow = await rowOf(old);
  check("the old row's raw no longer contains the echoed request", !oldRow?.raw?.includes("1.2.3.4"));
  check("...or the IP field name itself", !oldRow?.raw?.includes("secret"));
  check("its metadata (network/outcome) is untouched", oldRow?.network === "cpx" && oldRow?.outcome === "credited");

  const freshRow = await rowOf(fresh);
  check("a fresh row within the window is untouched", freshRow?.raw?.includes("5.6.7.8") === true);

  const r2 = await tickPostbackRedaction();
  check("a second tick redacts nothing new (already-redacted / no-raw rows are skipped)", r2.redacted === 0, JSON.stringify(r2));

  void alreadyRedacted; void noRaw;
}

console.log("\n-- turned off (retention days = 0) --");
{
  const original = config.postbackLogRetentionDays;
  (config as { postbackLogRetentionDays: number }).postbackLogRetentionDays = 0;
  const veryOld = await mkRow(9999, JSON.stringify({ ip: "9.9.9.9" }));
  const r = await tickPostbackRedaction();
  check("a 0-day retention setting is a no-op", r.redacted === 0, JSON.stringify(r));
  const row = await rowOf(veryOld);
  check("...and the row is left alone", row?.raw?.includes("9.9.9.9") === true);
  (config as { postbackLogRetentionDays: number }).postbackLogRetentionDays = original;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
