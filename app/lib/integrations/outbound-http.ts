/**
 * §35b — SENDING ONE WEBHOOK, SAFELY.
 *
 * The URL has already passed `checkOutboundUrl`. This is the second gate, at
 * the moment of connecting:
 *
 *   · ON NODE (Vercel, Railway — every deployed runtime) the request goes out
 *     through `node:https` with a `lookup` hook that resolves EVERY address the
 *     name has and refuses the connection if ANY is private. The check and the
 *     connection use the same answer, so a name cannot resolve to a public
 *     address when checked and a private one when connected (DNS rebinding).
 *   · UNDER THE WORKERS RUNTIME (local development only) Node's modules are not
 *     available; `fetch` is used with redirects refused. The platform there
 *     does not route to private networks anyway.
 *
 * Both: redirects are never followed (a 3xx is a failed delivery — following
 * one is the classic way around an address check), a hard timeout, and at most
 * 4 KB of the answer is read. Errors are FIXED PHRASES: a raw network error can
 * carry the URL, and the URL of a Zapier or Slack hook is itself a credential.
 */

import { currentRuntime } from "./posture";
import { isPublicAddress } from "./outbound-url";

export type OutboundRequest = {
  url: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
};

export type OutboundResult = { status: number; excerpt: string } | { error: string };

export type Transport = (request: OutboundRequest) => Promise<OutboundResult>;

const MAX_READ = 4096;

export const TRANSPORT_ERRORS = {
  timeout: "The receiver did not answer in time.",
  private: "Refused: the address resolves to a private network.",
  dns: "The address could not be resolved.",
  connect: "The connection to the receiver failed.",
} as const;

type LookupAddress = { address: string; family: number };

async function sendWithNode(request: OutboundRequest): Promise<OutboundResult> {
  const https = await import("node:https");
  const dns = await import("node:dns");
  const lookup = (
    hostname: string,
    options: { all?: boolean } | number | undefined,
    callback: (error: Error | null, address?: string | LookupAddress[], family?: number) => void,
  ) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error || !addresses?.length) return callback(new Error("dns"));
      if (addresses.some((entry) => !isPublicAddress(entry.address))) return callback(new Error("private"));
      if (typeof options === "object" && options?.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };

  return new Promise<OutboundResult>((resolve) => {
    let settled = false;
    const finish = (result: OutboundResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const outgoing = https.request(
      request.url,
      {
        method: "POST",
        headers: { ...request.headers, "content-length": String(new TextEncoder().encode(request.body).length) },
        lookup: lookup as never,
        agent: false,
        timeout: request.timeoutMs,
      },
      (response) => {
        let excerpt = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (excerpt.length < MAX_READ) excerpt += chunk.slice(0, MAX_READ - excerpt.length);
          if (excerpt.length >= MAX_READ) response.destroy();
        });
        const done = () => finish({ status: response.statusCode ?? 0, excerpt });
        response.on("end", done);
        response.on("close", done);
        response.on("error", done);
      },
    );
    const deadline = setTimeout(() => {
      outgoing.destroy();
      finish({ error: TRANSPORT_ERRORS.timeout });
    }, request.timeoutMs);
    outgoing.on("timeout", () => {
      outgoing.destroy();
      finish({ error: TRANSPORT_ERRORS.timeout });
    });
    outgoing.on("error", (error: Error) => {
      clearTimeout(deadline);
      finish({
        error:
          error.message === "private"
            ? TRANSPORT_ERRORS.private
            : error.message === "dns"
              ? TRANSPORT_ERRORS.dns
              : TRANSPORT_ERRORS.connect,
      });
    });
    outgoing.on("close", () => clearTimeout(deadline));
    outgoing.end(request.body);
  });
}

async function sendWithFetch(request: OutboundRequest): Promise<OutboundResult> {
  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    const text = await response.text().catch(() => "");
    return { status: response.status, excerpt: text.slice(0, MAX_READ) };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { error: name === "TimeoutError" || name === "AbortError" ? TRANSPORT_ERRORS.timeout : TRANSPORT_ERRORS.connect };
  }
}

/** The real transport for this runtime. Tests inject their own. */
export const defaultTransport: Transport = (request) =>
  currentRuntime() === "node" ? sendWithNode(request) : sendWithFetch(request);
