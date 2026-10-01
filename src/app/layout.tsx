import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SessionKeeper } from "@/components/session-keeper";
import { OfflineProvider } from "@/lib/offline/offline-context";
import { AppBadge } from "@/lib/offline/app-badge";
import { OfflineBanner } from "@/components/offline-banner";
import { CompanionBanner } from "@/components/companion-banner";
import { headers } from "next/headers";
import { ShellSearchProvider } from "@/components/shell-search";
import { desktopShellOf } from "@/lib/desktop-shell";
import { THEME_BOOT_SCRIPT } from "@/lib/listing-layout";

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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Darth desktop shell (README "Darth desktop shell"): decided from the
  // REQUEST's User-Agent (`DarthDesktop/<ver>`), so the first paint already
  // carries <html data-shell="desktop" data-shell-os="mac|win|linux"> and the
  // same answer reaches the client as a prop — no flash, no hydration diff.
  const desktopShell = desktopShellOf((await headers()).get("user-agent"));
  return (
    <html
      lang="en"
      suppressHydrationWarning
      data-shell={desktopShell?.shell}
      data-shell-os={desktopShell?.os ?? undefined}
    >
      <head>
        {/* Applies the theme before first paint to avoid a flash: in the
            browser the saved (or OS-preferred) one; inside the Darth shell
            prefers-color-scheme, followed live (Darth sets the theme). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <SessionKeeper />
        {/* Client-only: registers /sw.js, tracks connectivity and the offline
            pins; the banner renders nothing unless there is something to say. */}
        <OfflineProvider>
          {/* Installed app only: icon badge = meetings waiting for speaker review. */}
          <AppBadge />
          <OfflineBanner />
          {/* Client-only: talks to the local Darth Recorder tray (ws://127.0.0.1:47800)
              when one is installed; renders nothing otherwise. */}
          <CompanionBanner />
          {/* Inside the shell the band's search drives the results panel (and
              the in-app search field feeds the same one). Outside it this
              adds nothing and listens to nothing. */}
          <ShellSearchProvider inDesktopShell={desktopShell !== null}>
            {children}
          </ShellSearchProvider>
        </OfflineProvider>
      </body>
    </html>
  );
}
