import type { Metadata, Viewport } from "next";
import { Inter, Sora } from "next/font/google";
import "./globals.css";
import { Shell } from "@/components/Shell";
import { SITE_URL } from "@/lib/site";

// Body: highly legible sans for cheap screens. Display: friendlier face for
// big numbers (balances, earnings). See DESIGN_BRIEF typography.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const sora = Sora({ subsets: ["latin"], variable: "--font-sora", display: "swap" });

// One title + one description, reused in the OG/Twitter tags below so a shared
// link can never say something different from the page itself.
const TITLE = "RoziPay — earn and get real money";
const DESCRIPTION = "Do simple tasks, earn points, and get real cash in your mobile wallet.";

export const metadata: Metadata = {
  // Absolute base for the social-share URLs below (and anything else relative
  // in here). Growth is referral links shared on WhatsApp; without these tags
  // a shared link is a bare grey URL, with them it is a card with our name,
  // line, and logo. That preview IS the first impression of the product.
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "RoziPay",
  // Installed to the home screen, the app runs without browser chrome (see
  // app/manifest.ts). iOS ignores the manifest for this and reads these instead.
  appleWebApp: { capable: true, title: "RoziPay", statusBarStyle: "default" },
  icons: { apple: "/icons/apple-touch-icon.png" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "RoziPay",
    title: TITLE,
    description: DESCRIPTION,
    // Square brand mark: WhatsApp and Telegram render squares fine, and it is
    // the only real art we have at a share-safe size.
    images: [{ url: "/icons/icon-512.png", width: 512, height: 512, alt: "RoziPay" }],
  },
  twitter: {
    card: "summary",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/icons/icon-512.png"],
  },
  // Monetag site-ownership verification. The file-upload method was NOT used
  // because their file is named sw.js and would clobber our service worker
  // (push + offline). This tag only proves ownership; it loads no ads.
  other: { monetag: "25b677620d04ee3a6b34fc326cec1ff8" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0d5c63",
  // Standalone mode has no browser bar, so the phone's own gesture area can sit
  // on top of our UI. This makes env(safe-area-inset-*) report real values so
  // the bottom nav and install sheet can pad around it.
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${sora.variable} antialiased`}>
        {/* No telegram-web-app.js here, deliberately: telegram.org is blocked
            on many Pakistani networks, and a blocked beforeInteractive script
            stalls the page for everyone. lib/telegram.ts reads the Mini App's
            initData straight from the URL fragment instead. */}
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
