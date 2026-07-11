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
    "lang.label": "Language",
    // tasks
    "tasks.title": "Ways to earn",
    "tasks.subtitle": "Finish a task and get points.",
    "tasks.disclosure":
      "These are sponsored offers from our partners. We tell you who gives the reward before you start.",
    "tasks.empty.title": "No tasks right now for {country}",
    "tasks.empty.body":
      "Check back soon. New tasks come every day. Meanwhile, invite a friend and earn more.",
    "tasks.seeAll": "See all",
    // home
    "home.hello": "Hello,",
    "home.wePayCash": "We pay real cash",
    "home.aboutValue": "That is about {value}",
    "home.toPayout": "{points} points to your first payout",
    "home.quickTaskTitle": "Do a quick task now",
    "home.friendsJoined": "{n} friends joined",
    "home.earnedFromThem": "You earned {points} points from them.",
    // wallet
    "wallet.subtitle": "Your points and your money history.",
    "wallet.aboutValue": "About {value}",
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
      "I use PaidUp to earn real money. Join with my code {code} and we both get points. {link}",
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
    "lang.label": "زبان",
    // tasks
    "tasks.title": "کمانے کے طریقے",
    "tasks.subtitle": "ایک کام مکمل کریں اور پوائنٹس پائیں۔",
    "tasks.disclosure":
      "یہ ہمارے شراکت داروں کی طرف سے سپانسر شدہ آفرز ہیں۔ شروع کرنے سے پہلے ہم آپ کو بتاتے ہیں کہ انعام کون دے رہا ہے۔",
    "tasks.empty.title": "{country} کے لیے ابھی کوئی کام نہیں ہے",
    "tasks.empty.body":
      "تھوڑی دیر بعد دوبارہ دیکھیں۔ نئے کام روزانہ آتے ہیں۔ اسی دوران، کسی دوست کو دعوت دیں اور زیادہ کمائیں۔",
    "tasks.seeAll": "سب دیکھیں",
    // home
    "home.hello": "خوش آمدید،",
    "home.wePayCash": "ہم اصلی پیسے دیتے ہیں",
    "home.aboutValue": "یہ تقریباً {value} ہے",
    "home.toPayout": "پہلی ادائیگی تک {points} پوائنٹس باقی ہیں",
    "home.quickTaskTitle": "ابھی ایک آسان کام کریں",
    "home.friendsJoined": "{n} دوست شامل ہوئے",
    "home.earnedFromThem": "آپ نے ان سے {points} پوائنٹس کمائے۔",
    // wallet
    "wallet.subtitle": "آپ کے پوائنٹس اور پیسوں کی تاریخ۔",
    "wallet.aboutValue": "تقریباً {value}",
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
      "میں اصلی پیسے کمانے کے لیے PaidUp استعمال کرتا ہوں۔ میرے کوڈ {code} کے ساتھ شامل ہوں اور ہم دونوں کو پوائنٹس ملیں گے۔ {link}",
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
  },
};

const STORAGE_KEY = "paidup.locale";

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
