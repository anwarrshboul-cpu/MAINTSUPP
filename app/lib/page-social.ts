import type { Metadata } from "next";

/**
 * A public page's Open Graph and Twitter card, from ITS OWN title,
 * description and path.
 *
 * QA on 2026-10-01 found every subpage (/contractors, /faqs, /privacy, /login,
 * ...) sharing as the HOMEPAGE: `og:url` https://maintsupp.com, the homepage's
 * og:title and description, because only the root layout declared them and a
 * page that declares none inherits them. The homepage itself had no og:image.
 * Every public page now builds all three from this one function, so a shared
 * link always describes the page it points at.
 */
export const SHARE_IMAGE = {
  url: "/assets/photos/hero-london-maintenance.jpg",
  width: 1774,
  height: 887,
  alt: "Commercial maintenance across a London skyline",
} as const;

export const SITE_ORIGIN = "https://maintsupp.com";

export function pageSocial(
  path: string,
  title: string,
  description: string,
): Pick<Metadata, "openGraph" | "twitter"> {
  /* The canonical stays a LITERAL on each page (`alternates: { canonical }`),
     pinned by tests/marketing-canonicals.test.mjs; this supplies the share
     cards that must agree with it. */
  const url = `${SITE_ORIGIN}${path}`;
  /* The page's own BARE title gets the brand the tab title gets from the root
     template; one that already names it (the home and contractor titles) is
     used as it is, so the brand is never said twice. */
  title = /maintsupp/i.test(title) ? title : `${title} | MAINTSUPP`;
  return {
    openGraph: {
      type: "website",
      siteName: "MAINTSUPP",
      locale: "en_GB",
      url,
      title,
      description,
      images: [SHARE_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [SHARE_IMAGE.url],
    },
  };
}
