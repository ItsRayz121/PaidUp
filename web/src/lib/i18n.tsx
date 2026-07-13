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
  // nav + common
  "topbar.points": "points",
  "topbar.balanceLabel": "Your points. Tap to open your wallet.",

  "nav.home": "Home",
  "nav.tasks": "Tasks",
  "nav.wallet": "Wallet",
  "nav.refer": "Refer",
  "nav.help": "Help",
  "common.yourCountry": "your country",
  "common.yourPoints": "Your points",
  "common.getMyMoney": "Get my money",
  "common.cancel": "Cancel",
  "common.pointsAmount": "{n} points",
  // install (PWA add-to-home-screen). Say plainly that nothing is downloaded —
  // "install" makes people expect an APK, and we must not over-promise.
  "install.title": "Put RoziPay on your phone",
  "install.body":
    "Open RoziPay from your home screen, like an app. Nothing to download — it takes one tap.",
  "install.iosBody":
    "Tap the Share button at the bottom of Safari, then choose “Add to Home Screen”.",
  "install.cta": "Add to home screen",
  "install.later": "Not now",
  // tasks
  "tasks.title": "Ways to earn",
  "tasks.subtitle": "Finish a task and get points.",
  "tasks.disclosure":
    "These are sponsored offers from our partners. We tell you who gives the reward before you start.",
  "tasks.empty.title": "More ways to earn are coming",
  "tasks.empty.body":
    "Surveys are open now — tap “Answer surveys” above to earn today. New task types are added soon.",
  "tasks.seeAll": "See all",
  // home
  "home.hello": "Hello,",
  "home.wePayCash": "We pay real cash",
  "home.aboutValue": "That is {value}",
  "home.toPayout": "{points} points to your first payout",
  "home.quickTaskTitle": "Do a quick task now",
  "home.friendsJoined": "{n} friends joined",
  "home.earnedFromThem": "You earned {points} points from them.",
  // wallet
  "wallet.subtitle": "Your points and your money history.",
  "wallet.aboutValue": "Worth {value}",
  "wallet.reachAt": "You can get your money at {points} points. Keep earning — you are close.",
  "wallet.history": "History",
  "wallet.noHistoryTitle": "No history yet",
  "wallet.noHistoryBody": "Finish a task to see your first points here.",
  "wallet.needHelp": "Need help with a payment?",
  "wallet.contactSupport": "Contact support",
  // refer
  "refer.title": "Invite friends",
  "refer.subtitle": "Share your code. Earn together.",
  "refer.yourCode": "Your code",
  "refer.copyLink": "Copy link",
  "refer.copied": "Copied",
  "refer.share": "Share",
  "refer.friendsJoined": "Friends joined",
  "refer.pointsEarned": "Points earned",
  "refer.howItWorks": "How it works",
  "refer.step1": "Share your code with friends.",
  "refer.step2": "They join and start earning.",
  "refer.step3": "You get points when they earn.",
  "refer.step4": "You also mine faster while they mine.",
  "refer.trustNote": "Your friends only trust apps that pay. Get your money first, then share.",
  "refer.inviteMessage":
    "I use RoziPay to earn real money. Join with my code {code} and we both get points. {link}",
  // help
  "help.title": "Help & support",
  "help.subtitle": "Tell us the problem. A real person will reply.",
  "help.askForHelp": "Ask for help",
  "help.noQuestionsTitle": "No questions yet",
  "help.noQuestionsBody":
    "If your points did not come, or money is late, ask here and we will check.",
  "help.pointsNote":
    "Points are only added after the offer partner confirms your task. This can take a little time.",
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
  "help.subjectPlaceholder": "Short subject (e.g. Points not added)",
  "help.messagePlaceholder": "Tell us what happened.",
  "help.send": "Send",
  // withdraw
  "withdraw.youHave": "You have",
  "withdraw.aboutEquals": "= {value}",
  "withdraw.getPaidUsdt": "Get paid in USDT",
  "withdraw.localRow": "More local payment methods",
  "withdraw.comingSoon": "Coming soon",
  "withdraw.yourWalletAddress": "Your USDT wallet address",
  "withdraw.addrPlaceholderEvm": "0x… (42 characters)",
  "withdraw.addrPlaceholderAptos": "0x… (Aptos)",
  "withdraw.addrInvalid": "That does not look like a {label} address.",
  "withdraw.sendRightNetwork":
    "Send to the right network ({label}). Money sent to the wrong network or a wrong address cannot come back.",
  "withdraw.howManyPoints": "How many points?",
  "withdraw.weSendWorth": "We send USDT worth {points} to your wallet.",
  "withdraw.lowestPayout": "Lowest payout is {points}.",
  "withdraw.needAtLeast": "You need at least {points} to get money.",
  "withdraw.notEnough": "You do not have that many points yet.",
  "withdraw.sending": "Sending…",
  "withdraw.askForUsdt": "Ask for my USDT",
  "withdraw.safetyNote": "We check every payment to keep your account safe.",
  "withdraw.gotRequest": "We got your request",
  "withdraw.onTheWay": "USDT for {points} is on the way.",
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
  // wallet + withdraw additions
  "wallet.setupWallet": "Set up my withdrawal wallet",
  "withdraw.saveAddress": "Save this address",
  "withdraw.addressSaved": "Address saved",
  "withdraw.feeLabel": "Withdrawal fee",
  "withdraw.youReceive": "You receive",
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
  "surveys.title": "Answer surveys",
  "surveys.subtitle": "Share your opinion and get points.",
  "surveys.cta": "New surveys for you. Earn real points.",
  "surveys.disclosure":
    "These surveys come from our partner. Points are added after they confirm you finished — this can take a little time.",
  "surveys.offTitle": "Surveys are closed right now",
  "surveys.offBody": "Please check again soon.",
  "surveys.openNewTab": "Surveys not opening? Open them in a new tab",
  // ---- mining (ROZI) ----
  // ROZI is the MINED currency: a separate ledger, not backed by revenue, and
  // NOT withdrawable. Every string here has to be honest about that. Implying
  // a cash value would be the fastest way to burn the brand.
  "nav.mine": "Mine",
  "mine.title": "Mine ROZI",
  "mine.subtitle": "Earn ROZI every day, even when there are no tasks.",
  "mine.notcash.title": "ROZI is not money yet.",
  "mine.notcash.body":
    "You cannot turn ROZI into cash. You are mining it early. Your points are a different thing — points are your real money.",
  "mine.balance": "Your ROZI",
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
  "mine.start": "Start mining for {hours} hours",
  "mine.running": "You are mining now",
  "mine.running.note": "Come back when the time runs out and start again.",
  "mine.device.blocked":
    "Someone already mined on this phone today with a different account. So this account earns nothing today. One phone, one miner.",
  "mine.boost.title": "Mine faster",
  "mine.boost.task.title": "Finish a survey",
  "mine.boost.task.body": "Get points, and mine faster for 2 days.",
  "mine.boost.ad.title": "Watch a short video",
  "mine.boost.ad.body": "Mine {pct}% faster for {hours} hours.",
  "mine.boost.ad.left": "{n} left today",
  "mine.boost.ad.cta": "Watch",
  "mine.ad.done": "Done. You now mine {pct}% faster for {hours} hours.",
  "mine.boost.rigs.title": "Buy a machine",
  "mine.boost.rigs.body": "Spend ROZI to mine faster from now on.",
  "mine.breakdown.title": "What makes your speed",
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
  "rigs.yourRozi": "Your ROZI",
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
    "Every level costs more than the last, and gives a little less speed for the price. Buy the cheap machines first.",
  "wallet.rozi.label": "Your mined ROZI",
  "wallet.rozi.notcash":
    "ROZI is not money yet. You cannot withdraw it. Only your points above can be paid out.",

  // ---- Verify your ID -------------------------------------------------------
  // The word "KYC" appears nowhere a user can see it. It is jargon, and half our
  // users would not know it. "Verify your ID" says the same thing to everyone.
  "kyc.title": "Verify your ID",
  "kyc.subtitle": "We need to check you are a real person before we send you money.",
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

  // Shown on the mine screen when an ad plays before mining starts.
  "mine.gate.title": "Watch a short video to start",
  "mine.gate.body": "One short video, then your machine runs for {hours} hours.",
  "mine.gate.loading": "Getting your video…",
  "mine.gate.skipped": "No video right now. Your machine started anyway.",
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
