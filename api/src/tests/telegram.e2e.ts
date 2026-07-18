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
import { createHash, createHmac } from "node:crypto";
import jwt from "jsonwebtoken";
import { initDb, sql, now, newId } from "../db.ts";
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

console.log("\n-- Login Widget route (regression guard for the helper refactor) --");

// The widget's scheme: HMAC key = SHA256(bot_token) — different from the
// Mini App's on purpose.
function signWidgetPayload(fields: Record<string, string>, token = config.telegramBotToken) {
  const checkString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHash("sha256").update(token).digest();
  const hash = createHmac("sha256", secret).update(checkString).digest("hex");
  return { ...fields, hash };
}
const postWidget = (payload: unknown) =>
  app.inject({ method: "POST", url: "/auth/telegram", payload: payload as object });

res = await postWidget(signWidgetPayload({ id: "666001", auth_date: freshDate(), username: "widget_user" }));
check("a signed widget payload logs in", res.statusCode === 200 && Boolean(res.json().token));

res = await postWidget(signWidgetPayload({ id: "666002", auth_date: freshDate() }, "7654321:WRONG"));
check("a widget payload with a bad signature is rejected", res.statusCode === 401);

// CROSS-SCHEME REPLAY: a valid Mini App initData replayed at the widget
// endpoint (and vice versa) must die — the HMAC keys differ by design.
// (Rejected as 400 — the shapes differ too — or 401 if reshaped; what is
// pinned here is that it can NEVER be a 200.)
const crossData = signInitData({ user: tgUser(666003), auth_date: freshDate() });
res = await postWidget(Object.fromEntries(new URLSearchParams(crossData).entries()));
check("a Mini App payload cannot log in at the widget endpoint",
  res.statusCode === 400 || res.statusCode === 401);
// Reshaped to LOOK like a widget payload (id hoisted out of the user JSON),
// the Mini App signature still cannot validate under the widget's key.
const crossParams = Object.fromEntries(new URLSearchParams(crossData).entries());
res = await postWidget({ ...crossParams, id: "666003" });
check("...even reshaped with an id field, the signature fails", res.statusCode === 401);

console.log("\n-- linking Telegram to an email account --");

const bearerFor = (id: string) => `Bearer ${jwt.sign({ sub: id }, config.jwtSecret, { expiresIn: "1h" })}`;
const mkEmailUser = async (label: string) => {
  const id = newId();
  await sql.run(
    `INSERT INTO users (id, email, email_verified, country, referral_code, status, created_at)
     VALUES (?,?,1,'Pakistan',?,'active',?)`,
    id, `${label}-${id}@t.test`, id.slice(0, 8).toUpperCase(), now(),
  );
  return id;
};
const link = (userId: string, payload: object) =>
  app.inject({
    method: "POST", url: "/auth/telegram/link",
    headers: { authorization: bearerFor(userId) },
    payload,
  });

// Telegram ids must be unique PER RUN — the e2e database persists between
// runs, and a fixed id would (correctly) be refused as already-linked.
const RUN = Math.floor(Date.now() / 1000) % 1_000_000_000;
const tgId = (n: number) => RUN * 10 + n;

// Happy path: an email account connects the Telegram it is opened in.
const emailUser = await mkEmailUser("linker");
res = await link(emailUser, { initData: signInitData({ user: tgUser(tgId(1)), auth_date: freshDate() }) });
body = res.json();
check("linking via Mini App initData succeeds", res.statusCode === 200 && body.user?.hasTelegram === true);
const linkedRow = await sql.get<{ telegram_id: string }>("SELECT telegram_id FROM users WHERE id = ?", emailUser);
check("the telegram id landed on the email account", linkedRow?.telegram_id === String(tgId(1)));

// Idempotent: connecting again is a success, not an error.
res = await link(emailUser, { initData: signInitData({ user: tgUser(tgId(1)), auth_date: freshDate() }) });
check("linking twice is an idempotent success", res.statusCode === 200);

// Linking via the widget payload (website flow).
const widgetUser = await mkEmailUser("widget-linker");
res = await link(widgetUser, { widget: signWidgetPayload({ id: String(tgId(2)), auth_date: freshDate() }) });
check("linking via a signed widget payload succeeds", res.statusCode === 200 && res.json().user?.hasTelegram === true);

// A forged link attempt (unsigned) must fail even though the caller is
// signed in — being logged in is not proof of owning a Telegram account.
const forger = await mkEmailUser("forger");
res = await link(forger, { widget: { id: "888003", auth_date: freshDate(), hash: "00".repeat(32) } });
check("an unsigned link attempt is rejected", res.statusCode === 401);

