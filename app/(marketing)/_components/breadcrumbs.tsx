import Link from "next/link";
import { breadcrumbData, jsonLd, type BreadcrumbItem } from "./structured-data";

/**
 * Server-rendered navigation: no hydration or extra client bundle is needed.
 * Pass the real hierarchy when nested pages launch; do not derive display
 * names from slugs or link to planned pages that do not exist yet.
 */
export function Breadcrumbs({ items }: { items: readonly BreadcrumbItem[] }) {
  return (
    <>
      <nav className="m-breadcrumbs" aria-label="Breadcrumb">
        <ol>
          {items.map((item, index) => (
            <li key={item.path}>
              {index > 0 && <span className="m-breadcrumbs__separator" aria-hidden="true">/</span>}
              {index === items.length - 1 ? (
                <span aria-current="page">{item.name}</span>
              ) : (
                <Link href={item.path}>{item.name}</Link>
              )}
            </li>
          ))}
        </ol>
      </nav>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(breadcrumbData(items)) }}
      />
    </>
  );
}
