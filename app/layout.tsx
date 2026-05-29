import type { Metadata, Viewport } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "../components/providers/ThemeProvider";
import { DebugModeProvider } from "../components/DebugModeContext";
import { AppShell } from "../components/AppShell";
import { getPlatformAppNameForMetadata } from "../lib/platform-settings-read";

/** Global Menorix PWA — whole-app install (not operator-scoped). */
const PWA_THEME_COLOR = "#0f172a";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const title = await getPlatformAppNameForMetadata();
  return {
    title,
    description: "B2B Returns & Recovery Platform",
    manifest: "/manifest.json",
    applicationName: "Menorix",
    appleWebApp: {
      capable: true,
      title: "Menorix",
      statusBarStyle: "black-translucent",
    },
    icons: {
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
            <AppShell>{children}</AppShell>
          </DebugModeProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
