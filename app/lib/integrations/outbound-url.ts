/**
 * §35b — WHERE THIS PRODUCT IS WILLING TO SEND A REQUEST.
 *
 * An outbound webhook is a server-side request to an address a workspace
 * administrator typed. Unchecked, that is a way to make the portal's own server
 * call things only it can reach: the cloud metadata service at 169.254.169.254,
 * a database on a private network, `localhost`. So an address must pass two
 * gates, and this file is both of them, pure:
 *
 *   1. `checkOutboundUrl` — the URL as written: https, port 443, no username or
 *      password, a real public DNS name (no IP literal, no `localhost`, no
 *      internal-only suffix, no single-label name).
 *   2. `isPublicAddress` — every address that name RESOLVES to, checked at the
 *      moment of connecting (see `outbound-http.ts`), so a name that resolves
 *      to a public address when saved and a private one when used is refused
 *      then too.
 *
 * No relative imports: the tests load this file directly.
 */

export type EndpointKind = "webhook" | "slack";

export type UrlVerdict = { ok: true; url: URL; host: string } | { ok: false; error: string };

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "metadata", "instance-data"]);

function looksLikeIpLiteral(host: string) {
  return /^\d+(\.\d+){0,3}$/.test(host) || host.includes(":") || /^0x[0-9a-f]+$/i.test(host);
}

/** Validates an address as typed. Slack endpoints must be Slack incoming webhooks. */
export function checkOutboundUrl(raw: unknown, kind: EndpointKind): UrlVerdict {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { ok: false, error: "Enter the address to send to." };
  if (text.length > 2000) return { ok: false, error: "That address is too long." };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "That is not a web address." };
  }
  if (url.protocol !== "https:") return { ok: false, error: "The address must start with https://." };
  if (url.username || url.password) return { ok: false, error: "The address must not contain a username or password." };
  if (url.port && url.port !== "443") return { ok: false, error: "Only the standard HTTPS port (443) is allowed." };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (looksLikeIpLiteral(host.replace(/^\[|\]$/g, ""))) {
    return { ok: false, error: "Use the service's domain name, not an IP address." };
  }
  if (!host.includes(".")) return { ok: false, error: "Use a full public domain name." };
  if (BLOCKED_HOSTS.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { ok: false, error: "That address is on a private network, which webhooks cannot reach." };
  }
  if (kind === "slack") {
    if (host !== "hooks.slack.com" || !url.pathname.startsWith("/services/") || url.pathname.split("/").filter(Boolean).length < 4) {
      return { ok: false, error: "A Slack connection needs a Slack incoming-webhook address (https://hooks.slack.com/services/…)." };
    }
  }
  url.hash = "";
  return { ok: true, url, host };
}

function ipv4Parts(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return numbers.every((value) => value >= 0 && value <= 255) ? numbers : null;
}

function publicIpv4([a, b, c]: number[]) {
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64/10 carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, including the metadata service
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // 192.0.0/24, 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false; // multicast and reserved
  return true;
}

/** The eight 16-bit groups of an IPv6 address, or null. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = ipv4Parts(maybeV4);
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    text = text.slice(0, lastColon + 1) + "0:0";
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(":") : []);
  const head = parse(halves[0]);
  const back = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - back.length;
  if (halves.length === 1 && head.length !== 8) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...back].map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN,
  );
  if (groups.length !== 8 || groups.some(Number.isNaN)) return null;
  if (tail.length) groups.splice(6, 2, ...tail);
  return groups;
}

/**
 * True only for a globally routable address. Private, loopback, link-local,
 * carrier-grade NAT, documentation, multicast and reserved ranges are refused,
 * in both families — including an IPv4 address smuggled inside IPv6.
 */
export function isPublicAddress(address: string): boolean {
  const v4 = ipv4Parts(address);
  if (v4) return publicIpv4(v4);
  const groups = ipv6Groups(address);
  if (!groups) return false;
  if (groups.every((group) => group === 0)) return false; // ::
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return false; // ::1
  const embedded = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff];
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) return publicIpv4(embedded); // ::ffff:v4
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) return publicIpv4(embedded); // NAT64
  if (groups.slice(0, 6).every((group) => group === 0)) return false; // deprecated ::v4
  if ((groups[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((groups[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((groups[0] & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return false; // documentation
  if (groups[0] === 0x2002) return publicIpv4([groups[1] >> 8, groups[1] & 0xff, groups[2] >> 8, groups[2] & 0xff]); // 6to4
  return true;
}

/** What a screen shows of an address: its host and a hint of the path, never the path itself. */
export function describeUrl(url: URL) {
  const path = url.pathname.length > 1 ? `/…${url.pathname.slice(-4)}` : "";
  return { host: url.hostname.toLowerCase(), hint: `https://${url.hostname.toLowerCase()}${path}` };
}
