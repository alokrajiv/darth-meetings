import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SessionKeeper } from "@/components/session-keeper";
import { OfflineProvider } from "@/lib/offline/offline-context";
import { OfflineBanner } from "@/components/offline-banner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Darth Meetings",
    template: "%s · Darth Meetings",
  },
  description: "Upload meeting audio, get a clean speaker-labelled transcript.",
  // PWA manifest: lets the app be installed (Add to Dock / Home Screen), which
  // on Safari also lifts the 7-day eviction of the offline caches.
  manifest: "/manifest.webmanifest",
  // Safari/iOS install polish: the home-screen/Dock icon and the standalone
  // (no browser chrome) flag — Chrome reads the manifest, Safari reads these.
  icons: { apple: "/icons/icon-180.png" },
  appleWebApp: { capable: true, title: "Meetings", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#111111",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applies the saved (or OS-preferred) theme before first paint to avoid a flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('theme');if(t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark')}catch(e){}",
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <SessionKeeper />
        {/* Client-only: registers /sw.js, tracks connectivity and the offline
            pins; the banner renders nothing unless there is something to say. */}
        <OfflineProvider>
          <OfflineBanner />
          {children}
        </OfflineProvider>
      </body>
    </html>
  );
}
