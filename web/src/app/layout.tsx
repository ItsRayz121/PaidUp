import type { Metadata, Viewport } from "next";
import { Inter, Sora } from "next/font/google";
import "./globals.css";
import { Shell } from "@/components/Shell";

// Body: highly legible sans for cheap screens. Display: friendlier face for
// big numbers (balances, earnings). See DESIGN_BRIEF typography.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const sora = Sora({ subsets: ["latin"], variable: "--font-sora", display: "swap" });

export const metadata: Metadata = {
  title: "RoziPay — earn and get real money",
  description: "Do simple tasks, earn points, and get real cash in your mobile wallet.",
  applicationName: "RoziPay",
  // Installed to the home screen, the app runs without browser chrome (see
  // app/manifest.ts). iOS ignores the manifest for this and reads these instead.
  appleWebApp: { capable: true, title: "RoziPay", statusBarStyle: "default" },
  icons: { apple: "/icons/apple-touch-icon.png" },
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
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
