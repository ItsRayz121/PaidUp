// A public page — no login needed, no auth guard. Copy is written in plain
// English on purpose (DESIGN_BRIEF's "no jargon" rule applies here too, not
// just inside the logged-in app) and kept inline rather than in the copy deck,
// same reasoning as not-found.tsx: this page has to make sense on its own,
// including to someone who has never opened the app.
//
// Audit finding A-12 (no privacy/retention page, no documented policy): this
// is that fix. It describes what this codebase actually does today — nothing
// here is aspirational — so if a data practice changes, this page is part of
// that change, not an afterthought.
export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-2xl px-5 pt-10 pb-16 text-brand-ink">
      <h1 className="font-display text-2xl font-bold">Privacy &amp; your data</h1>
      <p className="mt-2 text-sm text-muted">Last updated 2026-09-07 · RoziPay (rozipay.xyz)</p>

      <p className="mt-6 text-muted">
        This page explains what we collect, why, how long we keep it, and how to ask us about it.
        We have tried to write it the way we would explain it to a friend, not the way a lawyer
        would write it.
      </p>

      <h2 className="mt-8 text-lg font-bold">What we collect</h2>

      <h3 className="mt-4 font-semibold">Your account</h3>
      <p className="mt-1 text-muted">
        Your email, your country, and a password — we never store your password itself, only a
        scrambled version of it that cannot be reversed. If you connect Telegram, we keep your
        Telegram username and name so we know who you are. If you pick a display name, a @handle,
        or add a photo, that is stored too.
      </p>

      <h3 className="mt-4 font-semibold">Proving it is really you (ID check)</h3>
      <p className="mt-1 text-muted">
        For some actions — mainly cashing out real money — we ask for a photo of a government ID.
        This is only requested when it is needed, never by default, and only staff who handle ID
        checks can see it.
      </p>

      <h3 className="mt-4 font-semibold">Keeping the app fair</h3>
      <p className="mt-1 text-muted">
        We record a device ID and your IP address when you use the app. This is how we catch the
        same person creating many accounts to cheat the referral or mining system — it is not used
        to track you around the internet, and we do not sell it to anyone.
      </p>

      <h3 className="mt-4 font-semibold">Your earnings and money</h3>
      <p className="mt-1 text-muted">
        Every task you complete, every ROZI you mine, every referral bonus, every withdrawal — all
        of it is written to a permanent record. This is not optional or a preference: it is how we
        make sure your balance is always correct and how we resolve it if something ever looks
        wrong. If you withdraw USDT, we store the wallet address you sent it to, and the
        transaction is also visible on the public blockchain itself — that part is out of our
        hands, since that is how all public blockchains work.
      </p>

      <h3 className="mt-4 font-semibold">Talking to support</h3>
      <p className="mt-1 text-muted">
        If you message our support chat, we keep what you wrote and any photo you attached, so we
        (and whoever answers next, if it is not the same person) can see the full conversation.
      </p>

      <h3 className="mt-4 font-semibold">When a partner offer pays you</h3>
      <p className="mt-1 text-muted">
        When an ad network tells us you finished one of their offers, we log what they sent us —
        including your IP address at that moment — so we can prove what happened if that network
        disputes it later (some networks can flag something as fraud up to two months afterwards).
        We automatically wipe the detailed part of this record after 90 days, keeping only a short
        note of what happened and when, which is enough for us to answer a dispute without holding
        onto old IP addresses forever.
      </p>

      <h3 className="mt-4 font-semibold">Notifications</h3>
      <p className="mt-1 text-muted">
        If you turn on notifications, your browser gives us a subscription address so we can send
        you one — for real events only, like a withdrawal being paid, never marketing.
      </p>

      <h2 className="mt-8 text-lg font-bold">What we do not do</h2>
      <ul className="mt-2 list-disc space-y-1.5 pl-5 text-muted">
        <li>We do not sell your personal information to anyone.</li>
        <li>We do not share your data with ad networks beyond confirming you finished their offer.</li>
        <li>We never see or store your bank card details — we do not ask for one.</li>
        <li>We do not use your activity to show you ads outside RoziPay.</li>
      </ul>

      <h2 className="mt-8 text-lg font-bold">How long we keep things</h2>
      <p className="mt-2 text-muted">
        Being honest about this matters more to us than sounding tidy, so here is where we
        genuinely stand today:
      </p>
      <ul className="mt-2 list-disc space-y-1.5 pl-5 text-muted">
        <li>Your money and activity records: kept for as long as your account exists — this is what your balance is built from, so it cannot be deleted while the account is active.</li>
        <li>Partner-offer logs: the detailed version is automatically deleted after 90 days (see above); a short outcome record stays longer, for our own accounting.</li>
        <li>ID-check photos: kept while your account is active, or as long as the law requires — we do not yet have an automatic timer on these. If you want yours removed sooner, ask us (see below) and a person will action it by hand.</li>
        <li>Support conversations: kept so we have the history if you write in again about the same thing.</li>
      </ul>

      <h2 className="mt-8 text-lg font-bold">Closing your account or asking about your data</h2>
      <p className="mt-2 text-muted">
        We do not yet have a self-serve &quot;delete my account&quot; button in the app. If you want your
        account closed, or want to ask what we hold about you, open <span className="font-semibold">Help</span> inside
        the app and send us a message — a real person will read it and act on it. We will keep the
        money and activity records that we are required to keep (the same reason listed above), and
        remove or anonymise the rest.
      </p>

      <h2 className="mt-8 text-lg font-bold">Changes to this page</h2>
      <p className="mt-2 text-muted">
        If how we handle your data changes in a way that matters, we will update this page and
        change the date at the top.
      </p>
    </div>
  );
}