// SHELL TAKEOVER: opening the Mini App before linking auto-creates a
// Telegram-only shell. An EMPTY shell is absorbed when the real account links.
res = await post(signInitData({ user: tgUser(tgId(4)), auth_date: freshDate() }));
const shellId = res.json().user?.id as string;
const realUser = await mkEmailUser("shell-absorber");
res = await link(realUser, { initData: signInitData({ user: tgUser(tgId(4)), auth_date: freshDate() }) });
check("an empty Telegram-only shell is absorbed by the real account", res.statusCode === 200);
const shellAfter = await sql.get<{ telegram_id: string | null }>("SELECT telegram_id FROM users WHERE id = ?", shellId);
const realAfter = await sql.get<{ telegram_id: string | null }>("SELECT telegram_id FROM users WHERE id = ?", realUser);
check("the shell lost the telegram id, the real account holds it",
  shellAfter?.telegram_id === null && realAfter?.telegram_id === String(tgId(4)));

// ...but a Telegram account WITH activity is never silently taken.
res = await post(signInitData({ user: tgUser(tgId(5)), auth_date: freshDate() }));
const activeShellId = res.json().user?.id as string;
await sql.run(
  `INSERT INTO ledger_entries (id, user_id, amount, direction, source_type, note, created_at)
   VALUES (?,?,?,?,?,?,?)`,
  newId(), activeShellId, 100, "credit", "admin_adjustment", "e2e activity", now(),
);
const wouldBeThief = await mkEmailUser("thief");
res = await link(wouldBeThief, { initData: signInitData({ user: tgUser(tgId(5)), auth_date: freshDate() }) });
check("a Telegram account with points is NOT taken over (409)", res.statusCode === 409);
const activeShellAfter = await sql.get<{ telegram_id: string | null }>("SELECT telegram_id FROM users WHERE id = ?", activeShellId);
check("the active account keeps its telegram id", activeShellAfter?.telegram_id === String(tgId(5)));

console.log("\n-- BINDING LINK (connect from the website, no Telegram login form) --");

// The website mints a one-time code; t.me/<bot>?startapp=link-<code> carries
// it into the Mini App, whose login binds + signs into the website account.
const bindUser = await mkEmailUser("bind");
res = await app.inject({
  method: "POST", url: "/auth/telegram/link-code",
  headers: { authorization: bearerFor(bindUser) },
});
body = res.json();
check("minting a binding code needs only a session", res.statusCode === 200
  && /^link-[a-f0-9]{32}$/.test(body.startParam));

res = await post(signInitData({ user: tgUser(tgId(6)), auth_date: freshDate(), start_param: body.startParam }));
const bindLogin = res.json();
check("the Mini App login with the code signs into the WEBSITE account",
  res.statusCode === 200 && bindLogin.user?.id === bindUser);
check("...and that account is now connected", bindLogin.user?.hasTelegram === true);
const bindRow = await sql.get<{ telegram_id: string | null }>("SELECT telegram_id FROM users WHERE id = ?", bindUser);
check("the telegram id landed on the website account", bindRow?.telegram_id === String(tgId(6)));

// REPLAY: the code is single-use. A second login with the SAME code but a
// DIFFERENT Telegram must fall back to a normal login, never touch bindUser.
res = await post(signInitData({ user: tgUser(tgId(7)), auth_date: freshDate(), start_param: body.startParam }));
const replayLogin = res.json();
check("a spent code falls back to a normal login", res.statusCode === 200 && replayLogin.user?.id !== bindUser);
const bindRowAfter = await sql.get<{ telegram_id: string | null }>("SELECT telegram_id FROM users WHERE id = ?", bindUser);
check("...and the website account is untouched", bindRowAfter?.telegram_id === String(tgId(6)));

// EXPIRED: an old link logs in normally instead of binding.
const lateUser = await mkEmailUser("late");
res = await app.inject({
  method: "POST", url: "/auth/telegram/link-code",
  headers: { authorization: bearerFor(lateUser) },
});
const lateParam = res.json().startParam as string;
await sql.run(
  "UPDATE telegram_link_codes SET expires_at = ? WHERE user_id = ?",
  new Date(Date.now() - 1000).toISOString(), lateUser,
);
res = await post(signInitData({ user: tgUser(tgId(8)), auth_date: freshDate(), start_param: lateParam }));
check("an EXPIRED code falls back to a normal login", res.statusCode === 200 && res.json().user?.id !== lateUser);
const lateRow = await sql.get<{ telegram_id: string | null }>("SELECT telegram_id FROM users WHERE id = ?", lateUser);
check("...and does not bind", lateRow?.telegram_id === null);

// No session, no code: minting requires being signed in.
res = await app.inject({ method: "POST", url: "/auth/telegram/link-code" });
check("minting a code without a session is refused", res.statusCode === 401);

await app.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
