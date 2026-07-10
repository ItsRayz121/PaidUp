// Email sender. Uses Resend when RESEND_API_KEY is set; otherwise prints the
// code to the console (local dev) and sends nothing.
import { config } from "./config.ts";

function subjectFor(code: string) {
  return `${code} is your PaidUp code`;
}
function htmlFor(code: string) {
  // Simple, plain wording (DESIGN_BRIEF simple-English rules).
  return (
    `<div style="font-family:sans-serif;font-size:16px;color:#0e1b1e">` +
    `<p>Your PaidUp code is:</p>` +
    `<p style="font-size:32px;font-weight:bold;letter-spacing:4px">${code}</p>` +
    `<p>It works for 10 minutes. Do not share it with anyone.</p>` +
    `</div>`
  );
}
function textFor(code: string) {
  return `Your PaidUp code is ${code}. It works for 10 minutes. Do not share it.`;
}

export async function sendLoginCode(email: string, code: string): Promise<void> {
  if (config.resendApiKey) return sendViaResend(email, code);
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
