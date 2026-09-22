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
 * THE MENU IS DATA NOW (decision J). The header's links and the footer's link
 * lists are edited by MAINTSUPP platform staff and arrive as the `navigation`
 * prop, already filtered on the server — hidden links and links to website
 * pages that are not live never reach this file. The rules (safe destinations,
 * the five locked links, the header's width budget) and the built-in lists
 * live in `app/lib/site-navigation.ts`. What stays here is the FRAME: the logo,
 * the utility bar, the header's own three buttons, the contact details and the
 * company line — see `FIXED_CHROME` there.
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
import type { PublicNavigation } from "../../lib/site-navigation";
import { BOOKING_IS_EXTERNAL, BOOKING_URL } from "./content";
import { usePathname } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";

/*
 * THE HEADER'S LINKS ARE NO LONGER A CONSTANT IN THIS FILE.
 *
 * They were `const NAV = [...]` here — six destinations, each a section that
 * exists or the /contractors route. That list is now the BUILT-IN navigation in
 * `app/lib/site-navigation.ts` (same entries, same order, same reasons written
 * beside them), and what this file renders is `navigation.primary`: the stored
 * menu, or that built-in one when nothing is stored or the database cannot
 * answer. A client component cannot be where the server reads its fallback
 * from, which is the whole reason it moved.
 *
 * One list still feeds both bars: the desktop nav and the drawer both render
 * `NAV`, below, so a link cannot be in one and missing from the other.
 */

/** Whether a nav target is a hash on this page rather than another route. */
const isAnchor = (href: string) => href.startsWith("#");

/** Whether a destination is another site — a stored menu link may be one. */
const isOutbound = (href: string) => href.startsWith("https:") || href.startsWith("http:");

/**
 * A section hash, resolved against the page it is being rendered on.
 *
 * This chrome is rendered by the marketing LAYOUT, so every link in it also
 * appears on /contractors, /faqs, /privacy, /terms and /cookies — and every one
 * of those pages was serving a header and a footer whose thirteen section links
 * pointed at sections it does not have. Measured on Production before this
 * change: clicking "Pricing" on /contractors set the URL to
 * /contractors#pricing and left scrollY at 0.
 *
 * On the homepage the hash is returned untouched, so the in-page scroll, the
 * drawer's deferred-hash handler and the smooth-scroll behaviour are all
 * exactly as they were. Anywhere else it becomes a root-relative URL with a
 * hash, which `SectionLink` then routes through next/link like any other page
 * change.
 */
function useSectionHref() {
  const pathname = usePathname();
  const onHomepage = pathname === "/" || pathname === "";
  return (href: string) => (onHomepage || !isAnchor(href) ? href : `/${href}`);
}

/**
 * One link that is an in-page jump on the homepage and a navigation anywhere
 * else, so no caller has to decide which it is.
 *
 * `onAnchorClick` is the drawer's deferred-hash handler: it holds the jump
 * until the body-scroll lock has been released. It is passed ONLY to the
 * in-page case, because there is nothing to defer across a page change —
 * `onNavigate` closes the drawer instead, which is what the drawer's route
 * links already do.
 */
function SectionLink({
  href,
  className,
  children,
  onAnchorClick,
  onNavigate,
  ...rest
}: {
  href: string;
  className?: string;
  children: ReactNode;
  onAnchorClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  onNavigate?: () => void;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick">) {
  const sectionHref = useSectionHref();
  const resolved = sectionHref(href);
  if (isAnchor(resolved)) {
    return (
      <a className={className} href={resolved} onClick={onAnchorClick} {...rest}>
        {children}
      </a>
    );
  }
  /* Another site, from the editable menu: its own tab, no opener, and said
     so to a screen reader. A caller that sets its own `target` (the booking
     button) keeps it, and its accessible name already comes from aria-label. */
  const outbound = isOutbound(resolved) && rest.target === undefined;
  const newTab = outbound ? { target: "_blank", rel: "noopener noreferrer" } : {};
  return (
    <Link className={className} href={resolved} onClick={onNavigate} {...newTab} {...rest}>
      {children}
      {outbound ? <span className="vh"> (opens in a new tab)</span> : null}
    </Link>
  );
}

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
    /* A landmark of its own, named: it sits above the header, outside every
       other landmark, and the phone number and address in it were otherwise
       content a screen reader's landmark list never reaches. Top level, so an
       <aside> here is not the nested-complementary fault. */
    <aside className="utility" aria-label="Contact and quick links">
      <div className="wrap utility__inner">
        <div className="utility__group utility__contact">
          {/*
            "Contact Us" is drawn only on a phone — see `.utility__label` in
            marketing.css. On a wide screen the two links sit alone at the top
            left and read as contact details without being told; on a phone
            they arrive stacked under the fold of a 38px bar, and the label is
            what makes the row scannable in the half-second someone spends
            looking for a number. Rendered always, gated in CSS, so there is no
            hydration branch on a static marketing page.
          */}
          <span className="utility__label">Contact Us</span>
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
          <SectionLink href="#report">
            <Ic d={USER} size="ic--xs" />
            <span>Report a Job</span>
          </SectionLink>
        </div>
      </div>
    </aside>
  );
}

