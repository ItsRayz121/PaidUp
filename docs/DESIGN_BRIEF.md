# Design Brief

## Who this is for

Mobile-first users in Pakistan, India, Bangladesh, Indonesia, Nigeria — many on mid-range Android devices, variable connection speed, wide range of English fluency. Many have used a competing app before, possibly one that didn't pay. The design's job is to earn trust fast and never make someone feel confused or cheated.

## Simple English standard

- Short, plain sentences. No jargon. Target Grade 5–6 reading level for anything user-facing.
- One idea per sentence. One action per button.
- Name buttons by the action: "Get my money," not "Initiate withdrawal request." "Watch a video," not "Engage rewarded unit."
- Numbers over adjectives: "You'll get 50 points," not "Earn great rewards."
- Icons carry meaning alongside text, never replace it alone — icon + short label together.
- Internal jargon (postback, attribution, KYC, ledger, ASN) stays in Admin/Manager/Agent panels only. Never leaks into user-facing copy.

## Visual direction

Don't default to a generic fintech template. This product's pitch is "this one actually pays" — the design should carry clarity and proof, not generic polish.

- **Color**: a grounded, trustworthy palette rather than a loud "get rich quick" one. Calm base (deep teal or navy) with one warm, optimistic accent for "you earned this" moments (marigold or coral), used sparingly.
- **Type**: a clean, highly legible sans-serif for body text, with a slightly friendlier display face for big numbers (balances, earnings).
- **Signature moment**: the points-earned confirmation and the "money sent" confirmation are the two moments that build trust — give these real design attention (a satisfying, restrained animation or state change).
- **Structure**: dashboard-first home — balance, next action, and referral status visible without scrolling. Task/offer list below, clearly tagged as sponsored.

Use the Canva MCP for the icon set and marketing graphics once direction is approved.

## Admin / Manager / Agent panels

Internal tools — prioritize information density and speed over friendliness. Fast, keyboard-friendly, data-dense tables. Clean and unambiguous, optimized for internal-user efficiency.

## Accessibility floor (non-negotiable)

- Responsive down to small mobile viewports.
- Visible keyboard focus states.
- Color contrast meeting WCAG AA — especially balance numbers and status text (pending/paid/rejected). Don't rely on color alone; pair with icon/label.
- Respect reduced-motion preferences.
- Copy must make sense with images/icons turned off (slow connections). Never encode meaning only in an icon or image.

## Failure and empty states

- Never a blank screen. Empty task list says why ("No tasks right now for your country — check back soon") and gives a next action.
- A rejected task says why in plain terms ("This offer needs the app to stay installed for 24 hours — check back tomorrow"), not "Task failed."
- A rejected withdrawal explains the reason and what to do next, never just "Rejected."
