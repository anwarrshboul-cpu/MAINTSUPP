"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavItem } from "../../../lib/portal";

/**
 * The nav, marked up as a nav.
 *
 * Which links exist is decided on the server from the role — this component
 * only says which one you are on, and that needs the pathname, which is a
 * client hook. `startsWith` rather than equality so `/portal/jobs/:id` keeps
 * the Board tab lit while you are reading a job you opened from it.
 */
export default function PortalNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname() ?? "";

  const isCurrent = (href: string) => {
    if (href === "/portal/dashboard") {
      return pathname.startsWith("/portal/dashboard") || pathname.startsWith("/portal/jobs");
    }
    return pathname.startsWith(href);
  };

  return (
    <nav className="p-nav" aria-label="Portal sections">
      {items.map((item) => {
        const current = isCurrent(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={current ? "is-on" : undefined}
            aria-current={current ? "page" : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
