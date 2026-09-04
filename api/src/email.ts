// Email sender. Uses Resend when RESEND_API_KEY is set.
//
// TWO RULES HERE, BOTH FROM AUDIT FINDING A-01, AND NEITHER IS OPTIONAL.
//
// 1. THE CONSOLE SINK IS A DEVELOPMENT TOOL AND CANNOT EXIST IN PRODUCTION.
//    It used to print the recipient and the plaintext code and then return
//    normally, whatever the environment. Two separate problems came out of that
//    one line. The first is that a one-time authentication secret was written to
//    centralised logs, where it outlives the ten-minute code and is readable by
//    anyone with log access. The second is worse: signup REPORTED SUCCESS while
//    no email existed anywhere. A user was told to check an inbox that was never
//    going to receive anything, and nothing in the system disagreed.
//
// 2. WITHOUT A CONFIGURED PROVIDER, PRODUCTION FAILS CLOSED. Sending throws, so
//    the route returns a real error instead of a false success. This is not a
//    behaviour regression dressed up as a fix: with no RESEND_API_KEY nobody
//    could ever receive a code, so every email flow was already broken - it just
//    said otherwise. An honest error is strictly more useful than a silent one,
//    and it makes "email is not set up yet" visible instead of something users
//    discover for us.
//
// The Telegram login path does not go through here and is unaffected.
import { config } from "./config.ts";

const inProduction = () => process.env.NODE_ENV === "production";

/** Is a real email provider configured? Used by the boot-time warning. */
export const emailConfigured = () => Boolean(config.resendApiKey);

function subjectFor(code: string) {
  return `${code} is your RoziPay code`;
}
function htmlFor(code: string) {
  // Simple, plain wording (DESIGN_BRIEF simple-English rules).
  return (
    `<div style="font-family:sans-serif;font-size:16px;color:#0e1b1e">` +
    `<p>Your RoziPay code is:</p>` +
    `<p style="font-size:32px;font-weight:bold;letter-spacing:4px">${code}</p>` +
    `<p>It works for 10 minutes. Do not share it with anyone.</p>` +
    `</div>`
  );
}
function textFor(code: string) {
  return `Your RoziPay code is ${code}. It works for 10 minutes. Do not share it.`;
}

export async function sendLoginCode(email: string, code: string): Promise<void> {
  if (config.resendApiKey) return sendViaResend(email, code);
  if (inProduction()) {
    // Fail closed. The caller (auth.ts issueCode) already documents that it
    // throws when the email cannot be sent, and every route above it turns
    // that into an error the user can act on.
    throw new Error(
      "Email is not set up on this server yet, so we cannot send you a code. Please sign in with Telegram, or try again later.",
    );
  }
  // Development only, and the environment check above is what keeps it that
  // way. Printing the code is the entire point locally; it is precisely what
  // must never happen anywhere else.
  console.log(
    `\n  ✉  [DEV] Login code for ${email}: ${code}  (set RESEND_API_KEY to email it)\n`,
  );
}

async function sendViaResend(email: string, code: string): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.resendApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: `${config.emailFromName} <${config.emailFrom}>`,
      to: [email],
      subject: subjectFor(code),
      html: htmlFor(code),
      text: textFor(code),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend send failed (${res.status}): ${detail}`);
  }
}
