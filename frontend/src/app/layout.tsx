/* =============================================================================
   Root layout
   -----------------------------------------------------------------------------
   Fonts, design tokens, global styles, providers, and the application chrome.
   The shell is rendered here so every route inherits identical navigation,
   footer and background treatment.
   ============================================================================= */

import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk } from "next/font/google";

import "@/styles/globals.css";
import { DataSourceProvider } from "@/lib/data-source";
import { ToastProvider } from "@/components/ui/Toast";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { DemoModeBanner } from "@/components/layout/DemoModeBanner";

const sans = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const display = Space_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
});

export const metadata: Metadata = {
  title: {
    default: "AgentWebEinh — browser automation, made visible",
    template: "%s · AgentWebEinh",
  },
  description:
    "Describe a task in plain language and watch a browser agent carry it out live, with a clear report of what it did and what it found.",
  applicationName: "AgentWebEinh",
  authors: [{ name: "Adithya" }],
  creator: "Adithya",
  keywords: ["browser automation", "ai agent", "task automation", "web agent"],
  openGraph: {
    title: "AgentWebEinh",
    description: "Your tasks. Handled by an intelligent browser agent.",
    type: "website",
  },
  robots: { index: false },
};

export const viewport: Viewport = {
  themeColor: "#0b0d18",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

const shellStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: "100dvh",
};

const mainStyle: React.CSSProperties = {
  flex: "1 1 auto",
  outline: "none",
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable}`}>
      <body>
        <DataSourceProvider>
          <ToastProvider>
            <a className="bw-skip-link" href="#main">
              Skip to main content
            </a>
            <DemoModeBanner />
            <div style={shellStyle}>
              <SiteHeader />
              <main id="main" style={mainStyle} tabIndex={-1}>
                {children}
              </main>
              <SiteFooter />
            </div>
          </ToastProvider>
        </DataSourceProvider>
      </body>
    </html>
  );
}