/**
 * The header. `navigation.primary` is the header menu as the server resolved
 * it, and it is rendered twice — the desktop bar and the drawer — from this
 * one list.
 */
export function SiteHeader({ navigation }: { navigation: PublicNavigation }) {
  const NAV = navigation.primary;
  const [stuck, setStuck] = useState(false);
  const [open, setOpen] = useState(false);
  const drawer = useRef<HTMLDivElement>(null);
  const burger = useRef<HTMLButtonElement>(null);
  /*
   * An in-page destination chosen from the drawer, carried across the close.
   *
   * The page is locked with `position: fixed` while the drawer is open, and
   * the lock hands the scroll offset back when it releases. A plain anchor
   * click would scroll to its target first and then have that scroll undone
   * by the release a frame later — so the anchor's default is prevented, the
   * target is noted here, and the release itself performs the jump once the
   * page is scrollable again.
   */
  const pendingHash = useRef<string | null>(null);

  /** Closes the drawer and puts focus back on the button that opened it. */
  const close = () => {
    setOpen(false);
    burger.current?.focus({ preventScroll: true });
  };

  /**
   * A drawer link: close first, then go. Route links (`/portal`) navigate as
   * normal. One handler reading the anchor's own `href`, not a factory called
   * once per link during render — a function that touches a ref must only run
   * from an event (react-hooks/refs).
   */
  const onDrawerLink = (event: MouseEvent<HTMLAnchorElement>) => {
    const href = event.currentTarget.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      event.preventDefault();
      pendingHash.current = href;
    }
    close();
  };

  useEffect(() => {
    const onScroll = () => setStuck((window.pageYOffset || 0) > 60);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Body scroll lock, Escape to close, and a focus trap while the drawer is up.
  useEffect(() => {
    if (!open) return;
    /*
     * The lock takes the body out of flow rather than only hiding overflow:
     * on iOS Safari `overflow: hidden` on the body does not stop a touch-drag
     * or a fling reaching the page behind the drawer, and `position: fixed`
     * does. Fixing the body resets its scroll to 0, so the offset is frozen
     * into `top` and handed back — instantly, because `html` scrolls smoothly
     * and an animated restore would visibly run the length of the page.
     * The scrollbar's width goes into padding so nothing shifts sideways on
     * a desktop browser where the drawer also appears below 1120px.
     */
    const scrollY = window.scrollY;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    const saved = {
      position: document.body.style.position,
      top: document.body.style.top,
      width: document.body.style.width,
      overflow: document.body.style.overflow,
      paddingRight: document.body.style.paddingRight,
    };
    // `document.body` each time, not a local alias: the compiler lint treats
    // an alias taken in the effect as a frozen value and refuses the writes.
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = "100%";
    document.body.style.overflow = "hidden";
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;
    drawer.current?.querySelector<HTMLElement>("a,button")?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
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
      document.body.style.position = saved.position;
      document.body.style.top = saved.top;
      document.body.style.width = saved.width;
      document.body.style.overflow = saved.overflow;
      document.body.style.paddingRight = saved.paddingRight;
      window.scrollTo({ top: scrollY, left: 0, behavior: "instant" as ScrollBehavior });
      document.removeEventListener("keydown", onKey);

      const target = pendingHash.current;
      pendingHash.current = null;
      if (target) {
        const destination = document.querySelector<HTMLElement>(target);
        if (destination) {
          const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
          /* `scrollIntoView` honours the page's `scroll-padding-top`, so the
             section lands below the sticky header exactly as a native anchor
             jump would. */
          destination.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
          window.history.pushState(null, "", target);
        } else {
          window.location.hash = target;
        }
      }
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
              {NAV.map(({ id, href, label }) => (
                <li key={id}>
                  <SectionLink className="nav__link" href={href}>
                    {label}
                  </SectionLink>
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
            <SectionLink className="btn btn--outline btn--sm hdr__report" href="#report">
              Report a Job
            </SectionLink>
            {/*
              ONE NAME, whatever the CSS does.

              Two spans share this link so the label can shorten on a phone, and
              CSS shows exactly one of them at a time — that part was already
              right. What was not: both strings sit in the DOM, so anything
              reading the element's text rather than its rendered boxes sees
              "Book a Portfolio ReviewBook Review", and if the stylesheet ever
              failed to load a reader would get both too.

              `aria-label` fixes the accessible name to one string, and hiding
              both spans from assistive tech means the name can only come from
              there. The visual swap is untouched.
            */}
            {/*
              IT BOOKS, RATHER THAN SCROLLING TO A FORM.

              This button said "Book a Portfolio Review" and jumped to
              `#review`, the enquiry panel — so the one CTA in the chrome, on
              every page, asked somebody who had decided to book a slot to
              write a message instead. It now goes where the hero and the final
              CTA go, `BOOKING_URL`, and opens in a new tab when that leaves
              the site.

              The form is untouched and still sits at `#review` for anyone who
              would rather write; it is simply no longer what this button does.
            */}
            <SectionLink
              className="btn btn--primary btn--sm hdr__cta"
              href={BOOKING_URL}
              target={BOOKING_IS_EXTERNAL ? "_blank" : undefined}
              rel={BOOKING_IS_EXTERNAL ? "noopener noreferrer" : undefined}
              aria-label="Book a Portfolio Review"
            >
              <span className="cta-long" aria-hidden="true">
                Book a Portfolio Review
              </span>
              <span className="cta-short" aria-hidden="true">
                Book Review
              </span>
            </SectionLink>
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
            /* The backdrop: a press on the dark area outside the panel. */
            if (event.target === event.currentTarget) close();
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
              <button type="button" className="drawer__close" aria-label="Close menu" onClick={close}>
                <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <SectionLink
              className="btn btn--primary btn--block"
              href="#report"
              onAnchorClick={onDrawerLink}
              onNavigate={() => setOpen(false)}
            >
              Report a Job
            </SectionLink>
            <Link className="btn btn--ghost btn--block" href="/portal" onClick={() => setOpen(false)}>
              Portal Login
            </Link>
            <nav aria-label="Mobile">
              <ul className="drawer__list">
                {NAV.map(({ id, href, label }) => (
                  <li key={id}>
                    <SectionLink
                      href={href}
                      onAnchorClick={onDrawerLink}
                      onNavigate={() => setOpen(false)}
                    >
                      {label}
                    </SectionLink>
                  </li>
                ))}
              </ul>
            </nav>
            {/* The drawer's copy of the same button, and the same reason. */}
            <SectionLink
              className="btn btn--primary btn--block"
              href={BOOKING_URL}
              target={BOOKING_IS_EXTERNAL ? "_blank" : undefined}
              rel={BOOKING_IS_EXTERNAL ? "noopener noreferrer" : undefined}
              onAnchorClick={onDrawerLink}
              onNavigate={() => setOpen(false)}
            >
              Book a Portfolio Review
            </SectionLink>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The footer. The link columns come in their stored order, then Legal, which
 * the footer draws under the Contact column rather than as a column of its
 * own. A column whose every link is hidden is not drawn as an empty heading.
 */
export function SiteFooter({ navigation }: { navigation: PublicNavigation }) {
  const columns = navigation.footer.filter((group) => group.id !== "legal" && group.links.length > 0);
  const legal = navigation.footer.find((group) => group.id === "legal" && group.links.length > 0);
  return (
    <footer className="ftr">
      {/* The column headings below are <h3>s, which is right under a page's own
          <h2>s and a skipped level on a page that has none (/contractors goes
          h1 → h3). A hidden <h2> naming the footer makes the order valid on
          every page without restyling a single heading. */}
      <h2 className="vh">Site information</h2>
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

        {/*
          THE THREE LINK COLUMNS AND THE LEGAL LIST ARE THE EDITABLE FOOTER.

          Services, Company and Clients are columns here; Legal sits under
          Contact, below. Their entries used to be written out in this file —
          the three V3 sections reachable from here rather than from the nav,
          the two FAQ destinations named so the difference is visible before
          the click, "Join our contractor network" in the footer only — and they
          are now the built-in footer in `app/lib/site-navigation.ts`, with the
          same reasons beside them. Every entry goes through `SectionLink`, so a
          section hash resolves against whichever page the footer is drawn on.
          Privacy, Terms, Cookies, Report a Job and Portal Login are LOCKED
          there: they cannot be removed, hidden or pointed anywhere else.
        */}
        {columns.map((group) => (
          <div key={group.id}>
            <h3>{group.heading}</h3>
            <ul>
              {group.links.map((link) => (
                <li key={link.id}>
                  <SectionLink href={link.href}>{link.label}</SectionLink>
                </li>
              ))}
            </ul>
          </div>
        ))}

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
              notice, so the notice has to be reachable from the page — which is
              why its three links are locked in the editable footer. */}
          {legal ? (
            <>
              <h3 className="ftr__h3--legal">{legal.heading}</h3>
              <ul>
                {legal.links.map((link) => (
                  <li key={link.id}>
                    <SectionLink href={link.href}>{link.label}</SectionLink>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </div>

      {/* `id` so the back-to-top button can find the one line below which
          there is nothing left to cover. See ScrollFurniture. */}
      <div className="wrap ftr__legal" id="ftrLegal">
        {/* The brief gives this line verbatim and it is the one place the legal
            entity is named, so it is reproduced exactly — including the
            registered office, which was missing. */}
        <p>
          MAINTSUPP LTD. Registered in England &amp; Wales,
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
  const totop = useRef<HTMLButtonElement>(null);

  /*
   * WHEN THE BACK-TO-TOP BUTTON EXISTS, AND WHY IT IS NOT A SCROLL PERCENTAGE.
   *
   * It used to appear at `y > 700` and then float over whatever happened to be
   * under it. On a phone every section is one full-width column, so a button
   * fixed to a corner of the viewport eventually crosses everything: measured,
   * it covered up to 41% of the How It Works "Next" button, 43% of the Total
   * Care price in the pricing table, a quarter of the "26+ stores" tier button
   * and up to 31% of the footer links including the published email address.
   * Moving it up or down only changes which of those it eats — the overlap is
   * geometry, not a bad offset.
   *
   * So it is bounded by the page instead of by a number: it appears once its
   * own top edge has come to rest below the top of the footer's legal block,
   * which is the last thing on the page and holds no link and no control. Below
   * that line there is nothing left to cover, so every section above it —
   * How It Works, Pricing, the forms, the footer's own links — is clear of the
   * button because the button does not exist while any of them is under it,
   * not because it happens to sit a few pixels higher.
   *
   * A percentage cannot do this job. The depth at which the footer's links
   * finish varies with the viewport (98.8% at 320px, 99.6% at 1280px, measured)
   * and moves again whenever the page's height changes, which it has twice this
   * week. The element's position is the fact; the percentage is a guess at it.
   *
   * `lane` is how far the button reaches up from the bottom of the viewport —
   * its `bottom` offset plus its height — and it is read from the computed
   * style, not from `getBoundingClientRect`. The hidden state carries a
   * `translateY(10px)` that a rect would include, so the button's measured top
   * would jump 10px the instant it appeared and the test could flip back off
   * again on the same scroll. `bottom` and `offsetHeight` ignore transforms.
   */
  /*
   * THE COOKIE BANNER SITS EXACTLY WHERE THIS BUTTON LIVES.
   *
   * The banner is fixed to the bottom edge at z-index 150 and the button was at
   * 100, so on a first visit the button was 100% obscured on every phone width:
   * its centre and all four corners hit-tested to "Accept all". The z-index
   * clash predates this pass, but bounding the button to the end of the page is
   * what made it fatal — the banner's strip is now the only ground the button
   * ever stands on.
   *
   * So the banner's height is measured and published as `--cookie-lane`, the
   * button is lifted by it, and it is given a z-index above the banner as well.
   * Nothing else has to change: `lane` is read back off the computed `bottom`,
   * so lifting the button automatically pushes back the point at which it is
   * allowed to appear, and it still covers nothing in either state.
   *
   * `choice` is the same store the banner itself renders from, so this effect
   * re-runs when the banner appears after hydration and again when it is
   * dismissed. Watching for the element instead would mean either a mutation
   * observer or trusting that this component's effect runs after its sibling's,
   * which is the kind of ordering that breaks quietly.
   */
  const choice = useSyncExternalStore(cookieStore.subscribe, cookieStore.read, () => "pending");

  /*
   * THE LANE IS WATCHED, NOT TAKEN ONCE.
   *
   * It used to be measured in this effect and again on `resize`, and between
   * those two moments the banner is free to change height — which it does. On
   * the deployed build at 375 and 360 the banner settles at 168px and the lane
   * published 158.75px: 21.25px short, which is exactly one of its own line
   * heights. It is not a font race — the same number comes back with
   * `document.fonts.status === "loaded"` and 1.5s after `fonts.ready` — and a
   * resize corrects it to 180 on the spot, which is what a stale reading looks
   * like. The cost was small (the designed 12px of clearance became 4.75px)
   * but the shape of the bug is not: a fixed element's height was treated as
   * a constant, so anything that reflows the banner after this effect runs —
   * a wrapped line, a rotation, a text-size setting — leaves the lane wrong
   * until something else happens to shake it.
   *
   * So the banner's own box is observed. A `ResizeObserver` fires with the
   * real border box every time it changes, including the first delivery after
   * layout, so the published value is derived from live geometry rather than
   * from one snapshot. `fonts.ready`, `resize` and `orientationchange` are
   * kept as well: they cover the case where the banner is absent and the
   * button's own lane still has to be re-read. No width is special-cased.
   */
  useEffect(() => {
    let lane = 0;
    let dropped = false;
    /**
     * Publishes a banner height as the lane every fixed thing at the bottom of
     * the page is spaced by, then reads the button's own reach back off the
     * computed style — `bottom` plus height, never a rect (see above).
     */
    const publish = (height: number) => {
      /* 12px so the button clears the banner's shadow, not just its box. */
      document.documentElement.style.setProperty(
        "--cookie-lane",
        height > 0 ? `${height + 12}px` : "0px",
      );
      const button = totop.current;
      lane = button
        ? parseFloat(getComputedStyle(button).bottom || "0") + button.offsetHeight
        : 0;
    };
    const measure = () => {
      const banner = document.getElementById("cookie");
      publish(banner ? banner.getBoundingClientRect().height : 0);
    };
    const onScroll = () => {
      const y = window.pageYOffset || document.documentElement.scrollTop || 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(max > 0 ? Math.min(100, (y / max) * 100) : 0);
      /* `y > 0` so a page short enough to show its own footer without being
         scrolled does not offer to scroll you back to a top you never left. */
      const legal = document.getElementById("ftrLegal");
      setShowTop(
        y > 0 && !!legal && legal.getBoundingClientRect().top <= window.innerHeight - lane,
      );
    };
    const settle = () => {
      if (dropped) return;
      measure();
      onScroll();
    };
    settle();

    /* The banner's live box. `entry.target` rather than the entry's own boxes
       so this reads the same border box `measure` does, whatever the browser
       reports. Setting `--cookie-lane` moves the footer's padding and the
       button's offset and nothing about the banner, so there is no loop. */
    const banner = document.getElementById("cookie");
    const observer =
      banner && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver((entries) => {
            if (dropped) return;
            for (const entry of entries) {
              publish(entry.target.getBoundingClientRect().height);
            }
            onScroll();
          })
        : null;
    if (banner && observer) observer.observe(banner);

    /* A banner that is not there cannot be observed, and the button's lane
       still moves when the type it is spaced against finishes loading. */
    if (document.fonts) document.fonts.ready.then(settle, () => {});

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", settle);
    window.addEventListener("orientationchange", settle);
    return () => {
      dropped = true;
      observer?.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", settle);
      window.removeEventListener("orientationchange", settle);
    };
  }, [choice]);

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
        ref={totop}
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
export const cookieStore = {
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
    /* A named region: the notice is fixed to the viewport outside every other
       landmark, so without one its text is content a landmark list never reaches. */
    <div className="cookie is-on" id="cookie" role="region" aria-label="Cookie notice">
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
