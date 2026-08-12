"use client";

// All user-facing copy, in one file.
//
// This is a COPY DECK, not a translation layer. The founder's call (2026-07-12):
// English only, and Urdu is dropped — earners here read simple English, and the
// phone will translate for anyone who wants it. So the rule that replaces
// translation is stricter than translation ever was:
//
//   EVERY STRING BELOW MUST BE PLAIN, SHORT, SIMPLE ENGLISH.
//
// Short sentences. Everyday words. No jargon — never "postback", "ledger",
// "hashrate multiplier", "pro-rata", "epoch". Say "mining speed", not
// "hashrate". Say "we check every payment", not "fraud review". If a sentence
// needs a second read, rewrite it. Keeping every string in one file is what makes
// that reviewable in one pass (DESIGN_BRIEF.md).
//
// t("key", { name: "value" }) fills {name} placeholders.
import { createContext, useCallback, useContext } from "react";

const copy: Record<string, string> = {
  "wallet.chooser.usdt.withdrawSub": "Withdraw your available USDT",
  "wallet.chooser.bnb.withdrawSub": "Send BNB to your wallet address",
  "withdraw.bep20WalletAddress": "Withdrawal address",
  "withdraw.savedAddressReady": "Saved address ready",
  "withdraw.newAddressReady": "New address ready",
  // Tap-to-fill chip (founder, 2026-08-12: "as simple as the BNB screen") —
  // shown only when the box holds something other than the saved address.
  "withdraw.useSaved": "Use your saved address",
  "withdraw.addressAutoSave": "A valid new address is saved automatically after you withdraw.",
  "profile.member": "RoziPay member",
  "profile.accountEmail": "Account email",
  // nav + common
  //
  // ONE MONEY WORD IN THE WHOLE APP: USDT (founder, 2026-07-29). The word
  // "points" is gone from every earner-facing string below. It was an internal
  // unit that leaked into the product — users had to learn a made-up currency,
  // hold a conversion rate in their head, and then be told the real payout was
  // in something else. The ledger still counts points; nobody reading the app
  // has to know that (web/src/lib/format.ts).
  //
  // ROZI is the other currency and stays exactly as it was: a separate word, a
  // separate card, and it still says plainly that it cannot be cashed out.
  //
  // ⚠️ THE TOP BAR SHOWS THE COMBINED FIGURE, so its label must not say "money".
  // It used to, as an aria-label — which meant sighted users were carefully told
  // this balance is not cash while screen-reader users were told it is. The
  // accessibility path must never leak the one claim the visible copy works
  // hardest to avoid. Same words in both places, always.
  "topbar.balanceLabel": "ROZI tokens coming soon. Tap to open your wallet.",
  "topbar.roziComingSoon": "ROZI · Coming soon",

  "nav.home": "Home",
  "nav.tasks": "Tasks",
  "nav.wallet": "Wallet",
  "nav.profile": "Profile",
  "common.yourCountry": "your country",
  "common.getMyMoney": "Get my money",
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.loading": "Loading…",
  // Shown in the top bar when the balance could not be fetched. A dash there
  // means "still coming"; leaving the dash after a failed call tells the user
  // nothing at all about a number they care about more than any other.
  "topbar.unavailable": "Not available",
  // install (PWA add-to-home-screen). Say plainly that nothing is downloaded —
  // "install" makes people expect an APK, and we must not over-promise.
  "install.title": "Put RoziPay on your phone",
  "install.body":
    "Open RoziPay from your home screen, like an app. Nothing to download — it takes one tap.",
  "install.iosBody":
    "Tap the Share button at the bottom of Safari, then choose “Add to Home Screen”.",
  "install.cta": "Add to home screen",
  "install.later": "Not now",
  // profile — the fifth tab. Everything that is not an earning screen lives
  // here: invites, the ID check, the leaderboard, help, notifications, sign out.
  "profile.title": "Profile",
  "profile.subtitle": "Your account and settings.",
  "profile.settings": "Edit your profile",
  "profile.settingsHint": "Your name, your @handle and your picture.",
  "profile.refer": "Invite friends",
  "profile.referHint": "Share your link. Earn when friends earn.",
  "profile.signOut": "Sign out",
  "profile.signOutHint": "You'll need your password to sign in again.",

  // ---- Edit your profile ----------------------------------------------------
  // The handle is the hard part to word. It is the name people SEND MONEY TO, so
  // the copy has to make two things obvious before the user types: that others
  // will see it, and that it locks for a month afterwards. Someone who discovers
  // the lock after saving a typo is someone we have failed.
  "settings.title": "Edit your profile",
  "settings.subtitle": "This is how other people see you.",
  "settings.photo": "Your picture",
  "settings.photoHint": "Only you and our team see this. Tap to change it.",
  "settings.photoAdd": "Add a picture",
  "settings.photoChange": "Change picture",
  "settings.photoRemove": "Remove",
  "settings.name": "Your name",
  "settings.namePlaceholder": "What should we call you?",
  "settings.nameHint": "You can change this any time.",
  "settings.username": "Your username",
  "settings.usernamePlaceholder": "yourname",
  "settings.usernameHint":
    "Friends use this to send you ROZI. Once you set it, you can change it once every {days} days — so pick carefully.",
  "settings.usernameLocked":
    "You can change your @handle again on {date}.",
  "settings.usernameTaken": "Someone already has that name. Try another.",
  "settings.usernameRules": "3 to 20 letters, numbers or _. Start with a letter.",
  "settings.save": "Save",
  // Payout wallet is gone from this screen (founder, 2026-08-12) — set it
  // inline on the withdraw screen instead, where it is auto-saved.
  "settings.security": "Account security",
  "settings.forgotPassword": "Forgot your password?",
  "settings.forgotPasswordHint": "Get a code by email to set a new one.",
  "settings.notifications": "Notifications",
  "settings.saving": "Saving…",
  "settings.saved": "Saved.",
  "settings.nothing": "Nothing to save yet.",
  // "KYC" is jargon, and this file bans jargon everywhere else. It stays here by
  // the founder's decision (2026-08-01): in Pakistan, India and Bangladesh the
  // three letters are what every bank, wallet and exchange calls this step, so
  // for these users it is the FAMILIAR word and "verify your ID" was the vague
  // one. "Verify your KYC" pairs the known abbreviation with a plain verb, and
  // the hint underneath says it in ordinary words for anyone who has not met it.
  "profile.verifyId": "Verify your KYC",
  "profile.verifyIdHint": "Send a photo of your face and your ID card.",
  // Shown instead when an Admin has switched the ID check off. It must not
  // promise a date — same ceiling word as the road map and /mine.
  "profile.verifyIdOffHint": "Verification is not required yet.",
  "profile.comingSoon": "Coming soon",
  "profile.kycBadge.none": "Not done",
  "profile.kycBadge.pending": "Checking",
  "profile.kycBadge.approved": "Done",
  "profile.kycBadge.rejected": "Try again",
  "profile.leaderboard": "Leaderboard",
  "profile.leaderboardHint": "See who is earning the most.",
  "profile.help": "Help & support",
  "profile.helpHint": "Get help from the RoziPay team.",
  "profile.notifications": "Notifications",
  "profile.telegramAccount": "Telegram account",
  "profile.emailTitle": "Add your email",
  "profile.emailHint": "Then you can log in on the website too. Same account, same money.",
  "profile.emailPasswordPlaceholder": "Make a password (8 or more letters)",
  "profile.emailSend": "Send me the code",
  "profile.emailCodeSent": "We sent a 6-number code to {email}. Check spam too.",
  "profile.emailConfirm": "Confirm",
  "profile.emailBack": "Change email",
  "profile.emailConnected": "Email added",
  "profile.emailConnectedHint": "You can log in on the website with your email.",
  "profile.telegram": "Telegram",
  "profile.telegramHint": "Connect Telegram to your RoziPay account.",
  "profile.telegramConnect": "Connect Telegram",
  "profile.telegramOpen": "Open Telegram to connect",
  "profile.telegramWaiting": "Finish in Telegram… this updates by itself.",
  "profile.telegramConnected": "Telegram connected",
  "profile.telegramConnectedHint": "Open RoziPay in Telegram and you stay on this account.",
  // tasks
  "tasks.title": "Ways to earn",
  // In ROZI, like the reward pill on every card below it. This said "get paid in
  // USDT" while each row underneath showed a ROZI figure — a section header
  // contradicting every item it introduces.
  "tasks.subtitle": "Complete tasks and earn rewards.",
  "tasks.empty.title": "More ways to earn are coming",
  "tasks.empty.body":
    "Surveys are open now — tap “Surveys” above to earn today. New task types are added soon.",
  "tasks.seeAll": "See all",
  // home
  //
  // ONE CURRENCY ON SCREEN (founder, 2026-07-30). The home screen shows a SINGLE
  // balance, in ROZI: what you mined plus what you earned from tasks, added
  // together at the fixed display ratio in lib/format.ts.
  //
  // This replaced two cards — a ROZI card and a "Your money · 1.60 USDT" card —
  // which taught users the app had two kinds of money and left the smaller,
  // slower-moving one looking like the real one. There are not enough tasks
  // running yet for a USDT figure to move, and a money number that never moves
  // is worse than no money number at all.
  //
  // WHAT THE COPY MUST STILL NEVER DO: promise that the balance can be cashed
  // out today. It cannot. "Soon" is the strongest word allowed here, and it is
  // the same word the mining screen and the road map use — three screens, one
  // promise, so a user cannot find a version of it that says more.
  "home.hello": "Hello,",
  // The badge beside the greeting, behind a shield icon. It said "Free to join",
  // which is what every scam in this category leads with — and a shield promises
  // a guarantee while those words promise only an absence of cost. Say the thing
  // an operator can say and a fake cannot: we pay in a real currency, on a real
  // chain, and the token is capped.
  "home.wePayCash": "Real USDT payouts",
  // home.quickTaskTitle / friendsJoined / earnedFromThem / taskBoost / tagline
  // are GONE (founder, 2026-08-01) with the three blocks they belonged to: a
  // "do a quick task" card, a friends-joined card and the seven-row invite
  // advert. All three told the user to go somewhere else, and together they were
  // taller than the balance. One row of tiles does that job now.
  // ---- TWO NUMBERS, TWO LABELS, AND THE SPLIT IS PERMANENT ------------------
  //
  // ⚠️ READ THIS BEFORE RENAMING ANY BALANCE STRING IN THIS FILE.
  //
  // The app shows a balance in two different scopes and they are NOT the same
  // number:
  //
  //   "Your RoziPay balance"  = mined + earned   home, /wallet, the top bar
  //   "Your mined ROZI"       = mined only       /mine, rigs, send, store, convert
  //
  // Both are correct. The combined figure is a DISPLAY merge (lib/format.ts);
  // the ledgers underneath are still separate, and only MINED ROZI can actually
  // be spent on rigs, sent to a friend, put in the conversion pot or spent in
  // the store. So the merge can never reach those five screens — which means the
  // two numbers must be told apart by their LABEL, permanently.
  //
  // This was a real defect (review 2026-08-01, docs/REVIEW_2026-08-01.md § 1):
  // five screens said "Your ROZI" or "You have" for the mined-only figure while
  // three said effectively the same thing for the combined one. Home showed
  // 14.68 and linked straight to a screen headed 4.68, and the send screen
  // validated against the smaller number — so a user reading the top bar on that
  // very screen typed 10 and was told "You do not have that much ROZI".
  //
  // If you ever shorten one of these back to "Your ROZI", you have reintroduced
  // it. The word that carries the meaning is "mined".
  "home.rozi.label": "Your RoziPay balance",
  "home.rozi.start": "Start mining",
  "home.rozi.running": "Mining now — {time} left",
  "home.rozi.speed": "Your speed",
  // The split, shown small under the big number. One currency does not mean one
  // source: a user who does a survey must be able to see that it landed, or the
  // next survey does not get done.
  "home.rozi.breakdown": "{mined} mined · {earned} from tasks and friends",
  // wallet
  "wallet.subtitle": "Your balances and transactions.",
  // ⚠️ "wallet.reachAt" WAS DELETED (founder, 2026-08-01), not moved. It read
  // "You need {points} earned from tasks and friends to get money", and it ran
  // under the balance for every user below the minimum — which is almost
  // everyone, because there is little survey fill for Pakistani traffic yet. A
  // permanent sentence about a door that is shut is not information, it is a
  // discouragement on the money screen. The withdraw screen still states the
  // minimum, where it is the thing actually being decided.
  "wallet.history": "History",
  // HISTORY IS BOTH LEDGERS NOW. The line says where the numbers come from,
  // because the previous list showed task money only while the balance above it
  // was mostly mined — so the history appeared to contradict the balance.
  "wallet.history.sub": "Everything that came in and went out.",
  "wallet.noHistoryTitle": "No history yet",
  // ⚠️ THIS KEY IS FOR /mine ONLY (rewardsHistory — mining + task + referral
  // ROZI). /wallet and /wallet/rozi show unifyHistory() instead, which is
  // real money movement only (guardrail in walletHistory.ts's header) — mining
  // and finishing a task never add a row there, so this exact sentence on
  // those two screens would tell a user to do something that changes nothing
  // on the page they're looking at. Use wallet.noHistoryBody.money /
  // .roziTransfers there instead.
  "wallet.noHistoryBody": "Start mining or finish a task to see your first ROZI here.",
  // The history opens short — the last two things that happened — and the rest
  // is one tap away. It counts what is hidden ("See all 14") rather than saying
  // "See all", because a number tells the user whether there is anything worth
  // opening. Money still waiting is never inside that count: see the wallet
  // screen's preview() note.
  "wallet.history.seeAll": "See all {count}",
  "wallet.history.less": "Show less",
  // ---- What each kind of ROZI transaction is called ------------------------
  // ⚠️ ONE PLAIN SENTENCE PER SOURCE TYPE, and the list must cover every value
  // in the rozi_ledger CHECK constraint (api/src/db.ts). A type with no entry
  // here renders its own key — "wallet.tx.mining" — on the money screen.
  //
  // The internal note on the row is NOT used for most of these on purpose: those
  // notes are written for staff reading the ledger, and some of them contain the
  // word "points", which this app does not say to earners.
  "wallet.tx.mining": "Mined",
  "wallet.tx.rig_purchase": "Bought a mining machine",
  "wallet.tx.transfer_in": "Received from a friend",
  "wallet.tx.transfer_out": "Sent to a friend",
  "wallet.tx.transfer_fee": "Sending fee",
  "wallet.tx.conversion_burn": "Changed into money",
  "wallet.tx.store_redemption": "Store order",
  "wallet.tx.bonus": "Bonus",
  "wallet.tx.admin_adjustment": "Changed by our team",
  "wallet.needHelp": "Need help with a payment?",
  "wallet.contactSupport": "Contact support",
  // ---- Invite rewards -------------------------------------------------------
  // Rendered on /refer only (components/InviteRewards.tsx). It used to run on
  // home and /wallet too; both dropped it (founder, 2026-08-01) because a sales
  // pitch between a balance and its history is what made those screens feel
  // like a feed rather than a wallet. It belongs where someone has chosen to
  // read it.
  //
  // Every number in here is a {placeholder} filled from /referrals/me, NEVER
  // typed into the string. The percentages are Admin-tunable per network, so a
  // hard-coded "15%" would become a lie the first time someone edits a row — and
  // the one promise this app cannot afford to break is the one people repeated to
  // their friends.
  //
  // "Level 1 / level 2" is banned here, along with "downline" and "commission":
  // this is the screen where jargon costs the most. Say "your friends" and
  // "their friends", which is what the thing actually is.
  //
  // ⚠️ NOT A PER-FRIEND BOUNTY, and the copy must never read like one (founder,
  // 2026-07-30). The card used to headline "0.100 USDT for every friend", which
  // says we hand out cash for a link — we do not, and a bounty is the exact
  // shape every fake-signup farm is looking for. What we actually pay is a SHARE
  // OF WHAT A FRIEND EARNS, at two levels, for as long as they keep earning.
  // So the two share rows lead, and the starter bonus is last, named for what
  // earns it: their first finished task, never their signup.
  "invite.title": "Every friend pays you twice",
  "invite.subtitle": "A share of what they earn. And a share of what their friends earn.",
  "invite.l1.title": "Your friends earn, you get {pct}%",
  // ⚠️ NOT "forever". It said so, and `referral_bonus_days` is Admin-tunable per
  // network (0 = lifetime) — so the word was a hard promise about a field an
  // Admin can change from a form. That is the exact failure the header above
  // warns about; it guarded the percentages and left the duration hard-coded.
  // "Every task they finish" is true under every setting of that field.
  "invite.l1.body": "Every task they finish. You do nothing.",
  "invite.l2.title": "Their friends earn, you get {pct}%",
  "invite.l2.body": "When your friends invite people, you get paid from them too.",
  "invite.first.title": "{n} ROZI when a friend gets started",
  "invite.first.body": "Paid when they finish their first task — not for joining.",
  "invite.mining.title": "Your mining gets faster",
  "invite.mining.body":
    "Every friend who mines adds {pct}% of their speed to yours. Their friends add {pct2}%.",
  // The trust line, and the most valuable sentence on the screen. It is TRUE —
  // referral pay comes out of our margin, never the invitee's balance (see
  // api/src/credit.ts) — and it is the answer to the objection every user in our
  // markets has met before: "is my friend paying for this?"
  "invite.free.title": "Your friend loses nothing",
  "invite.free.body": "Your share comes from our cut, not theirs. They keep every cent they earn.",
  "invite.cta": "Invite friends",
  "invite.seeRewards": "See what a friend is worth",

  // refer
  "refer.title": "Invite friends",
  "refer.subtitle": "Your friends earn. You get paid. Nobody loses anything.",
  "refer.hero.headline": "Get {pct}% of everything your friends earn",
  "refer.hero.sub": "For as long as they keep earning.",
  "refer.yourCode": "Your code",
  "refer.copyLink": "Copy link",
  "refer.copied": "Copied",
  "refer.share": "Share",
  "refer.friendsJoined": "Friends joined",
  "refer.friends2Joined": "Their friends",
  "refer.pointsEarned": "You earned",
  "refer.howItWorks": "How it works",
  "refer.step1": "Share your code with friends.",
  "refer.step2": "They join and start earning.",
  "refer.step3": "You get paid when they earn.",
  "refer.step4": "You also mine faster while they mine.",
  // ⚠️ THIS USED TO SAY "Get your money first, then share." Cash-out is not open,
  // so the invite screen was setting an impossible prerequisite for inviting —
  // on the one screen whose entire job is getting a link sent. Good advice, and
  // it goes back the day a real payout clears. Until then the trust argument
  // that IS available is the honest one: nothing is taken from the friend.
  "refer.trustNote":
    "Your friends only trust apps that pay. Tell them what you have earned — and that it costs them nothing.",
  "refer.inviteMessage":
    "I earn real money on RoziPay, and I mine free ROZI every day. Join with my code {code} and we both get paid. {link}",
  "refer.telegramTitle": "Invite on Telegram",
  "refer.telegramHint": "Friends open RoziPay inside Telegram. Your code fills in by itself.",
  // No {link} here — Telegram's share screen attaches the link on its own.
  "refer.telegramShareText":
    "I earn real money on RoziPay, and I mine free ROZI every day. Join with my code {code} and we both get paid.",
  // inbox — messages from us to the user (brief part 39).
  //
  // ⚠️ THE COPY HERE CANNOT PROMISE ANYTHING, because it wraps text a staff
  // member typed and nobody reviewed. So the fixed strings stay strictly
  // descriptive: this is where our messages are, that is all.
  "inbox.title": "Messages",
  "inbox.subtitle": "News and updates from us.",
  "inbox.emptyTitle": "No messages yet",
  "inbox.emptyBody": "When we have news for you, it shows up here.",
  "inbox.markAllRead": "Mark all as read",
  "inbox.new": "New",
  "inbox.open": "Open",
  // help
  "help.title": "Help & support",
  "help.subtitle": "Tell us the problem. A real person will reply.",
  "help.askForHelp": "Ask for help",
  "help.noQuestionsTitle": "No questions yet",
  "help.noQuestionsBody":
    "If your earnings did not come, or money is late, ask here and we will check.",
  "help.pointsNote":
    "Money is only added after the offer partner confirms your task. This can take a little time.",
  "help.statusWaiting": "Waiting for reply",
  "help.statusReplied": "We replied",
  "help.statusClosed": "Closed",
  "help.lastUpdate": "Last update {time}",
  "help.you": "You",
  "help.support": "Support",
  "help.writeReply": "Write a reply…",
  "help.sending": "Sending…",
  "help.sendReply": "Send reply",
  "help.whatHelp": "What do you need help with?",
  "help.subjectPlaceholder": "Short subject (e.g. Money not added)",
  "help.messagePlaceholder": "Tell us what happened.",
  "help.send": "Send",
  // withdraw
  "withdraw.youHave": "You have",
  "withdraw.aboutEquals": "Ready to take out",
  "withdraw.getPaidUsdt": "Get paid in USDT",
  // ---- Where the money goes (moved to /profile/settings, 2026-08-05) -------
  // This screen only ever SHOWS what's saved now; it never collects an
  // address itself. See the note above this block in the withdraw page.
  "withdraw.sendingTo": "Sending your money to",
  "withdraw.changeWallet": "Change it",
  "withdraw.noWallet.title": "Add a payout wallet first",
  "withdraw.noWallet.body": "We need to know where to send your money before you can ask for it.",
  "withdraw.noWallet.cta": "Add a payout wallet",
  "withdraw.yourWalletAddress": "Your USDT wallet address",
  "withdraw.addrPlaceholderEvm": "Paste address (0x…)",
  "withdraw.addrPlaceholderAptos": "0x… (Aptos)",
  "withdraw.addrInvalid": "That does not look like a {label} address.",
  "withdraw.sendRightNetwork":
    "Send to the right network ({label}). Money sent to the wrong network or a wrong address cannot come back.",
  "withdraw.howManyPoints": "How much USDT do you want?",
  "withdraw.weSendWorth": "We send {points} to your wallet.",
  "withdraw.lowestPayout": "Lowest payout is {points}.",
  "withdraw.needAtLeast": "You need at least {points} to get money.",
  "withdraw.notEnough": "You do not have that much yet.",
  "withdraw.sending": "Sending…",
  "withdraw.askForUsdt": "Ask for my USDT",
  "withdraw.safetyNote": "We check every payment to keep your account safe.",
  "withdraw.gotRequest": "We got your request",
  "withdraw.onTheWay": "{points} is on the way.",
  "withdraw.network": "Network",
  "withdraw.toWallet": "To this wallet",
  "withdraw.requestReceived": "Request received",
  "withdraw.slaNote":
    "We check and send your USDT within 72 hours. We will tell you when it is sent.",
  "withdraw.seeWallet": "See my wallet",
  "withdraw.backHome": "Back to home",
  // login (shared)
  // The brand tagline (founder, 2026-07-13). Three words, three things the user
  // does. "Get paid" — not "Pay" — because the earner is the one being paid.
  "login.tagline": "Mine. Earn. Get paid.",
  "login.or": "or",
  "login.telegramOpen": "Continue in Telegram",
  "login.yourEmail": "Your email",
  "login.emailPlaceholder": "name@email.com",
  "login.min8Placeholder": "At least 8 letters",
  "login.backToLogin": "Back to log in",
  // login mode
  "login.login.title": "Log in",
  "login.login.subtitle": "Welcome back. Enter your email and password.",
  "login.password": "Password",
  "login.passwordPlaceholder": "Your password",
  "login.forgot": "Forgot password?",
  "login.loggingIn": "Logging in…",
  "login.logIn": "Log in",
  "login.newHere": "New here? Create an account",
  // register mode
  "login.register.title": "Create an account",
  "login.register.subtitle": "We will email you one code to confirm your address.",
  "login.invitedWith": "You were invited with code {code}. Nice!",
  "login.makePassword": "Make a password",
  "login.passwordHint": "Use 8 letters or more. Keep it safe.",
  "login.sending": "Sending…",
  "login.createAccount": "Create account",
  "login.haveAccount": "Already have an account? Log in",
  "login.emailSafe": "We keep your email safe. We never share it.",
  // verify mode
  "login.verify.title": "Check your email",
  "login.verify.subtitle": "We sent a 6-number code to {email}.",
  "login.enterCode": "Enter the code",
  "login.checking": "Checking…",
  "login.verifyContinue": "Verify and continue",
  // forgot mode
  "login.forgot.title": "Forgot password",
  "login.forgot.subtitle": "Enter your email. We will send a code to set a new password.",
  "login.sendCode": "Send code",
  // reset mode
  "login.reset.title": "Set a new password",
  "login.reset.subtitle": "Enter the code we sent to {email} and a new password.",
  "login.code": "Code",
  "login.newPassword": "New password",
  "login.saving": "Saving…",
  "login.saveContinue": "Save and continue",
  // login dynamic messages
  "login.msg.verifyPrompt": "Please check your email for a code to verify your account.",
  "login.msg.codeSent": "We sent a 6-number code to {email}.",
  "login.msg.forgotSent": "If that email has an account, we sent a code to it.",
  // ---- Send / receive + the token list (founder, 2026-07-30) ---------------
  "wallet.send": "Send",
  "wallet.receive": "Receive",
  "wallet.sendOff": "Sending is not switched on yet.",
  "wallet.tokens.title": "Your tokens",
  // The TOKEN, not the company. This row said "RoziPay", so the list read
  // RoziPay / USDT / BNB — two rows naming a token and one naming the app.
  // ---- Send / Receive chooser (founder, 2026-08-05) -------------------------
  // ROZI transfer and USDT deposit/withdraw are different balances with
  // different screens. Tapping Send or Receive opens this chooser instead of
  // going straight to ROZI, which is what made USDT unreachable from here.
  "wallet.chooser.send.title": "What do you want to withdraw?",
  "wallet.chooser.receive.title": "What do you want to deposit?",
  "wallet.chooser.rozi.sendSub": "To another RoziPay user, by handle",
  "wallet.chooser.rozi.receiveSub": "Show your handle so a friend can send you ROZI",
  "wallet.chooser.usdt.cashout.title": "USDT — cash out",
  "wallet.chooser.usdt.cashout.sub": "Your task and referral earnings",
  "wallet.chooser.usdt.refund.title": "USDT — get your deposit back",
  "wallet.chooser.usdt.refund.sub": "Unspent USDT you added",
  "wallet.chooser.usdt.deposit.title": "USDT — add money",
  "wallet.chooser.usdt.deposit.sub": "Get your deposit address",

  "wallet.token.rozi.name": "ROZI",
  // ⚠️ SUPERSEDES the 2026-08-03 "no ROZI balance on /wallet" decision
  // (founder, 2026-08-09): a token row showing "Coming soon" and no number,
  // one tap above /wallet/rozi showing a real balance, is the wallet screen
  // contradicting itself. What is coming soon is TRANSFERS, not the balance —
  // so the row states the balance and names the thing that is actually shut.
  //
  // ⚠️ THE NUMBER ON THIS ROW IS MINED ROZI ONLY, AND THAT IS LOAD-BEARING.
  // /mine leads with mined + earned (totalRoziMicro), because there the points
  // half has nowhere else to appear. On /wallet the points half is ALREADY in
  // the Total Balance above, as USDT. Showing the combined figure here would
  // count the same earnings twice on one screen.
  "wallet.token.rozi.sub": "ROZI tokens",
  "wallet.token.comingSoon": "Coming soon",
  "wallet.token.usdt.name": "USDT",
  "wallet.token.usdt.sub": "BNB Smart Chain · buys mining machines",
  // ⚠️ THE BNB ROW HAS NO BALANCE BEHIND IT AND MUST SAY SO. We hold no BNB for
  // anyone: there is no per-user wallet, no chain listener, nothing that could
  // ever make this number move (see docs/CUSTODY_SPEC.md). A silent "0.00"
  // beside two real balances reads as a bug, or worse, as money that went
  // missing — so the row names itself as not open yet. When per-user deposit
  // wallets are built, this line is what gets deleted.
  //
  // ⚠️ AND IT MUST NOT SAY "SOON" EITHER. This amount used to read "Soon" — the
  // same word /mine and the road map use for cashing out, which IS actively
  // being worked on. Per-user deposit wallets are a custody and licensing
  // decision we have declined for now (CUSTODY_SPEC.md), not a near-term item.
  // One word covering both flattens exactly the distinction the rest of this
  // file exists to protect. The subtitle already says "not open yet" in words;
  // the amount column should hold a dash, which promises nothing at all.
  "wallet.token.bnb.name": "BNB",
  "wallet.token.bnb.sub": "BNB Smart Chain · not open yet",
  // Shown instead of the line above once the user's own wallet address can
  // genuinely hold BNB (2026-08-08, second pass) — this is real gas money,
  // not the "we hold none of this" case the line above still is elsewhere.
  "wallet.token.bnb.gasSub": "For sending USDT — your own wallet",
  "wallet.token.soon": "—",
  // ---- Wallet overhaul (Total Balance, Deposit/Withdraw, unified history) --
  // Reverses the 2026-07-30/08-03 "hide USDT, ROZI only" decisions on
  // /wallet specifically — see CLAUDE.md's wallet-overhaul entry for why.
  "wallet.deposit": "Deposit",
  "wallet.withdraw": "Withdraw",
  "wallet.totalBalance": "Total balance",
  "wallet.available": "Available",
  "wallet.locked": "Locked",
  "wallet.total": "Total",
  "wallet.chooser.bnb.title": "BNB",
  "wallet.chooser.bnb.sub": "Get your BNB back, or add more",
  "wallet.chooser.bnb.depositSub": "Same address as USDT — get your deposit address",
  "wallet.filter.all": "All",
  "wallet.filter.button": "Filter",
  "wallet.filter.received": "Received",
  "wallet.filter.sent": "Sent",
  "wallet.filter.reward": "Rewards",
  "wallet.filter.mining": "Mining",
  "wallet.tx.usdtWithdrawal": "USDT withdrawal",
  "wallet.tx.usdtDeposit": "USDT deposit",
  "wallet.tx.usdtRefund": "USDT sent back",
  "wallet.tx.bnbWithdrawal": "BNB withdrawal",
  "wallet.tx.bnbDeposit": "BNB deposit",
  "wallet.usdt.transactions": "Transactions",
  "wallet.bnb.transactions": "Transactions",
  "wallet.bnb.amount": "How much BNB?",
  "wallet.bnb.submitted": "We're sending your BNB now.",
  "wallet.bnb.notEnough": "You do not have enough BNB for this amount and its own network fee.",
  "wallet.bnb.feeNote": "The network fee is about {fee}.",
  "wallet.rozi.miningBalance": "Mining balance",
  "wallet.rozi.seeMine": "The full balance and history live on the Mine tab.",
  "wallet.rozi.openMine": "Open Mine",
  "wallet.rozi.transactions": "Transactions",
  // ⚠️ ROZI MOVES BETWEEN ACCOUNTS. IT DOES NOT DEPOSIT OR WITHDRAW.
  // This page used the wallet-wide "Deposit"/"Withdraw" labels, which on every
  // other token on this screen mean real money crossing a chain. ROZI cannot
  // leave the system at all — the buttons go to /mine/send and /mine/receive,
  // which are user-to-user transfers by handle. "Withdraw" there reads as a
  // cash-out promise for a token the road map deliberately refuses to price.
  "wallet.rozi.send": "Send",
  "wallet.rozi.receive": "Receive",
  // Per-screen empty-history copy for unifyHistory() views (real money
  // movement only — see walletHistory.ts's header). Each names what would
  // actually make a row appear on THAT screen, so the sentence stays true
  // instead of pointing at an action (mining, finishing a task) that fills a
  // different list entirely.
  "wallet.noHistoryBody.money": "Your deposits, withdrawals and transfers will show up here.",
  "wallet.noHistoryBody.roziTransfers": "Send or receive ROZI to see it here. Mining and task ROZI show on the Mine tab.",
  "wallet.noHistoryBody.usdt": "Your USDT deposits and withdrawals will show up here.",
  "wallet.noHistoryBody.bnb": "Your BNB deposits and withdrawals will show up here.",
  // ---- Transaction detail sheet ---------------------------------------------
  "tx.amount": "Amount",
  "tx.status": "Status",
  "tx.network": "Network",
  "tx.from": "From",
  "tx.to": "To",
  "tx.hash": "Transaction ID",
  "tx.viewExplorer": "View on BscScan",
  "withdraw.saveAddress": "Save this address",
  "withdraw.addressSaved": "Address saved",
  // Shown next to a typed address that has NOT been saved yet — the exact gap
  // a founder fell into (2026-08-07): typed an address, thought that alone was
  // enough, never tapped the separate Save button, and the withdraw screen's
  // button stayed disabled with no obvious reason why. This makes the
  // in-between state visible instead of silent.
  "withdraw.addressNotSaved": "Not saved yet — tap \"Save this address\" below, or it will not be used.",
  // Shown on /wallet/withdraw right next to the disabled Send button when the
  // reason is a missing/unsaved payout wallet, not the amount — belowMin and
  // overBalance already get their own message, an address problem must too.
  "withdraw.needWalletFirst": "Set up your payout wallet above first — the button will turn on once it is saved.",
  "withdraw.feeLabel": "Withdrawal fee",
  "withdraw.youReceive": "You receive",
  // ---- Connect a wallet (2026-08-01) ---------------------------------------
  // The words a user reads before handing over the address we will send real
  // money to. Two rules held throughout:
  //
  //   1. NO CRYPTO JARGON. Not "sign", not "signature", not "gas", not
  //      "verify ownership". The wallet app supplies those words on its own
  //      screen; ours has to say what is about to happen in words someone who
  //      has never used a wallet can follow.
  //   2. SAY WHAT IT CANNOT DO. The single biggest reason a first-time user
  //      refuses this prompt is the fear that connecting lets us take their
  //      coins. Answering that before they ask is worth more than any
  //      reassurance about security afterwards.
  "connect.title": "Where should we send your money?",
  "connect.body":
    "Open your wallet app and pick the address. We save it, and your money goes there.",
  "connect.cta": "Connect my wallet",
  "connect.change": "Use a different wallet",
  "connect.working": "Waiting for your wallet…",
  "connect.safety":
    "Connecting is free. We can only see your address — we can never take anything from your wallet.",
  "connect.savedLabel": "Your {label} wallet",
  "connect.isYours": "Checked — this wallet is yours",
  "connect.typedIn": "You typed this one in. Connect the wallet to be sure it is yours.",
  "connect.typeInstead": "Type the address in instead",
  "connect.connectInstead": "Connect my wallet instead",
  // Very common in our markets: the wallet app IS installed, but the user is in
  // Chrome, where the page cannot see it. "You have no wallet" would be wrong
  // and would send them off to install a second one.
  "connect.noWallet":
    "This browser cannot see your wallet. Open this page inside your wallet app instead.",
  "connect.openMetamask": "Open in MetaMask",
  "connect.openTrust": "Open in Trust Wallet",
  // leaderboard
  "leaderboard.title": "Leaderboard",
  "leaderboard.subtitle": "Top earners and top inviters.",
  "leaderboard.topEarners": "Top earners",
  "leaderboard.topReferrers": "Top inviters",
  "leaderboard.emptyTitle": "No one here yet",
  "leaderboard.emptyBody": "Finish tasks and invite friends to reach the top.",
  "leaderboard.you": "You",
  "leaderboard.invitesLabel": "{n} friends invited",
  "leaderboard.seeLeaderboard": "See the leaderboard",
  // surveys (CPX)
  // ⚠️ SIMPLIFIED 2026-08-12 (founder audit): "Answer surveys" / "New surveys
  // for you. Earn real money." read like an ad banner rather than a plain
  // description of what this is. The tasks-list card now reuses this same
  // subtitle instead of a separate hype line — one honest sentence, said once.
  "surveys.title": "Surveys",
  "surveys.subtitle": "Share your opinion and get paid.",
  "surveys.disclosure":
    "These surveys come from our partner. Your money is added after they confirm you finished — this can take a little time.",
  "surveys.offTitle": "Surveys are closed right now",
  "surveys.offBody": "Please check again soon.",
  "surveys.openNewTab": "Surveys not opening? Open them in a new tab",
  // ---- mining (ROZI) ----
  // ROZI is the MINED currency: a separate ledger, not backed by revenue, and
  // NOT withdrawable. Every string here has to be honest about that. Implying
  // a cash value would be the fastest way to burn the brand.
  //
  // TONE (founder, 2026-07-27): ROZI is the HEADLINE of this product, not a
  // footnote we apologise for. The old copy led with "ROZI is not money yet" —
  // true, but it read as a disclaimer and taught users the main feature was the
  // unimportant one. It now leads with being early, and the limit follows.
  //
  // What we may promise here is bounded by MINING_SPEC.md § 7, and the line is
  // narrow enough to be worth restating: SENDING ROZI to another user is a real
  // roadmap item, and so is TURNING IT INTO MONEY through a Conversion Window.
  // SELLING it — us matching buyers and sellers, or touching the money leg —
  // is the one thing we decided we will never build, because it would make us
  // an unlicensed exchange under PVARA. So no string here says "sell", and none
  // ever should, however much better it would convert.
  "nav.mine": "Mine",
  "mine.title": "Mine ROZI",
  "mine.subtitle": "Earn ROZI every day, even when there are no tasks.",
  // ⚠️ THE CASH-OUT PROMISE IS GONE FROM THIS SENTENCE (founder, 2026-08-09:
  // "Do not promise future cash-out unless that is guaranteed"). It read "Soon
  // you will be able to cash out your ROZI", which was the app's most forward
  // claim sitting on its most-visited screen, backed by an unfunded treasury —
  // and the road map already had to drop "Cash out to USDT" from its own
  // Working-today list for exactly that reason. The remaining line says only
  // what is true today and is the stronger motivator anyway: the rate falls,
  // and today's mining cannot be re-mined later.
  //
  // ⚠️ REMOVED FROM BOTH SCREENS AT ONCE — here and wallet.rozi.notcash on
  // home. The earlier rule was "one promise, three screens, no version of it
  // anywhere that says more"; that rule still holds, and the promise is now
  // nowhere. Do not put "soon you can cash out" back on one screen alone.
  //
  // ⚠️ IT PROMISED SENDING "SOON" AFTER SENDING SHIPPED. Transfers went live
  // (transfersEnabled = 1) and this banner kept saying you would be able to send
  // ROZI to friends soon — with the Send card rendering two scrolls below it on
  // the same screen. Every "soon" in this app is protecting the one claim we
  // cannot yet back, and a user who can visibly disprove one of them discounts
  // all of them. Never leave a "soon" attached to something already shipped.
  "mine.notcash.title": "You're early.",
  "mine.notcash.body":
    "Mine while the rate is high. The rate halves as RoziPay grows — what you mine today, you cannot mine again later.",
  // MINED ONLY — see the label block at home.rozi.label. This screen's number is
  // what can be spent on rigs, sent, converted or spent in the store, and it is
  // smaller than the figure on home and in the top bar. The earned half is shown
  // on its own line right under it so the two visibly reconcile here, on the
  // screen a user is most likely to notice the gap.
  "mine.balance": "Your mined ROZI",
  "mine.balance.earned": "You also have {n} from tasks and friends.",
  "mine.hashrate": "Your mining speed",
  "mine.today": "You will get today",
  "mine.estimate.note":
    "This is a guess, not a promise. It goes down when more people mine. It goes up when you mine faster.",
  // Pi model: the number is EARNED, not estimated. Other people mining cannot
  // take it away, so we must not hedge it — hedging a real number teaches users
  // to distrust the ones that are real.
  "mine.earned": "You have earned today",
  "mine.earned.note":
    "This is yours. It goes up the longer you mine. Other people mining does not take it away.",
  // Settlement (once a day) makes ROZI CLAIMABLE, not credited — the user still
  // has to tap to collect it. This card only shows once there is something ready.
  "mine.claim.title": "Your gems are ready",
  "mine.claim.body": "This ROZI is settled and waiting for you. Tap to add it to your balance.",
  "mine.claim.cta": "Claim my gems",
  "mine.claim.done": "Claimed! {n} ROZI added to your balance.",
  "mine.start": "Start mining for {hours} hours",
  "mine.running": "You are mining now",
  "mine.running.note": "Come back when the time runs out and start again.",
  "mine.device.blocked":
    "Someone already mined on this phone today with a different account. So this account earns nothing today. One phone, one miner.",
  "mine.boost.title": "Mine faster",
  "mine.boost.task.title": "Finish a survey",
  "mine.boost.task.body": "Get paid, and mine faster for 2 days.",
  "mine.boost.ad.title": "Watch an ad",
  // Anchored to the user's actual current speed so "{pct}% faster" has a
  // number to be faster THAN, instead of floating on its own (audit 2026-08-12).
  "mine.boost.ad.body": "You mine at {speed} now. Watch an ad to add {pct}% for {hours} hours.",
  "mine.boost.ad.left": "{n} left today",
  "mine.boost.ad.cta": "Watch",
  "mine.ad.done": "Done. You now mine {pct}% faster for {hours} hours.",
  // The ad opens in a new tab; the user comes back and taps Claim.
  "mine.ad.open": "The ad opened in a new tab. Watch it, then come back here.",
  "mine.ad.claimWait": "Claim in {s}s",
  "mine.ad.claim": "Claim my boost",
  "mine.ad.blocked": "Your phone blocked the ad window. Allow pop-ups for this app, then try again.",
  "mine.boost.rigs.title": "Buy a machine",
  "mine.activity.title": "Recent activity",
  "mine.breakdown.title": "Your mining speed",
  "mine.breakdown.base": "Everyone gets",
  "mine.breakdown.rigs": "Your machines",
  "mine.breakdown.streak": "{days} days in a row",
  "mine.breakdown.boosts": "Boosts",
  "mine.breakdown.referral": "Your friends",
  "mine.breakdown.note":
    "Mine every day to keep your run going. Miss one day and it starts from zero again. Friends only add speed while they are mining too.",
  // rigs
  "rigs.back": "Back to mining",
  "rigs.title": "Mining machines",
  "rigs.subtitle": "Spend ROZI now to mine faster from now on.",
  // MINED ONLY — see the label block at home.rozi.label.
  "rigs.yourRozi": "Your mined ROZI",
  "rigs.available": "Machines",
  "rigs.notOwned": "You do not have this yet",
  "rigs.speed": "Speed",
  "rigs.level": "Level {level} of {max}",
  "rigs.next": "Next",
  "rigs.buy": "Buy",
  "rigs.upgrade": "Upgrade",
  "rigs.maxed": "Fully upgraded",
  "rigs.bought": "Done. Your machine is now level {level}.",
  "rigs.treadmill":
    "Every level costs more than the last, and gives a little less speed for the price. Buy the cheap machines first. Machines never expire or wear out — an upgrade is permanent.",
  // The number version of the arrow ("450 → 540") on the list card and the
  // detail page's "After this upgrade" tile — the arrow alone still leaves a
  // reader doing the subtraction themselves (audit 2026-08-12).
  "rigs.pctIncrease": "+{pct}%",
  // Payback estimate + a "best value" badge across the list (founder,
  // 2026-08-12: rig info "is very incomplete"). Only rendered when the API
  // sends a real number — see the /mining/rigs route for why that's pi-model
  // only. n is already formatted ROZI, not a raw number.
  "rigs.extraPerDay": "+{n} ROZI a day",
  "rigs.payback": "pays for itself in ~{days} days",
  "rigs.bestValue": "Best value",
  // ---- Send ROZI (wallet to wallet) ----
  // A TRANSFER, not a sale. No string here may suggest a price, a buyer, or that
  // we will find someone to trade with — that is the MINING_SPEC.md § 7 line, and
  // the copy is where it gets crossed first. "Send", never "sell".
  "send.title": "Send ROZI",
  "send.subtitle": "Send ROZI to anyone on RoziPay.",
  // MINED ONLY — see the label block at home.rozi.label. This is the screen the
  // mislabelling hurt most: the amount field validates against THIS number, so a
  // user reading the combined figure in the top bar was told they did not have
  // ROZI the app had just shown them.
  "send.balance": "Your mined ROZI",
  "send.to.label": "Who are you sending to?",
  "send.to.placeholder": "Their @handle, invite code or email",
  "send.amount.label": "How much?",
  "send.fee": "Small fee: {fee} ROZI ({pct}%)",
  "send.receives": "They get {n} ROZI",
  "send.cta": "Send",
  "send.sending": "Sending…",
  "send.done": "Sent. {n} ROZI is now with them.",
  "send.left": "You can send {n} more ROZI today.",
  "send.notEnough": "You do not have that much ROZI.",
  "send.off.title": "Sending is not open yet",
  "send.off.body": "You can mine ROZI now. Sending it to other people opens soon.",
  "send.kyc.title": "Verify your ID first",
  "send.kyc.body": "We check who you are before you send ROZI to someone else. It takes a few minutes.",
  "send.kyc.pending": "We are checking your ID now. You can send ROZI once it is approved.",
  "send.kyc.cta": "Verify my ID",
  "send.age.title": "Your account is too new",
  "send.age.body": "You can send ROZI when your account is {days} days old. Keep mining until then.",

  // ---- Receive -------------------------------------------------------------
  // There is nothing to fill in here: receiving needs no permission, no ID check
  // and no minimum account age (see transferRequireKyc in mining/core.ts). The
  // whole screen is "here is your name, copy it".
  "receive.title": "Receive ROZI",
  "receive.subtitle": "Give this to anyone on RoziPay and they can send you ROZI.",
  "receive.handle": "Your @handle",
  "receive.code": "Or your invite code",
  "receive.codeHint": "This works too, if a friend has not saved your @handle.",
  "receive.copy": "Copy",
  "receive.copied": "Copied.",
  "receive.noHandle.title": "Pick your @handle first",
  "receive.noHandle.body":
    "A @handle is the short name friends type to send you ROZI. It takes ten seconds to pick one.",
  "receive.noHandle.cta": "Pick my @handle",
  "receive.safe":
    "Sharing your @handle is safe. It only lets people send you ROZI — never take it.",

  // ---- Turn ROZI into money (the Conversion Window) -------------------------
  // THE HARDEST COPY IN THE APP, and the place a careless word costs the most.
  //
  // There is NO fixed rate, by design (MINING_SPEC.md § 6). A pot of money is
  // fixed before the window opens, everyone who puts ROZI in shares that pot, so
  // your share SHRINKS as more people join. That is not a catch to bury — it is
  // the mechanism, and a user who discovers it after the fact will believe we
  // cheated them. So it is said twice, in the plainest words available, before
  // anyone types a number.
  //
  // ⚠️ THE SHARED POT IS WHY THIS SCREEN CAN SAY "USDT" WITHOUT BECOMING A
  // PRICE. Naming the pot in dollars is safe only because the pot is FIXED and
  // shared — the sentence is "this much money exists to share", never "your ROZI
  // is worth this much". Those look similar and are not: the second is a fixed
  // rate, i.e. a promise to buy back a token we mint for free (guardrail #7).
  //
  // Banned here: "rate", "worth", "price", "value", "exchange", and any sentence
  // of the form "1 ROZI = ...". If a future ticket asks for a live rate on this
  // screen, that is the ticket to push back on.
  "convert.title": "Turn ROZI into money",
  "convert.subtitle": "Take your share of this week's pot, and cash it out in USDT.",
  "convert.pot": "This week's pot",
  "convert.potNote":
    "Everyone who puts ROZI in shares this pot. The more people join, the smaller each share.",
  "convert.closesIn": "Closes in {time}",
  // MINED ONLY — see the label block at home.rozi.label. Correct twice over
  // here: the conversion ceiling is a percentage of what you have ever MINED, so
  // showing the combined figure would over-state what can go into the pot.
  "convert.yourRozi": "Your mined ROZI",
  "convert.amount.label": "How much ROZI do you want to put in?",
  "convert.youPutIn": "You put in",
  "convert.ifClosedNow": "Your share if it closed right now",
  "convert.ifClosedNote":
    "This number moves. It goes down when other people join, and up when they do not.",
  "convert.cta": "Put my ROZI in",
  "convert.working": "Working…",
  "convert.done": "Done. Your money arrives when the pot closes.",
  // The per-user ceiling, said as a positive ("this much is unlocked") rather
  // than as a punishment. It is a real limit and it is not hidden — but a user
  // who mines more unlocks more, and that is the sentence that should stick.
  "convert.limit.title": "You can turn {n} ROZI into money",
  "convert.limit.body":
    "You unlock {pct}% of everything you mine. Mine more and this goes up.",
  "convert.limit.none":
    "You have used all of it for now. Keep mining — every ROZI you mine unlocks more.",
  "convert.limit.used": "Used so far: {n} ROZI",
  "convert.tooMuch": "You can only put in {n} ROZI right now.",
  "convert.notEnough": "You do not have that much ROZI.",
  "convert.closed.title": "No pot is open right now",
  "convert.closed.body":
    "We open one every so often. Keep mining — your ROZI is safe and waiting.",
  "convert.off.title": "This opens later",
  "convert.off.body":
    "Turning ROZI into money is not open yet. Mine now — what you mine is yours, and it will be waiting.",
  "mine.convert.title": "Turn ROZI into money",

  // ---- Spend ROZI (the store) ----------------------------------------------
  // ROZI buys real things at a price WE set. That is a shop, not an exchange,
  // and the copy has to stay on the shop side of that line: we sell items, we do
  // not buy ROZI. So there is no string here of the form "your ROZI is worth X",
  // and none that quotes a rate. "Costs 500 ROZI" is a price; "500 ROZI = Rs 100"
  // is a promise we would have to keep forever.
  "store.title": "Spend your ROZI",
  "store.subtitle": "Use the ROZI you mined on real things.",
  // MINED ONLY — see the label block at home.rozi.label.
  "store.yourRozi": "Your mined ROZI",
  "store.cost": "{n} ROZI",
  "store.get": "Get this",
  "store.outOfStock": "All gone for now",
  "store.notEnough": "Keep mining",
  "store.empty.title": "Nothing in the shop yet",
  "store.empty.body": "We are adding things you can buy with ROZI. Keep mining — yours is safe.",
  "store.input.hint": "Where should we send it?",
  "store.confirm": "Use {n} ROZI for {title}?",
  "store.ordered": "Done. We are sending it now.",
  "store.orders": "Your orders",
  "store.status.pending": "On the way",
  "store.status.fulfilled": "Sent",
  "store.status.rejected": "Not done — your ROZI came back",

  // Speed boosters, priced in the withdrawable money balance (points under
  // the hood; see formatMoney) — a sink for the cash side, same idea as the
  // ROZI store above, just the other currency. The route applies the boost
  // immediately on purchase; its effect shows up in the existing "Boosts"
  // row on /mine, so this screen only needs to sell it.
  "boosters.title": "Speed boosters",
  "boosters.subtitle": "Spend money you have earned to mine faster for a while.",
  "boosters.yourMoney": "Your money",
  "boosters.effect": "+{pct}% speed for {hours} hours",
  "boosters.get": "Get this",
  "boosters.notEnough": "Not enough yet",
  "boosters.empty.title": "No boosters right now",
  "boosters.empty.body": "Check back soon — keep mining in the meantime.",
  "boosters.confirm": "Use {n} for {title}?",
  "boosters.bought": "Done. Your mining is faster now.",

  "mine.store.title": "Spend your ROZI",
  "mine.boosters.title": "Speed up mining",

  // ---- Add USDT (top-up credit) ---------------------------------------------
  // THE HARDEST PROMISE TO GET RIGHT ON THIS SCREEN is what the money can and
  // cannot do afterwards. It buys mining machines and nothing else — it cannot
  // be cashed out again, and it is not the same balance as task earnings.
  //
  // That has to be said BEFORE the address, not in small print under it. A user
  // who sends USDT and then discovers it cannot come back out has been misled by
  // us, even if every individual word on the page was true.
  "topup.title": "Add USDT",
  "topup.subtitle": "Add USDT to buy mining machines.",
  "topup.balance": "Your USDT here",
  // ⚠️ THIS CARD USED TO SAY "you cannot take it back out". That stopped being
  // true on 2026-08-01, when the founder opened refunds — and a false promise
  // about money, sitting above the address someone is about to send money to,
  // is the worst single string this app could carry. It says what is true now:
  // this is not your task earnings, and what you have not spent, you can ask for.
  "topup.spendOnly.title": "This USDT buys machines.",
  "topup.spendOnly.body":
    "It is not the same as the money you earn from tasks. If you change your mind, you can ask us to send back whatever you have not spent.",
  "topup.how": "How to add USDT",
  // THE TOKEN AND THE NETWORK ARE TWO DIFFERENT THINGS, and this copy has to keep
  // them apart or it kills people's money.
  //
  // The chain label is "BEP20 · BNB Chain", so the old line here read "Send only
  // USDT on BEP20 · BNB Chain" — in which the most eye-catching word is BNB, a
  // real token the user holds in the same wallet. Someone skimming sends BNB.
  // It arrives, it is not USDT, and there is no way to give it back.
  //
  // So: the token is named on its own ("USDT"), the network is named on its own
  // ("BNB Smart Chain (BEP20)"), and BNB appears exactly once — in the list of
  // things NOT to send. Do not reintroduce a {chain} placeholder into a sentence
  // about what to send.
  "topup.step1": "Send USDT to the address below. Use the BNB Smart Chain (BEP20) network.",
  "topup.step2": "Copy the transaction ID from your wallet.",
  "topup.step3": "Paste it here with the amount you sent. We check it and add it.",
  "topup.address": "Send USDT to this address",
  // Shown only when CUSTODY_SPEC.md § 5 step 1 is on (an xpub is configured)
  // and this address was derived just for this account, not shared with every
  // other user. Deposits are still confirmed by staff reading the tx hash —
  // this line is not a promise of automatic crediting, only whose address it is.
  "topup.yourOwnAddress": "This address belongs only to your account",
  "topup.addressWarn":
    "Send USDT only — never BNB or any other coin, and only on BNB Smart Chain (BEP20). Anything else is lost and we cannot get it back.",
  // The auto-credit path (founder, 2026-08-12): a personal deposit address is
  // watched by the same scanner that credits BNB — no tx hash to paste, no
  // staff step. Said once, right here, so nobody sits waiting for a form that
  // no longer exists.
  "topup.autoNote":
    "We add it automatically once the blockchain confirms it — usually within a few minutes. No need to tell us anything.",
  "topup.network": "Network",
  "topup.networkValue": "BNB Smart Chain (BEP20)",
  "topup.token": "Coin to send",
  "topup.tokenValue": "USDT",
  "topup.copy": "Copy address",
  "topup.copied": "Copied.",
  "topup.txLabel": "Transaction ID",
  "topup.txPlaceholder": "Paste it from your wallet",
  "topup.amountLabel": "How much did you send?",
  "topup.limits": "Between {min} and {max} USDT.",
  "topup.submit": "I have sent it",
  "topup.sending": "Sending…",
  "topup.done.title": "We are checking it",
  "topup.done.body":
    "Someone from our team will look at your transaction and add the USDT. This usually takes a few hours.",
  "topup.history": "Your top-ups",
  "topup.status.pending": "Checking",
  "topup.status.confirmed": "Added",
  "topup.status.rejected": "Not added",
  "topup.empty": "You have not added any USDT yet.",
  "topup.off.title": "Not open yet",
  "topup.off.body": "Adding USDT is not switched on. You can still buy machines with ROZI.",

  // ---- Asking for a deposit back (founder, 2026-08-01) ----------------------
  // Deliberately never called a "withdrawal": this sends back money the user
  // themselves put in, and it is not the route their task earnings take out.
  // Blurring those two on screen would teach people the wrong thing about which
  // balance is which, on the screen where that matters most.
  "refund.title": "Get your USDT back",
  "refund.subtitle": "We can send back the USDT you added and have not spent.",
  "refund.link": "Ask for your USDT back",
  "refund.available": "You can ask for",
  "refund.amountLabel": "How much do you want back?",
  "refund.addressLabel": "Send it to this address",
  "refund.addressHint": "Your own USDT wallet on BNB Smart Chain (BEP20).",
  "refund.min": "The smallest amount we can send back is {min} USDT.",
  "refund.notSpent": "Only USDT you have not spent on machines can come back.",
  "refund.notEarnings": "This is the USDT you put in yourself — it is yours, and you can ask for all of it back, any time. (Your task and referral earnings are a separate balance and go out from your wallet instead.)",
  // The button used to just sit disabled with no explanation whenever the
  // balance was under refundMinMicro (e.g. a 0.04 USDT balance against a 1
  // USDT minimum) — these two explain WHY, the same way withdraw.needAtLeast
  // / withdraw.notEnough do on the withdraw screen.
  "refund.needAtLeast": "You need at least {min} to ask for it back.",
  "refund.notEnough": "You do not have that much to give back.",
  // Gas is the user's own responsibility (founder, 2026-08-08, second pass):
  // sending USDT costs a small network fee, paid in BNB, from the user's own
  // wallet — not a USDT amount we subtract. Shown before submit whenever we
  // can check it, so nothing is held if the send cannot actually go through.
  "refund.gasLabel": "Network fee wallet",
  "refund.gasReady": "You have enough BNB to send this.",
  "refund.gasNotReady": "You need BNB in your wallet to pay the network fee. Please deposit BNB to your RoziPay wallet before withdrawing USDT.",
  "refund.gasBalance": "Your BNB balance: {balance}",
  // The gas fee (founder, 2026-08-08) — only shown when Admin has actually
  // set one (percent or fixed > 0). Most deployments show none of these.
  "refund.feeLabel": "Network fee",
  "refund.youGet": "You get",
  "refund.sentNet": "We sent {net} after a {fee} network fee.",
  "refund.rowNet": "You got {net} after the network fee",
  "refund.submit": "Get my USDT back",
  "refund.sending": "Sending…",
  "refund.done.title": "We got your request",
  "refund.done.body":
    "Someone from our team will send it and show you the transaction. This usually takes a few hours.",
  // Shown instead of the two lines above when the request settled the moment
  // it was made (automatic on-chain send is on and the amount was under the
  // ceiling) — see autoRefund.ts. Off by default; the copy above is what
  // almost every user sees until that is turned on.
  "refund.done.instant.title": "Sent!",
  "refund.done.instant.body": "Your USDT is already on its way. The transaction is below.",
  // Shown when the request is signing and broadcasting right now (a few
  // blocks from done — payoutRelay.ts), not instant and not queued for staff.
  "refund.done.sending.title": "On its way",
  "refund.done.sending.body": "We're sending it now. It should land in your wallet within a few minutes.",
  "refund.history": "Your requests",
  "refund.empty": "You have not asked for any money back.",
  "refund.status.pending": "Waiting",
  "refund.status.sending": "Sending",
  "refund.status.paid": "Sent",
  "refund.status.rejected": "Not sent",
  "refund.none": "You have no USDT to send back yet.",
  "rigs.yourUsdt": "Your USDT",
  "rigs.payRozi": "Pay with ROZI",
  "rigs.payUsdt": "Pay with USDT",
  "rigs.addUsdt": "Add USDT",
  "rigs.roziOnly": "This one is ROZI only.",
  "rigs.viewDetails": "Details",
  "mine.topup.title": "Add USDT",
  // ---- Machine detail page (/mine/rigs/[id]) ----
  "rigDetail.back": "Back to machines",
  "rigDetail.current": "Current speed",
  "rigDetail.nextLevel": "After this upgrade",
  "rigDetail.cost": "Cost to upgrade",
  "rigDetail.estimateTitle": "About {value}",
  "rigDetail.estimateBody":
    "A rough estimate only, at today's admin-set rate. ROZI has no fixed cash price and this number can change at any time — it is not a guarantee of value.",

  // ---- The road map ---------------------------------------------------------
  // What is coming, and when. Two rules hold this page together:
  //
  //   1. NOTHING HERE MAY MENTION A PRICE, or hint at one. "Open trading" is a
  //      step we are working on; "ROZI will be worth X" is a promise we cannot
  //      keep and must never make. A road map that talks about price stops being
  //      a plan and becomes an offer.
  //   2. The "Live now" block comes FIRST, on purpose. A road map made only of
  //      future dates reads like a wish list. Leading with what already works is
  //      what makes the rest believable.
  //
  // Dates are the founder's (revised 2026-07-30): Aug-Sep mining, Oct-Nov ID
  // check, Dec open trading, Jan big exchange.
  //
  // ⚠️ "Cash out to USDT" WAS in the Live-now list and has been REMOVED (founder,
  // 2026-07-30: "right now there is no USDT cash out"). The withdrawal code
  // works, but the treasury is not funded, so nobody can actually be paid — and
  // a claim on this page that a user cannot act on is the single most damaging
  // thing it could contain. Cash-out goes back on this list when a real payout
  // has cleared, and not before.
  "mine.roadmap.title": "Roadmap",
  "roadmap.title": "The road ahead",
  "roadmap.subtitle": "Where RoziPay is going, and when.",
  "roadmap.live.title": "Working today",
  "roadmap.live.mining": "Mine ROZI every day",
  "roadmap.live.tasks": "Answer surveys and earn",
  "roadmap.live.rigs": "Buy machines to mine faster",
  // ⚠️ THE QUALIFIER IS LOAD-BEARING. Sending requires the ID check
  // (transferRequireKyc = 1), and the "What is next" section below dates the ID
  // check to October — November. Unqualified, this row told a user a feature
  // works today sixty pixels above the date its gate arrives.
  "roadmap.live.send": "Send ROZI to a friend (after your ID check)",
  "roadmap.live.invite": "Invite friends and earn with them",
  "roadmap.next.title": "What is next",
  // State badges for the timeline (audit 2026-08-12: every "next" row looked
  // identical before this — no way to tell "happening now" from "months away").
  // Computed from the same date ranges the *.when strings above describe, in
  // roadmap/page.tsx — not admin-editable, on purpose: see that file's header.
  "roadmap.state.done": "Done",
  "roadmap.state.active": "Happening now",
  "roadmap.state.upcoming": "Up next",
  "roadmap.state.planned": "Planned",
  "roadmap.step.launch.when": "August — September 2026",
  "roadmap.step.launch.title": "Mining opens to everyone",
  "roadmap.step.launch.body":
    "RoziPay opens to everyone. Two months of mining, so the people who came first have the most ROZI.",
  "roadmap.step.kyc.when": "October — November 2026",
  "roadmap.step.kyc.title": "ID check",
  "roadmap.step.kyc.body":
    "Show us your ID once. It keeps fake accounts out, and it is what lets us pay real money out safely.",
  "roadmap.step.dex.when": "December 2026",
  "roadmap.step.dex.title": "Open trading",
  "roadmap.step.dex.body":
    "ROZI goes on an open trading site, where anyone can swap it. This is the step we are building everything else toward.",
  "roadmap.step.cex.when": "January 2027",
  "roadmap.step.cex.title": "Big exchange",
  "roadmap.step.cex.body":
    "We apply to list ROZI on a large, well-known exchange. Big exchanges decide for themselves, so this one is not ours alone to promise.",
  // The honest footer. It is small, but it is the difference between a plan and
  // a promise — and it is the line that lets us move a date without breaking
  // faith with anyone.
  "roadmap.note.title": "These are our plans, not promises.",
  "roadmap.note.body":
    "We will build in this order. Dates can move, and we will say so here if they do. We never promise a price for ROZI.",
  "roadmap.mine.cta": "Mine ROZI now",

  // COMBINED — see the label block at home.rozi.label. This card shows mined +
  // earned, so it must carry the combined label. It said "Your mined ROZI" over
  // the combined figure, which was the label bug pointing the wrong way.
  "wallet.rozi.label": "Your RoziPay balance",
  // GUARDRAIL: this sentence is what stops a user reading the whole balance as
  // cash, and it is the only place on the screen that says which half can be
  // paid out. It stays, in plain words, however the screen is rearranged.
  //
  // ⚠️ IT SAID "only your USDT above can be paid out today" AND POINTED AT
  // NOTHING. The "Your money · USDT" card it referred to was deleted in the same
  // commit that reordered this screen, so the sentence aimed at empty space.
  //
  // It also said "you cannot cash it out yet" while /mine said "soon you will be
  // able to" — the same fact in two tones. Both are gone now: the "soon you can
  // cash it out" claim was dropped from this screen and from mine.notcash.body
  // in the same pass (founder, 2026-08-09). What is left states which half can
  // be paid out, and promises nothing about the other half.
  "wallet.rozi.notcash":
    "You are mining ROZI early. Only what you earned from tasks and friends can be paid out now.",

  // ---- Verify your ID -------------------------------------------------------
  // ⚠️ THIS COMMENT SAID THE OPPOSITE OF THE STRING UNDER IT, and the string was
  // right. It read "the word KYC appears nowhere a user can see it" — written
  // before the founder's 2026-08-01 decision to keep the abbreviation, because
  // in Pakistan, India and Bangladesh it is what every bank and exchange calls
  // this step, i.e. the FAMILIAR word here rather than the jargon one. The full
  // reasoning is at profile.verifyId; the two are one decision and must not
  // drift apart again.
  "kyc.title": "Verify your KYC",
  "kyc.subtitle": "We need to check you are a real person before we send you money.",
  // Shown when an Admin has switched the ID check off. Reachable from a bookmark
  // or an old link, so it has to answer for itself. ⚠️ No date, ever — "soon" is
  // the ceiling on this promise, the same as /mine and the road map.
  "kyc.off.title": "Coming soon",
  "kyc.off.body": "We are not checking IDs yet. You do not need to send anything.",
  "kyc.off.back": "Back to my profile",
  "kyc.why.title": "Why we ask",
  "kyc.why.body":
    "It stops one person making many accounts. It also keeps your money safe, and it is how we know where to send it.",
  "kyc.safe":
    "Your photos are locked so only our checking team can open them. We never show them to anyone else.",
  "kyc.need": "You need three photos",
  "kyc.selfie": "A photo of your face",
  "kyc.selfie.hint": "Look at the camera. Good light. No sunglasses or cap.",
  "kyc.front": "Front of your ID card",
  "kyc.front.hint": "All four corners in the photo. No blur.",
  "kyc.back": "Back of your ID card",
  "kyc.back.hint": "All four corners in the photo. No blur.",
  "kyc.take": "Take photo",
  "kyc.retake": "Take again",
  "kyc.submit": "Send for checking",
  "kyc.sending": "Sending…",
  "kyc.status.pending.title": "We are checking your ID",
  "kyc.status.pending.body":
    "This usually takes a day or two. We will tell you as soon as it is done. You can keep mining while you wait.",
  "kyc.status.approved.title": "You are verified",
  "kyc.status.approved.body":
    "All done. You can withdraw your money, and your friends now earn you a bonus.",
  "kyc.status.rejected.title": "We could not accept your photos",
  "kyc.status.rejected.body": "Please read the note below and send new photos.",
  "kyc.status.rejected.again": "Send new photos",
  "kyc.unlocks.title": "What this gives you",
  "kyc.unlocks.withdraw": "You can take your money out",
  "kyc.unlocks.referral": "Friends you invite start earning you a bonus",
  "kyc.unlocks.trust": "Your account is marked as a real person",
  "kyc.error.missing": "Please add all three photos first.",
  "kyc.error.big": "That photo is too big. Try again.",

  // Shown on the withdraw screen when they have not verified yet.
  "withdraw.kyc.title": "Verify your ID first",
  "withdraw.kyc.body": "We check who you are before we send money. It only takes a minute.",
  "withdraw.kyc.cta": "Verify your ID",
  "withdraw.kyc.pending": "We are still checking your ID. You can withdraw as soon as that is done.",

  // Shown on the withdraw screen for a large amount (api/src/config.ts
  // stepUpMinPoints) — one more code, emailed, before we send real money.
  "withdraw.stepUp.title": "Confirm it's you",
  "withdraw.stepUp.body": "This is a big withdrawal, so we sent a 6-digit code to your email. Enter it below to send the money.",
  "withdraw.stepUp.codeLabel": "Code from your email",
  "withdraw.stepUp.resend": "Send the code again",
  "withdraw.stepUp.resent": "Code sent again",
  "withdraw.stepUp.confirm": "Confirm and send",

  // ---- Notifications ----------------------------------------------------------
  // The user turns these on themselves (Help screen, or after a withdrawal).
  // Honest about what they get: money news and replies — not marketing spam.
  "notify.title": "Get told when your money moves",
  "notify.body":
    "We send a message to your phone when your money is sent, when we reply to you, and when your ID check is done — even when the app is closed.",
  "notify.enable": "Turn on notifications",
  "notify.enabling": "Turning on…",
  "notify.on": "Notifications are on",
  "notify.onBody": "We will tell you when your money is sent or we reply to you.",
  "notify.disable": "Turn off",
  "notify.denied":
    "Your phone is blocking notifications for this app. Allow them in your browser settings, then try again.",
  "notify.error": "That did not work. Please try again.",
  // Shown on the withdraw success screen — the moment they most want to know.
  "notify.withdraw.hook": "Want to know the moment your money is sent?",

  // Shown on the mine screen when an ad may show before mining starts.
  "mine.gate.title": "An ad may show first",
  "mine.gate.body": "A short ad may show first. Your machine then runs for {hours} hours.",
};

type Ctx = { t: (key: string, vars?: Record<string, string>) => string };

const I18nContext = createContext<Ctx | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const t = useCallback((key: string, vars?: Record<string, string>) => {
    let s = copy[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
    return s;
  }, []);

  return <I18nContext.Provider value={{ t }}>{children}</I18nContext.Provider>;
}

export function useI18n(): Ctx {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}
