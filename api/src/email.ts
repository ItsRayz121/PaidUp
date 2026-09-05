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

// A code serves one of four purposes (auth.ts's issueCode); the heading and
// subject are tailored so the email reads like it is actually about the thing
// the user just did, not a generic "here's a code" message. Simple English
// per DESIGN_BRIEF — no jargon like "OTP" or "one-time password".
export type CodePurpose = "verify" | "reset" | "link" | "withdraw";

const COPY: Record<CodePurpose, { subject: string; heading: string; body: string }> = {
  verify: {
    subject: "Verify your email",
    heading: "Verify your email",
    body: "Enter this code in RoziPay to finish creating your account.",
  },
  reset: {
    subject: "Reset your password",
    heading: "Reset your password",
    body: "Enter this code in RoziPay to choose a new password.",
  },
  link: {
    subject: "Confirm it's you",
    heading: "Confirm it's you",
    body: "Enter this code in RoziPay to confirm this change to your account.",
  },
  withdraw: {
    subject: "Confirm your withdrawal",
    heading: "Confirm your withdrawal",
    body: "Enter this code in RoziPay to confirm you want to send this money.",
  },
};

const LOGO_URL = "https://rozipay.xyz/icons/icon-192.png";
const BRAND = "#0d5c63"; // --color-brand (light theme), kept fixed here: an
// email must look the same regardless of the reader's device dark-mode
// setting, which most mail clients ignore for images/inline styles anyway.
const BRAND_TINT = "#e5f1f1";
const INK = "#0e1b1e";
const MUTED = "#5b6b6d";

function subjectFor(code: string, purpose: CodePurpose) {
  return `${code} — ${COPY[purpose].subject}`;
}

function htmlFor(code: string, purpose: CodePurpose) {
  const { heading, body } = COPY[purpose];
  // Table-based layout, every style inlined: the one layout shape that
  // renders the same in Gmail, Apple Mail AND old desktop Outlook (which
  // ignores <style> blocks and most CSS beyond what a table understands).
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f7;padding:32px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border:1px solid #e2e8e8;border-radius:16px;overflow:hidden">
      <tr><td style="padding:32px 32px 8px" align="center">
        <img src="${LOGO_URL}" width="44" height="44" alt="RoziPay" style="border-radius:10px;display:block">
        <div style="margin-top:10px;font-size:15px;font-weight:700;color:${BRAND};letter-spacing:0.2px">RoziPay</div>
      </td></tr>
      <tr><td style="padding:8px 32px 0" align="center">
        <div style="font-size:20px;font-weight:700;color:${INK};margin-top:8px">${heading}</div>
        <div style="font-size:15px;color:${MUTED};margin-top:8px;line-height:1.5">${body}</div>
      </td></tr>
      <tr><td style="padding:24px 32px 8px" align="center">
        <div style="background:${BRAND_TINT};border-radius:12px;padding:18px 24px;display:inline-block">
          <span style="font-size:32px;font-weight:700;letter-spacing:6px;color:${BRAND}">${code}</span>
        </div>
      </td></tr>
      <tr><td style="padding:8px 32px 32px" align="center">
        <div style="font-size:13px;color:${MUTED};line-height:1.5">
          This code works for 10 minutes.<br>Didn't ask for this? You can safely ignore this email.
        </div>
      </td></tr>
      <tr><td style="padding:20px 32px;border-top:1px solid #eef2f2" align="center">
        <div style="font-size:12px;color:${MUTED}">
          RoziPay · <a href="https://rozipay.xyz" style="color:${MUTED};text-decoration:underline">rozipay.xyz</a>
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>`;
}

function textFor(code: string, purpose: CodePurpose) {
  const { heading, body } = COPY[purpose];
  return `${heading}\n\n${body}\n\nYour code: ${code}\n\nThis code works for 10 minutes. Didn't ask for this? You can safely ignore this email.\n\nRoziPay · https://rozipay.xyz`;
}

export async function sendLoginCode(email: string, code: string, purpose: CodePurpose = "verify"): Promise<void> {
  if (config.resendApiKey) return sendViaResend(email, code, purpose);
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

async function sendViaResend(email: string, code: string, purpose: CodePurpose): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.resendApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: `${config.emailFromName} <${config.emailFrom}>`,
      to: [email],
      subject: subjectFor(code, purpose),
      html: htmlFor(code, purpose),
      text: textFor(code, purpose),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend send failed (${res.status}): ${detail}`);
  }
}
