// Email sender. Uses Brevo (Sendinblue) transactional API when a key is set.
// With NO key (local dev), it prints the code to the server console so the
// full login flow works for free without sending real email.
import { config } from "./config.ts";

export async function sendLoginCode(email: string, code: string): Promise<void> {
  if (!config.brevoApiKey) {
    console.log(
      `\n  ✉  [DEV] Login code for ${email}: ${code}  (set BREVO_API_KEY to email it)\n`,
    );
    return;
  }

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": config.brevoApiKey,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      sender: { email: config.emailFrom, name: config.emailFromName },
      to: [{ email }],
      subject: `${code} is your PaidUp code`,
      // Simple, plain wording (DESIGN_BRIEF simple-English rules).
      htmlContent:
        `<div style="font-family:sans-serif;font-size:16px;color:#0e1b1e">` +
        `<p>Your PaidUp code is:</p>` +
        `<p style="font-size:32px;font-weight:bold;letter-spacing:4px">${code}</p>` +
        `<p>It works for 10 minutes. Do not share it with anyone.</p>` +
        `</div>`,
      textContent: `Your PaidUp code is ${code}. It works for 10 minutes. Do not share it.`,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Brevo send failed (${res.status}): ${detail}`);
  }
}
