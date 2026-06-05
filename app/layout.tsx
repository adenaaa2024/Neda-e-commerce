import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Inter, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "../components/providers/ThemeProvider";
import { DebugModeProvider } from "../components/DebugModeContext";
import { AppShell } from "../components/AppShell";
import { PwaStandaloneScannerRedirect } from "../components/PwaStandaloneScannerRedirect";
import { PwaEarlyInstallCapture } from "../components/PwaEarlyInstallCapture";
import { PwaServiceWorkerRegister } from "../components/PwaServiceWorkerRegister";
import { PWA_APP_NAME } from "../lib/pwa-app-version";
import { getPlatformAppNameForMetadata } from "../lib/platform-settings-read";

/** Global Menorix PWA — matches operator-mobile scanner canvas. */
const PWA_THEME_COLOR = "#050607";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const SITE_URL = "https://menorix.com";

export async function generateMetadata(): Promise<Metadata> {
  const title = await getPlatformAppNameForMetadata();
  return {
    metadataBase: new URL(SITE_URL),
    title,
    description: "B2B Returns & Recovery Platform",
    manifest: "/manifest.json",
    applicationName: PWA_APP_NAME,
    appleWebApp: {
      capable: true,
      title: PWA_APP_NAME,
      statusBarStyle: "black-translucent",
    },
    icons: {
      icon: [
        { url: "/favicon.ico", sizes: "48x48", type: "image/x-icon" },
        { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
        { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
        { url: "/favicon.png", sizes: "48x48", type: "image/png" },
        { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
      shortcut: "/favicon.ico",
      apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  /** Zebra / rugged Android browsers: allow pinch-zoom; fixed max scale can break layout on some WebViews. */
  maximumScale: 5,
  userScalable: true,
  viewportFit: "cover",
  themeColor: PWA_THEME_COLOR,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <PwaEarlyInstallCapture />
      </head>
      <body className={`${inter.variable} ${geistMono.variable} font-sans antialiased`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <DebugModeProvider>
            {/*
             * AppShell renders the persistent collapsible sidebar on desktop
             * and a hamburger-triggered drawer on mobile.
             * Every page route is wrapped here — the sidebar NEVER disappears.
             */}
            <Suspense fallback={null}>
              <PwaServiceWorkerRegister />
              <PwaStandaloneScannerRedirect />
              <AppShell>{children}</AppShell>
            </Suspense>
          </DebugModeProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
