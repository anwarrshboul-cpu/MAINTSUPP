"use client";

/**
 * Site chrome — ported from the landing page: utility bar, sticky header,
 * mobile drawer, footer, cookie notice, scroll progress and back-to-top.
 *
 * Behaviour matches the source: the header gains `.is-stuck` past 60px, the
 * progress bar tracks scroll, back-to-top appears past 700px, the drawer traps
 * focus and closes on Escape, and the cookie choice is stored under
 * `mt_cookie`.
 *
 * THREE DELIBERATE DIFFERENCES, all noted inline where they occur:
 *  1. The logo is a link to "/" rather than a `#top` scroll anchor, so it also
 *     works from /faqs, /privacy, /terms and /cookies.
 *  2. The footer carries privacy, terms and cookies links. The lead form asks
 *     people to accept a privacy notice, so that notice has to be reachable.
 *  3. The LinkedIn and X icons are omitted — in the source both point at
 *     `#top`, and a social icon that scrolls you to the top of the page reads
 *     as broken. They go back in as soon as the real profile URLs are known.
 */

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/*
 * Four links, and every one of them lands on a section that exists.
 *
 * The old list pointed at `#trades`, `#packages`, `#calculator`, `#evidence`
 * and `#faq` — five anchors whose sections this rebuild removes. An anchor with
 * no target does not error; it silently does nothing, which is the worst
 * possible behaviour for the top-level navigation of a page.
 *
 * The drawer carried nine of these. It now carries the same four as the
 * desktop bar: a phone menu that lists more destinations than the desktop nav
 * was never a decision anybody made.
 */
const NAV = [
  ["#services", "Services"],
  ["#how", "How It Works"],
  ["#pricing", "Pricing"],
  ["#case-study", "Case Study"],
] as const;

