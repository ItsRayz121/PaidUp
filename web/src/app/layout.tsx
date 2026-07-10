import type { Metadata, Viewport } from "next";
import { Inter, Sora } from "next/font/google";
import "./globals.css";
import { BottomNav } from "@/components/BottomNav";

// Body: highly legible sans for cheap screens. Display: friendlier face for
// big numbers (balances, earnings). See DESIGN_BRIEF typography.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const sora = Sora({ subsets: ["latin"], variable: "--font-sora", display: "swap" });

export const metadata: Metadata = {
  title: "PaidUp — earn and get real money",
  description: "Do simple tasks, earn points, and get real cash in your mobile wallet.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0d5c63",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${sora.variable} antialiased`}>
        <div className="app-frame flex flex-col">
          <main className="flex-1">{children}</main>
          <BottomNav />
        </div>
      </body>
    </html>
  );
}
