import type { ReactNode } from "react";

/**
 * Public layout — for pages opened by people with no account, on a phone,
 * often on mobile data.
 *
 * Deliberately loads no shared stylesheet. The contractor job page brings its
 * own 4KB of CSS; inheriting the dashboard's 254KB would be absurd for a page
 * whose whole purpose is to work in a service corridor with one bar.
 */
export default function PublicLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
