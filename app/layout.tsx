import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "MAINTSUPP | Maintenance coordination, done right",
    template: "%s | MAINTSUPP",
  },
  description:
    "MAINTSUPP coordinates maintenance, compliance, contractors and property operations across multi-site portfolios.",
  /*
   * THE TAB ICON, AND WHY IT IS FOUR FILES.
   *
   * This is the ROOT layout, so the marketing site, the portal and the public
   * link pages all inherit exactly this set. Verified rather than assumed:
   * none of the three group layouts declares an `icons` block and nothing
   * else under app/ does either, so this is the only declaration there is.
   *
   * The supplied brand tile is a JPEG, so it carries no transparency and the
   * area outside its rounded corners is #f7f7f7. Dropped in unchanged that
   * paints a white frame around the mark in every browser tab, so the corners
   * are cut to TRANSPARENT — in the vector master and in every raster
   * generated from it.
   *
   *   /favicon.ico          16, 32 and 48; the URL a browser asks for
   *                         unprompted, so its absence is silent — the
   *                         catch-all route would answer with the app shell.
   *   /favicon.svg          the master. Chrome, Firefox and Edge scale it to
   *                         any size the surface asks for.
   *   /favicon-96.png       a raster fallback for Safari, which does not read
   *                         SVG favicons at all.
   *   /apple-touch-icon.png 180, and the ONE member of the set that is square
   *                         and fully opaque: iOS applies its own mask and
   *                         paints anything transparent BLACK underneath, so
   *                         cutting the corners here would put black in them.
   *
   * `sizes: "32x32"` on the .ico rather than "any" is deliberate — with "any"
   * a browser treats it as an equal candidate to the vector and may take it.
   */
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-96.png", type: "image/png", sizes: "96x96" },
    ],
    shortcut: "/favicon.ico",
    apple: { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
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