function Ic({ d, size = "ic--sm" }: { d: string; size?: string }) {
  return (
    <svg
      className={`ic ${size}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: d }}
    />
  );
}

const PHONE =
  '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/>';
const MAIL = '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/>';
const LOCK = '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>';
const USER = '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>';
const CLOCK = '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>';

function LogoMark() {
  return (
    <span className="logo__mark" aria-hidden="true">
      <svg viewBox="0 0 40 40" fill="none" aria-hidden="true">
        <path d="M6 33V9l14 15" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M20 24 34 9v24" stroke="#0DA1A9" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function LogoText() {
  return (
    <span className="logo__text">
      <strong>
        MAINT<span className="logo__accent">SUPP</span>
      </strong>
      <em>Maintenance Coordination</em>
    </span>
  );
}

export function UtilityBar() {
  return (
    <div className="utility">
      <div className="wrap utility__inner">
        <div className="utility__group utility__contact">
          <a href="tel:+447852224644">
            <Ic d={PHONE} size="ic--xs" />
            <span>+44 7852 224644</span>
          </a>
          <a href="mailto:info@maintsupp.com">
            <Ic d={MAIL} size="ic--xs" />
            <span>info@maintsupp.com</span>
          </a>
        </div>
        <div className="utility__group">
          {/* One name for one door, in all three places it appears: the
              utility bar, the header and the footer. */}
          <Link href="/portal">
            <Ic d={LOCK} size="ic--xs" />
            <span>Portal Login</span>
          </Link>
          <a href="#report">
            <Ic d={USER} size="ic--xs" />
            <span>Report a Job</span>
          </a>
        </div>
      </div>
    </div>
  );
}

export function SiteHeader() {
  const [stuck, setStuck] = useState(false);
  const [open, setOpen] = useState(false);
  const drawer = useRef<HTMLDivElement>(null);
  const burger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onScroll = () => setStuck((window.pageYOffset || 0) > 60);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Body scroll lock, Escape to close, and a focus trap while the drawer is up.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    drawer.current?.querySelector<HTMLElement>("a,button")?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        burger.current?.focus();
        return;
      }
      if (event.key !== "Tab" || !drawer.current) return;
      const focusable = Array.from(
        drawer.current.querySelectorAll<HTMLElement>("a[href],button:not([disabled])"),
      ).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <header className={`hdr${stuck ? " is-stuck" : ""}`} id="hdr">
        <div className="wrap hdr__inner">
          {/* A link to "/" rather than the source's `#top` anchor: this header
              is shared with the legal pages, where scrolling to the top of the
              current page is not what "go home" should do. */}
          <Link className="logo" href="/" aria-label="MAINTSUPP home">
            <LogoMark />
            <LogoText />
          </Link>

          <nav className="nav" aria-label="Primary">
            <ul className="nav__list">
              {NAV.map(([href, label]) => (
                <li key={href}>
                  <a className="nav__link" href={href}>
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="hdr__actions">
            {/*
              "Portal Login", not "Client Login".

              Clients, contractors and the Maintsupp team all sign in through
              the same door, so naming it after one of the three tells the other
              two it is not for them.
            */}
            <Link className="nav__link hdr__login" href="/portal">
              Portal Login
            </Link>
            <a className="btn btn--outline btn--sm hdr__report" href="#report">
              Report a Job
            </a>
            <a className="btn btn--primary btn--sm hdr__cta" href="#review">
              <span className="cta-long">Book a Portfolio Review</span>
              <span className="cta-short">Book Review</span>
            </a>
            <button
              ref={burger}
              type="button"
              className="burger"
              aria-expanded={open}
              aria-controls="drawer"
              aria-label="Open menu"
              onClick={() => setOpen(true)}
            >
              <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                <path d="M3 6h18M3 12h18M3 18h18" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {open && (
        <div
          className="drawer is-open"
          id="drawer"
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div className="drawer__panel" role="dialog" aria-modal="true" aria-label="Menu" ref={drawer}>
            <div className="drawer__top">
              {/* A link, not a span: the brief asks that the logo return you
                  to the top of the landing page wherever it appears. */}
              <Link className="logo" href="/" aria-label="MAINTSUPP home" onClick={() => setOpen(false)}>
                <LogoMark />
                <LogoText />
              </Link>
              <button type="button" className="drawer__close" aria-label="Close menu" onClick={() => setOpen(false)}>
                <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <a className="btn btn--primary btn--block" href="#report" onClick={() => setOpen(false)}>
              Report a Job
            </a>
            <Link className="btn btn--ghost btn--block" href="/portal" onClick={() => setOpen(false)}>
              Portal Login
            </Link>
            <nav aria-label="Mobile">
              <ul className="drawer__list">
                {NAV.map(([href, label]) => (
                  <li key={href}>
                    <a href={href} onClick={() => setOpen(false)}>
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            <a className="btn btn--primary btn--block" href="#review" onClick={() => setOpen(false)}>
              Book a Portfolio Review
            </a>
          </div>
        </div>
      )}
    </>
  );
}

export function SiteFooter() {
  return (
    <footer className="ftr">
      <div className="wrap ftr__grid">
        <div className="ftr__brand">
          <Link className="logo logo--light" href="/" aria-label="MAINTSUPP home">
            <LogoMark />
            <LogoText />
          </Link>
          <p>
            One accountable point of contact for reactive repairs, planned maintenance and
            compliance across your portfolio.
          </p>
          <div className="ftr__social">
            {/* LinkedIn and X are omitted until real profile URLs exist — in the
                source both point at `#top`. */}
            <a href="mailto:info@maintsupp.com" aria-label="Email Maintsupp">
              <Ic d={MAIL} />
            </a>
          </div>
        </div>

        <div>
          <h3>Services</h3>
          <ul>
            <li><a href="#services">Reactive Maintenance</a></li>
            <li><a href="#services">Planned Maintenance</a></li>
            <li><a href="#services">Compliance Coordination</a></li>
            <li><a href="#services">Projects &amp; Store Works</a></li>
          </ul>
        </div>

        <div>
          <h3>Company</h3>
          <ul>
            <li><a href="#how">How It Works</a></li>
            <li><a href="#pricing">Pricing</a></li>
            <li><a href="#case-study">Case Study</a></li>
            <li><a href="#sectors">Who We Help</a></li>
            <li><a href="#review">Contact</a></li>
          </ul>
        </div>

        <div>
          <h3>Clients</h3>
          <ul>
            <li><a href="#report">Report a Job</a></li>
            {/* Same door, same name as the header and the utility bar. */}
            <li><Link href="/portal">Portal Login</Link></li>
            <li><Link href="/faqs">FAQs</Link></li>
            <li><a href="#portal">The software</a></li>
          </ul>
        </div>

        <div>
          <h3>Contact</h3>
          <ul>
            <li>
              <a href="tel:+447852224644"><Ic d={PHONE} />+44 7852 224644</a>
            </li>
            <li>
              <a href="mailto:info@maintsupp.com"><Ic d={MAIL} />info@maintsupp.com</a>
            </li>
            <li>
              <span className="ftr__hours"><Ic d={CLOCK} />Mon – Fri: 8:30am – 5:30pm</span>
            </li>
          </ul>
          {/* Not in the source. The lead form asks people to accept a privacy
              notice, so the notice has to be reachable from the page. */}
          <h3 className="ftr__h3--legal">Legal</h3>
          <ul>
            <li><Link href="/privacy">Privacy notice</Link></li>
            <li><Link href="/terms">Terms</Link></li>
            <li><Link href="/cookies">Cookies</Link></li>
          </ul>
        </div>
      </div>

      <div className="wrap ftr__legal">
        {/* The brief gives this line verbatim and it is the one place the legal
            entity is named, so it is reproduced exactly — including the
            registered office, which was missing. */}
        <p>
          Maintsupp is a trading name of Maintauk Ltd. Registered in England &amp; Wales,
          company no. 17262302. Registered office: C/O MJR Accounting &amp; Tax Services
          Limited, 37th Floor, One Canada Square, London, E14 5AA.
        </p>
        <p>
          Technical inspection, testing and certification are carried out by competent
          certified providers.
        </p>
        <p>© {new Date().getFullYear()} Maintsupp. All rights reserved.</p>
      </div>
    </footer>
  );
}

/** Scroll progress bar and back-to-top button. */
export function ScrollFurniture() {
  const [progress, setProgress] = useState(0);
  const [showTop, setShowTop] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      const y = window.pageYOffset || document.documentElement.scrollTop || 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(max > 0 ? Math.min(100, (y / max) * 100) : 0);
      setShowTop(y > 700);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const toTop = () => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  };

  return (
    <>
      <div className="progress" aria-hidden="true">
        <div className="progress__bar" style={{ width: `${progress}%` }} />
      </div>
      <button
        type="button"
        className={`totop${showTop ? " is-on" : ""}`}
        aria-label="Back to top"
        onClick={toTop}
      >
        <Ic d='<path d="M12 19V5M5 12l7-7 7 7"/>' />
      </button>
    </>
  );
}

/**
 * The stored cookie choice, read through `useSyncExternalStore`.
 *
 * localStorage is not available while server-rendering, so the server snapshot
 * is `"pending"` and the banner renders nothing on the first pass. Reading it
 * in an effect instead would mean a setState on every mount and a visible flash
 * of the banner for people who already answered.
 */
const cookieStore = {
  listeners: new Set<() => void>(),
  subscribe(listener: () => void) {
    cookieStore.listeners.add(listener);
    return () => cookieStore.listeners.delete(listener);
  },
  read() {
    try {
      return window.localStorage.getItem("mt_cookie") ?? "none";
    } catch {
      // Private browsing can refuse storage. Treat it as already answered.
      return "unavailable";
    }
  },
  write(choice: "accept" | "reject") {
    try {
      window.localStorage.setItem("mt_cookie", choice);
      window.localStorage.setItem("mt_cookie_at", new Date().toISOString());
    } catch {
      // The choice still applies for this visit.
    }
    cookieStore.listeners.forEach((listener) => listener());
  },
};

export function CookieNotice() {
  const choice = useSyncExternalStore(
    cookieStore.subscribe,
    cookieStore.read,
    () => "pending",
  );

  if (choice !== "none") return null;
  const choose = cookieStore.write;

  return (
    <div className="cookie is-on" id="cookie">
      <div className="wrap cookie__inner">
        <p>
          <strong>Cookies.</strong> We use essential cookies only unless you accept analytics. No
          ticket text, site addresses or form content is ever sent to analytics. See our{" "}
          <Link href="/cookies">cookie notice</Link>.
        </p>
        <div className="cookie__act">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => choose("reject")}>
            Reject non-essential
          </button>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => choose("accept")}>
            Accept all
          </button>
        </div>
      </div>
    </div>
  );
}
