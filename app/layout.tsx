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
