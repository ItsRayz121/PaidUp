// E2E for Telegram Mini App login (POST /auth/telegram/miniapp).
//
// The attacks matter more than the happy path:
//   • a payload whose user id was edited AFTER signing (privilege of any HMAC
//     check is that this must die)
//   • a payload signed with the WRONG bot token (someone else's bot)
//   • a captured payload replayed hours later
//   • a referral code smuggled in start_param — inside the signed set, so it
//     must survive verification, and a signed one must actually pay the edge
//
//   npm run test:telegram
import Fastify from "fastify";
import { createHmac } from "node:crypto";
import { initDb, sql, now } from "../db.ts";
import { config } from "../config.ts";
import { authRoutes } from "../auth.ts";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

// A syntactically bot-shaped token nobody owns. Set BEFORE routes register so
// the endpoint is on.
config.telegramBotToken = "1234567:TEST-fake-token-for-e2e";

await initDb();
const app = Fastify();
await app.register(authRoutes);

// Build a signed initData string the way Telegram does: data_check_string is
// the decoded key=value pairs sorted BY KEY, newline-joined; the HMAC key is
// HMAC-SHA256("WebAppData", bot_token).
function signInitData(fields: Record<string, string>, token = config.telegramBotToken): string {
  const params = new URLSearchParams(fields);
  const checkString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  params.append("hash", hash);
  return params.toString();
}

const freshDate = () => String(Math.floor(Date.now() / 1000));
const tgUser = (id: number, username = "miniapp_tester") =>
  JSON.stringify({ id, first_name: "Test", username });

const post = (initData: unknown) =>
  app.inject({ method: "POST", url: "/auth/telegram/miniapp", payload: { initData } });

console.log("\n-- happy path --");

const TG_ID = 777000123;
let res = await post(signInitData({ user: tgUser(TG_ID), auth_date: freshDate(), query_id: "AAE1" }));
let body = res.json();
check("a freshly signed initData logs in (200 + token)", res.statusCode === 200 && Boolean(body.token));
const row = await sql.get<{ id: string; email: string }>(
  "SELECT id, email FROM users WHERE telegram_id = ?", String(TG_ID),
);
check("the account was created against the telegram id", Boolean(row));
check("with a synthetic never-emailed address", Boolean(row?.email.endsWith("@telegram.local")));

res = await post(signInitData({ user: tgUser(TG_ID), auth_date: freshDate(), query_id: "AAE2" }));
body = res.json();
check("logging in AGAIN finds the same account, no duplicate",
  res.statusCode === 200 && body.user?.id === row?.id);

// Regression guard: a refactor of this file once deleted /auth/me by accident.
res = await app.inject({
  method: "GET", url: "/auth/me",
  headers: { authorization: `Bearer ${body.token}` },
});
check("the minted token works on GET /auth/me", res.statusCode === 200 && res.json().user?.id === row?.id);

console.log("\n-- attacks --");

// Sign as one user, then edit the payload to claim another. The HMAC must
// catch the edit.
const signed = signInitData({ user: tgUser(555001), auth_date: freshDate() });
const tampered = signed.replace(encodeURIComponent("555001"), encodeURIComponent("999999"));
res = await post(tampered);
check("editing the user id AFTER signing is rejected", res.statusCode === 401);

// Signed with somebody else's bot token.
res = await post(signInitData({ user: tgUser(555002), auth_date: freshDate() }, "7654321:SOMEONE-ELSES-BOT"));
check("a payload signed with the wrong bot token is rejected", res.statusCode === 401);

// Replay: a perfectly signed payload, two hours old.
res = await post(signInitData({ user: tgUser(555003), auth_date: String(Math.floor(Date.now() / 1000) - 7200) }));
check("a captured payload replayed 2 hours later is rejected", res.statusCode === 401);

// Signed, fresh — but no user object at all.
res = await post(signInitData({ auth_date: freshDate(), query_id: "AAE3" }));
check("a signed payload with no user is rejected", res.statusCode === 400);

res = await post(12345);
check("a non-string body is rejected", res.statusCode === 400);

console.log("\n-- referral via start_param (inside the signed set) --");

const inviterId = "tg-e2e-inviter";
await sql.run(
  `INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at)
   VALUES (?,?,1,'Pakistan','TGINV1','active',?)
   ON CONFLICT (id) DO NOTHING`,
  inviterId, "tg-inviter@t.test", now(),
);
res = await post(signInitData({ user: tgUser(555004), auth_date: freshDate(), start_param: "tginv1" }));
check("signup with start_param succeeds", res.statusCode === 200);
const invited = await sql.get<{ referred_by: string }>(
  "SELECT referred_by FROM users WHERE telegram_id = ?", "555004",
);
check("the invite edge was recorded (case-insensitive code)", invited?.referred_by === inviterId);
const edge = await sql.get<{ n: number }>(
  "SELECT COUNT(*)::int AS n FROM referrals WHERE referrer_user_id = ? AND referred_user_id = (SELECT id FROM users WHERE telegram_id = '555004')",
  inviterId,
);
check("referrals row exists", Number(edge?.n) === 1);

console.log("\n-- config endpoint --");

res = await app.inject({ method: "GET", url: "/auth/telegram/config" });
body = res.json();
check("config reports telegram enabled", res.statusCode === 200 && body.enabled === true);
// botUsername is best-effort (getMe over the network) — only its SHAPE is
// pinned here so the test never depends on connectivity.
check("config returns a string botUsername", typeof body.botUsername === "string");

await app.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
