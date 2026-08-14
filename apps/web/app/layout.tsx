import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "MAINTSUPP", template: "%s | MAINTSUPP" },
  description: "Maintenance coordination across multi-site portfolios.",
};

/*
 * `viewport-fit=cover` plus the safe-area padding in globals.css: without it
 * the "Work completed" button sits under the home indicator on a notched
 * iPhone, which is precisely where a thumb lands.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
