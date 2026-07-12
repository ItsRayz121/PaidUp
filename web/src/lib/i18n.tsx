"use client";

// Lightweight client-side localization (Phase 3, Urdu first — DESIGN_BRIEF /
// PROJECT_SPEC "Local-language UI (Urdu first)"). The official Next app-router
// i18n uses /[lang] sub-paths, but this app is a client-rendered SPA with
// localStorage auth and a user-chosen language *preference* (not a per-URL
// locale), so a client dictionary + context fits far better and needs no route
// restructure. The internationalization guide notes localization "works the
// same with any web application". Urdu is right-to-left, so switching also flips
// document direction.
import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type Locale = "en" | "ur";
export const LOCALES: { id: Locale; label: string; dir: "ltr" | "rtl" }[] = [
  { id: "en", label: "English", dir: "ltr" },
  { id: "ur", label: "اردو", dir: "rtl" },
];

// Translation keys. Keep flat and simple — one key per user-facing string. Urdu
// copy follows the same simple-English-equivalent rule: short, plain, no jargon.
const dict: Record<Locale, Record<string, string>> = {
  en: {
    // nav + common
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
    "lang.label": "Language",
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
    "login.tagline": "Earn and get real cash",
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
  },
  ur: {
    // nav + common
    "nav.home": "ہوم",
    "nav.tasks": "کام",
    "nav.wallet": "بٹوہ",
    "nav.refer": "دعوت دیں",
    "nav.help": "مدد",
    "common.yourCountry": "آپ کا ملک",
    "common.yourPoints": "آپ کے پوائنٹس",
    "common.getMyMoney": "میرے پیسے نکالیں",
    "common.cancel": "منسوخ کریں",
    "common.pointsAmount": "{n} پوائنٹس",
    "lang.label": "زبان",
    // install (PWA add-to-home-screen)
    "install.title": "RoziPay کو اپنے فون میں شامل کریں",
    "install.body":
      "RoziPay کو ہوم اسکرین سے ایپ کی طرح کھولیں۔ کچھ ڈاؤن لوڈ نہیں کرنا — بس ایک ٹیپ۔",
    "install.iosBody": "سفاری میں نیچے شیئر کا بٹن دبائیں، پھر ”ہوم اسکرین پر شامل کریں“ چنیں۔",
    "install.cta": "ہوم اسکرین پر شامل کریں",
    "install.later": "ابھی نہیں",
    // tasks
    "tasks.title": "کمانے کے طریقے",
    "tasks.subtitle": "ایک کام مکمل کریں اور پوائنٹس پائیں۔",
    "tasks.disclosure":
      "یہ ہمارے شراکت داروں کی طرف سے سپانسر شدہ آفرز ہیں۔ شروع کرنے سے پہلے ہم آپ کو بتاتے ہیں کہ انعام کون دے رہا ہے۔",
    "tasks.empty.title": "کمانے کے مزید طریقے آ رہے ہیں",
    "tasks.empty.body":
      "سروے ابھی کھلے ہیں — آج کمانے کے لیے اوپر ”سروے کے جواب دیں“ پر ٹیپ کریں۔ نئے کام جلد شامل کیے جائیں گے۔",
    "tasks.seeAll": "سب دیکھیں",
    // home
    "home.hello": "خوش آمدید،",
    "home.wePayCash": "ہم اصلی پیسے دیتے ہیں",
    "home.aboutValue": "یہ {value} ہے",
    "home.toPayout": "پہلی ادائیگی تک {points} پوائنٹس باقی ہیں",
    "home.quickTaskTitle": "ابھی ایک آسان کام کریں",
    "home.friendsJoined": "{n} دوست شامل ہوئے",
    "home.earnedFromThem": "آپ نے ان سے {points} پوائنٹس کمائے۔",
    // wallet
    "wallet.subtitle": "آپ کے پوائنٹس اور پیسوں کی تاریخ۔",
    "wallet.aboutValue": "مالیت {value}",
    "wallet.reachAt": "آپ {points} پوائنٹس پر اپنے پیسے نکال سکتے ہیں۔ کماتے رہیں — آپ قریب ہیں۔",
    "wallet.history": "تاریخ",
    "wallet.noHistoryTitle": "ابھی کوئی تاریخ نہیں",
    "wallet.noHistoryBody": "اپنے پہلے پوائنٹس یہاں دیکھنے کے لیے ایک کام مکمل کریں۔",
    "wallet.needHelp": "ادائیگی میں مدد چاہیے؟",
    "wallet.contactSupport": "سپورٹ سے رابطہ کریں",
    // refer
    "refer.title": "دوستوں کو دعوت دیں",
    "refer.subtitle": "اپنا کوڈ شیئر کریں۔ مل کر کمائیں۔",
    "refer.yourCode": "آپ کا کوڈ",
    "refer.copyLink": "لنک کاپی کریں",
    "refer.copied": "کاپی ہو گیا",
    "refer.share": "شیئر کریں",
    "refer.friendsJoined": "شامل ہونے والے دوست",
    "refer.pointsEarned": "کمائے گئے پوائنٹس",
    "refer.howItWorks": "یہ کیسے کام کرتا ہے",
    "refer.step1": "اپنا کوڈ دوستوں کے ساتھ شیئر کریں۔",
    "refer.step2": "وہ شامل ہو کر کمانا شروع کرتے ہیں۔",
    "refer.step3": "جب وہ کماتے ہیں تو آپ کو پوائنٹس ملتے ہیں۔",
    "refer.trustNote":
      "آپ کے دوست صرف انہی ایپس پر بھروسہ کرتے ہیں جو ادائیگی کرتی ہیں۔ پہلے اپنے پیسے نکالیں، پھر شیئر کریں۔",
    "refer.inviteMessage":
      "میں اصلی پیسے کمانے کے لیے RoziPay استعمال کرتا ہوں۔ میرے کوڈ {code} کے ساتھ شامل ہوں اور ہم دونوں کو پوائنٹس ملیں گے۔ {link}",
    // help
    "help.title": "مدد اور سپورٹ",
    "help.subtitle": "ہمیں مسئلہ بتائیں۔ ایک اصل شخص جواب دے گا۔",
    "help.askForHelp": "مدد مانگیں",
    "help.noQuestionsTitle": "ابھی کوئی سوال نہیں",
    "help.noQuestionsBody":
      "اگر آپ کے پوائنٹس نہیں آئے، یا پیسے دیر سے آ رہے ہیں، تو یہاں پوچھیں اور ہم دیکھیں گے۔",
    "help.pointsNote":
      "پوائنٹس صرف اس وقت شامل ہوتے ہیں جب آفر پارٹنر آپ کے کام کی تصدیق کر دے۔ اس میں تھوڑا وقت لگ سکتا ہے۔",
    "help.statusWaiting": "جواب کا انتظار",
    "help.statusReplied": "ہم نے جواب دیا",
    "help.statusClosed": "بند",
    "help.lastUpdate": "آخری اپ ڈیٹ {time}",
    "help.you": "آپ",
    "help.support": "سپورٹ",
    "help.writeReply": "جواب لکھیں…",
    "help.sending": "بھیجا جا رہا ہے…",
    "help.sendReply": "جواب بھیجیں",
    "help.whatHelp": "آپ کو کس چیز میں مدد چاہیے؟",
    "help.subjectPlaceholder": "مختصر موضوع (مثلاً پوائنٹس شامل نہیں ہوئے)",
    "help.messagePlaceholder": "ہمیں بتائیں کیا ہوا۔",
    "help.send": "بھیجیں",
    // withdraw
    "withdraw.youHave": "آپ کے پاس ہے",
    "withdraw.aboutEquals": "= {value}",
    "withdraw.getPaidUsdt": "USDT میں ادائیگی لیں",
    "withdraw.localRow": "مزید مقامی ادائیگی کے طریقے",
    "withdraw.comingSoon": "جلد آ رہا ہے",
    "withdraw.yourWalletAddress": "آپ کا USDT والٹ ایڈریس",
    "withdraw.addrPlaceholderEvm": "‎0x… (42 حروف)",
    "withdraw.addrPlaceholderAptos": "‎0x… (Aptos)",
    "withdraw.addrInvalid": "یہ {label} ایڈریس نہیں لگتا۔",
    "withdraw.sendRightNetwork":
      "صحیح نیٹ ورک ({label}) پر بھیجیں۔ غلط نیٹ ورک یا غلط ایڈریس پر بھیجے گئے پیسے واپس نہیں آ سکتے۔",
    "withdraw.howManyPoints": "کتنے پوائنٹس؟",
    "withdraw.weSendWorth": "ہم آپ کے والٹ میں {points} کے برابر USDT بھیجتے ہیں۔",
    "withdraw.lowestPayout": "کم از کم ادائیگی {points} ہے۔",
    "withdraw.needAtLeast": "پیسے نکالنے کے لیے آپ کو کم از کم {points} چاہئیں۔",
    "withdraw.notEnough": "آپ کے پاس ابھی اتنے پوائنٹس نہیں ہیں۔",
    "withdraw.sending": "بھیجا جا رہا ہے…",
    "withdraw.askForUsdt": "میرا USDT مانگیں",
    "withdraw.safetyNote": "آپ کے اکاؤنٹ کو محفوظ رکھنے کے لیے ہم ہر ادائیگی کو جانچتے ہیں۔",
    "withdraw.gotRequest": "ہمیں آپ کی درخواست مل گئی",
    "withdraw.onTheWay": "{points} کے لیے USDT راستے میں ہے۔",
    "withdraw.network": "نیٹ ورک",
    "withdraw.toWallet": "اس والٹ پر",
    "withdraw.requestReceived": "درخواست موصول ہوئی",
    "withdraw.slaNote":
      "ہم 72 گھنٹوں کے اندر آپ کا USDT جانچ کر بھیج دیتے ہیں۔ بھیجنے پر ہم آپ کو بتا دیں گے۔",
    "withdraw.seeWallet": "میرا بٹوہ دیکھیں",
    "withdraw.backHome": "ہوم پر واپس جائیں",
    // login (shared)
    "login.tagline": "کمائیں اور اصلی پیسے پائیں",
    "login.or": "یا",
    "login.yourEmail": "آپ کا ای میل",
    "login.emailPlaceholder": "name@email.com",
    "login.min8Placeholder": "کم از کم 8 حروف",
    "login.backToLogin": "لاگ اِن پر واپس جائیں",
    // login mode
    "login.login.title": "لاگ اِن کریں",
    "login.login.subtitle": "خوش آمدید۔ اپنا ای میل اور پاس ورڈ درج کریں۔",
    "login.password": "پاس ورڈ",
    "login.passwordPlaceholder": "آپ کا پاس ورڈ",
    "login.forgot": "پاس ورڈ بھول گئے؟",
    "login.loggingIn": "لاگ اِن ہو رہا ہے…",
    "login.logIn": "لاگ اِن کریں",
    "login.newHere": "نئے ہیں؟ اکاؤنٹ بنائیں",
    // register mode
    "login.register.title": "اکاؤنٹ بنائیں",
    "login.register.subtitle": "ہم آپ کو آپ کے پتے کی تصدیق کے لیے ایک کوڈ ای میل کریں گے۔",
    "login.invitedWith": "آپ کو کوڈ {code} کے ساتھ دعوت دی گئی۔ بہت خوب!",
    "login.makePassword": "ایک پاس ورڈ بنائیں",
    "login.passwordHint": "8 یا زیادہ حروف استعمال کریں۔ اسے محفوظ رکھیں۔",
    "login.sending": "بھیجا جا رہا ہے…",
    "login.createAccount": "اکاؤنٹ بنائیں",
    "login.haveAccount": "پہلے سے اکاؤنٹ ہے؟ لاگ اِن کریں",
    "login.emailSafe": "ہم آپ کا ای میل محفوظ رکھتے ہیں۔ ہم اسے کبھی شیئر نہیں کرتے۔",
    // verify mode
    "login.verify.title": "اپنا ای میل دیکھیں",
    "login.verify.subtitle": "ہم نے {email} پر 6 نمبروں کا کوڈ بھیجا ہے۔",
    "login.enterCode": "کوڈ درج کریں",
    "login.checking": "جانچا جا رہا ہے…",
    "login.verifyContinue": "تصدیق کریں اور آگے بڑھیں",
    // forgot mode
    "login.forgot.title": "پاس ورڈ بھول گئے",
    "login.forgot.subtitle": "اپنا ای میل درج کریں۔ ہم نیا پاس ورڈ بنانے کے لیے کوڈ بھیجیں گے۔",
    "login.sendCode": "کوڈ بھیجیں",
    // reset mode
    "login.reset.title": "نیا پاس ورڈ بنائیں",
    "login.reset.subtitle": "ہم نے {email} پر جو کوڈ بھیجا ہے وہ اور ایک نیا پاس ورڈ درج کریں۔",
    "login.code": "کوڈ",
    "login.newPassword": "نیا پاس ورڈ",
    "login.saving": "محفوظ ہو رہا ہے…",
    "login.saveContinue": "محفوظ کریں اور آگے بڑھیں",
    // login dynamic messages
    "login.msg.verifyPrompt": "براہ کرم اپنے اکاؤنٹ کی تصدیق کے لیے اپنے ای میل میں کوڈ دیکھیں۔",
    "login.msg.codeSent": "ہم نے {email} پر 6 نمبروں کا کوڈ بھیجا ہے۔",
    "login.msg.forgotSent": "اگر اس ای میل کا اکاؤنٹ ہے، تو ہم نے اس پر کوڈ بھیج دیا ہے۔",
    // wallet + withdraw additions
    "wallet.setupWallet": "میرا واپسی والٹ سیٹ اپ کریں",
    "withdraw.saveAddress": "یہ ایڈریس محفوظ کریں",
    "withdraw.addressSaved": "ایڈریس محفوظ ہو گیا",
    "withdraw.feeLabel": "نکالنے کی فیس",
    "withdraw.youReceive": "آپ کو ملیں گے",
    // leaderboard
    "leaderboard.title": "لیڈر بورڈ",
    "leaderboard.subtitle": "سب سے زیادہ کمانے والے اور دعوت دینے والے۔",
    "leaderboard.topEarners": "سب سے زیادہ کمانے والے",
    "leaderboard.topReferrers": "سب سے زیادہ دعوت دینے والے",
    "leaderboard.emptyTitle": "ابھی یہاں کوئی نہیں",
    "leaderboard.emptyBody": "ٹاپ پر پہنچنے کے لیے کام مکمل کریں اور دوستوں کو دعوت دیں۔",
    "leaderboard.you": "آپ",
    "leaderboard.invitesLabel": "{n} دوستوں کو دعوت دی",
    "leaderboard.seeLeaderboard": "لیڈر بورڈ دیکھیں",
    // surveys (CPX)
    "surveys.title": "سروے کے جواب دیں",
    "surveys.subtitle": "اپنی رائے دیں اور پوائنٹس پائیں۔",
    "surveys.cta": "آپ کے لیے نئے سروے۔ اصلی پوائنٹس کمائیں۔",
    "surveys.disclosure":
      "یہ سروے ہمارے پارٹنر کی طرف سے ہیں۔ ان کے تصدیق کرنے کے بعد پوائنٹس شامل کیے جاتے ہیں — اس میں تھوڑا وقت لگ سکتا ہے۔",
    "surveys.offTitle": "ابھی سروے بند ہیں",
    "surveys.offBody": "براہ کرم تھوڑی دیر بعد دوبارہ دیکھیں۔",
    "surveys.openNewTab": "سروے نہیں کھل رہے؟ انہیں نئے ٹیب میں کھولیں",
  },
};

const STORAGE_KEY = "rozipay.locale";

function localeDir(l: Locale): "ltr" | "rtl" {
  return LOCALES.find((x) => x.id === l)?.dir ?? "ltr";
}

type Ctx = {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, vars?: Record<string, string>) => string;
};

const I18nContext = createContext<Ctx | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  // Start from "en" so server and first client render agree (no hydration
  // mismatch); the stored preference is applied in an effect right after mount.
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    const saved = (typeof window !== "undefined" && window.localStorage.getItem(STORAGE_KEY)) as Locale | null;
    if (saved && (saved === "en" || saved === "ur")) setLocaleState(saved);
  }, []);

  // Reflect the language onto <html> so the browser (and CSS) get lang + text
  // direction right. Urdu flips the whole app to RTL.
  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute("lang", locale);
    el.setAttribute("dir", localeDir(locale));
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      window.localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* private mode — preference just won't persist */
    }
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string>) => {
      let s = dict[locale][key] ?? dict.en[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
      return s;
    },
    [locale],
  );

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n(): Ctx {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}
