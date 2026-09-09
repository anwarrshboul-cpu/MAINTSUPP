import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "MAINTSUPP | Maintenance coordination, done right",
    template: "%s | MAINTSUPP",
  },
  description:
    "MAINTSUPP coordinates maintenance, compliance, contractors and property operations across multi-site portfolios.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  /*
   * metadataBase is what turns the relative image path below into the absolute
   * URL that Open Graph requires. Without it Next warns and the image is
   * dropped, which is the failure that leaves a shared link showing a blank
   * card.
   */
  metadataBase: new URL("https://maintsupp.com"),
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    siteName: "MAINTSUPP",
    locale: "en_GB",
    url: "https://maintsupp.com",
    title: "MAINTSUPP | Maintenance coordination, done right",
    description:
      "MAINTSUPP coordinates maintenance, compliance, contractors and property operations across multi-site portfolios.",
    images: [
      {
        url: "/assets/photos/hero-london-maintenance.jpg",
        width: 1774,
        height: 887,
        alt: "Commercial maintenance across a London skyline",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "MAINTSUPP | Maintenance coordination, done right",
    description:
      "MAINTSUPP coordinates maintenance, compliance, contractors and property operations across multi-site portfolios.",
    images: ["/assets/photos/hero-london-maintenance.jpg"],
  },
  verification: {
    google: "2a_6h1gdZv0Xev0zfGeBscLPGrPXVetMpazl2UtoVVA",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    /*
     * `suppressHydrationWarning` on both, and only for the theme.
     *
     * The app group runs a blocking script before first paint that stamps
     * `data-theme` on `<html>` and `<body>` (see app/(app)/layout.tsx). React
     * did not render those attributes, so hydration reports them as unexpected
     * — a warning about the fix working. The flag suppresses the mismatch on
     * these two elements only; it does not reach any child.
     */
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
