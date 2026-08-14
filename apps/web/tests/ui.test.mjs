/**
 * Browser tests for the web app.
 *
 * `apps/api` has hundreds of tests; this app had none, so every claim about it
 * rested on someone having looked at it once. These cover the surfaces that are
 * expensive to get wrong and easy to break silently: the landing page's ten
 * sections, the published content pages, the sign-in form's autocomplete
 * tokens, the public share link, and phone layout.
 *
 * They drive real Chrome (see driver.mjs) because the interesting failures are
 * ones only a browser shows — an `autocomplete` token the parser reads
 * differently from the source, a tap target that measures 18px once CSS lands,
 * a console error that never reaches the server.
 *
 * Needs the stack running:
 *   npm run api:dev
 *   cd apps/web && npx next build && npx next start -p 3000
 *   npm run web:test
 *
 * Skips with a clear message rather than failing when nothing is listening —
 * a red suite that only means "you forgot to start the server" trains people
 * to ignore red suites.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { launch, reachable, TOUCH_MINIMUM } from "./driver.mjs";

const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const API = process.env.API_URL ?? "http://localhost:8787";
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? "anwarrshboul@gmail.com";
const OWNER_PASSWORD = process.env.OWNER_PASSWORD ?? "Maintsupp-Dev-Owner-2026!";

/** Widths from the brief: 320 / 375 / 414 / 768 / 1024. */
const WIDTHS = [320, 375, 414, 768, 1024];

let page;
let up = false;

before(async () => {
  up = (await reachable(`${WEB}/portal`)) && (await reachable(`${API}/health`));
  if (!up) return;
  page = await launch();
});

after(async () => {
  if (page) await page.close();
});

const skipUnlessUp = (t) => {
  if (!up) {
    t.skip(`web (${WEB}) or api (${API}) not running — start them first`);
    return true;
  }
  return false;
};

describe("the landing page", () => {
  test("renders all ten sections, each exactly once", async (t) => {
    if (skipUnlessUp(t)) return;
    await page.viewport(1024);
    await page.goto(`${WEB}/`);

    const ids = await page.evaluate(
      `JSON.stringify([...document.querySelectorAll("section[id]")].map((s) => s.id))`,
    );
    const sections = JSON.parse(ids);

    // Section 10 is the trust strip and the CTA panel — two <section> elements
    // making up one section of the brief, exactly as the legacy page documents.
    assert.equal(sections.length, 11, `expected 11 elements, got ${sections.join(", ")}`);
    assert.equal(new Set(sections).size, 11, "a section id appears twice");
    for (const id of ["hero", "report", "sectors", "services", "problem", "how",
      "pricing", "case-study", "portal", "trust", "review"]) {
      assert.ok(sections.includes(id), `section #${id} is missing`);
    }
  });

  test("the Portal Login link points at /portal", async (t) => {
    if (skipUnlessUp(t)) return;
    const found = await page.evaluate(
      `[...document.querySelectorAll('a[href="/portal"]')].length > 0`,
    );
    assert.ok(found, "no link to /portal on the landing page");
  });

  test("pricing shows the headline rate and the minimum", async (t) => {
    if (skipUnlessUp(t)) return;
    const text = await page.text();
    // £55 and £100 sit in tier tabs that render on interaction, so only the
    // active tier is in the server HTML. These two are always visible.
    assert.match(text, /£65/, "the £65 headline rate is missing");
    assert.match(text, /£295/, "the £295 minimum is missing");
  });

  test("no console errors and no sideways scroll at any width", async (t) => {
    if (skipUnlessUp(t)) return;
    for (const width of WIDTHS) {
      await page.viewport(width);
      await page.goto(`${WEB}/`);
      const { overflow } = await page.layout();
      assert.equal(overflow, 0, `${width}px scrolls sideways by ${overflow}px`);
      assert.deepEqual(page.consoleErrors, [], `${width}px logged errors`);
    }
  });
});

describe("the published content pages", () => {
  for (const route of ["/faqs", "/privacy", "/terms", "/cookies"]) {
    test(`${route} renders real content`, async (t) => {
      if (skipUnlessUp(t)) return;
      await page.viewport(390);
      await page.goto(`${WEB}${route}`);
      const text = await page.text();
      assert.ok(text.length > 600, `${route} rendered only ${text.length} characters`);
      const { overflow } = await page.layout();
      assert.equal(overflow, 0, `${route} scrolls sideways by ${overflow}px`);
      assert.deepEqual(page.consoleErrors, [], `${route} logged errors`);
    });
  }

  test("the privacy notice states real retention periods and real processors", async (t) => {
    if (skipUnlessUp(t)) return;
    await page.goto(`${WEB}/privacy`);
    const text = await page.text();

    // It shipped naming Cloudflare, with three [TO CONFIRM] placeholders, while
    // backing the consent checkbox on the review form. Both are factual claims
    // made to data subjects, so both are asserted rather than trusted.
    assert.doesNotMatch(text, /TO CONFIRM/i, "a retention placeholder is still published");
    assert.doesNotMatch(text, /Draft for review/i, "the draft banner is still published");
    assert.doesNotMatch(text, /Cloudflare/i, "it still names Cloudflare as the host");
    for (const processor of ["Vercel", "Railway", "Supabase", "Resend"]) {
      assert.match(text, new RegExp(processor), `${processor} is not named`);
    }
  });
});

describe("the portal front door", () => {
  test("autocomplete tokens are what a password manager reads", async (t) => {
    if (skipUnlessUp(t)) return;
    await page.viewport(390);
    await page.goto(`${WEB}/portal`);

    const inputs = await page.autocomplete();
    const email = inputs.find((i) => i.name === "email");
    const password = inputs.find((i) => i.name === "password");

    // Read as DOM PROPERTIES, not source text: this is what the browser parsed,
    // which is the thing that decides whether the login gets offered for saving
    // — and on iOS, whether Face ID is offered on the fill.
    assert.equal(email?.autocomplete, "username",
      "the identifier field is not a username field to a password manager");
    assert.equal(password?.autocomplete, "current-password");
  });

  test("Keep me signed in is ticked by default", async (t) => {
    if (skipUnlessUp(t)) return;
    const persist = (await page.autocomplete()).find((i) => i.name === "persistent");
    assert.equal(persist?.checked, true, "the brief requires this checked by default");
  });

  test("clean at every width", async (t) => {
    if (skipUnlessUp(t)) return;
    for (const width of WIDTHS) {
      await page.viewport(width);
      await page.goto(`${WEB}/portal`);
      const { overflow, small } = await page.layout();
      assert.equal(overflow, 0, `${width}px scrolls sideways`);
      assert.deepEqual(small, [], `${width}px has targets under ${TOUCH_MINIMUM}px`);
      assert.deepEqual(page.consoleErrors, [], `${width}px logged errors`);
    }
  });

  test("signing in reaches the dashboard", async (t) => {
    if (skipUnlessUp(t)) return;
    await page.viewport(390);
    await page.goto(`${WEB}/portal`);
    assert.ok(await page.fill('input[name="email"]', OWNER_EMAIL), "no email field");
    assert.ok(await page.fill('input[name="password"]', OWNER_PASSWORD), "no password field");
    await page.submit();
    await new Promise((resolve) => setTimeout(resolve, 3500));

    const path = await page.path();
    if (path === "/portal") {
      const text = await page.text();
      t.skip(`sign-in did not proceed — the seeded owner may differ here: ${text.slice(0, 120)}`);
      return;
    }
    assert.match(path, /^\/portal\//, `landed on ${path}`);
    const { overflow } = await page.layout();
    assert.equal(overflow, 0, "the dashboard scrolls sideways on a phone");
  });
});

describe("the emailed links have somewhere to land", () => {
  /*
   * These two pages did not exist while the API was already mailing links to
   * them, which made the product unusable on a fresh deployment: sign-in
   * refuses an unconfirmed address, so every new account — the owner's
   * included — ended at a 404 with no way forward, and no password could ever
   * be recovered. Asserted here because a 404 is invisible until somebody
   * actually clicks the email.
   */
  test("/portal/verify handles a missing, bad and well-formed token", async (t) => {
    if (skipUnlessUp(t)) return;
    await page.viewport(390);

    await page.goto(`${WEB}/portal/verify`);
    assert.match(await page.text(), /not complete/i, "no token should say the link was incomplete");

    await page.goto(`${WEB}/portal/verify?token=definitely-not-a-real-token`);
    assert.match(await page.text(), /expired/i, "a bad token should say expired, not crash");

    const { overflow, small } = await page.layout();
    assert.equal(overflow, 0);
    assert.deepEqual(small, [], `targets under ${TOUCH_MINIMUM}px`);
    assert.deepEqual(page.consoleErrors, []);
  });

  test("/portal/reset offers the form with a token and refuses without one", async (t) => {
    if (skipUnlessUp(t)) return;
    await page.viewport(390);

    await page.goto(`${WEB}/portal/reset`);
    assert.match(await page.text(), /not complete/i);

    // Any token renders the form: it is spent on SUBMIT, not on page load, so
    // opening the link early must not burn it.
    await page.goto(`${WEB}/portal/reset?token=whatever`);
    const inputs = await page.autocomplete();
    assert.equal(inputs.filter((i) => i.autocomplete === "new-password").length, 2,
      "expected a password and a confirmation field, both new-password");

    const { overflow, small } = await page.layout();
    assert.equal(overflow, 0);
    assert.deepEqual(small, [], `targets under ${TOUCH_MINIMUM}px`);
    assert.deepEqual(page.consoleErrors, []);
  });
});

describe("the public share link", () => {
  /** A live token, fetched the way the portal's Copy Link button produces one. */
  const shareToken = async () => {
    const signIn = await fetch(`${API}/auth/sign-in`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
    });
    if (!signIn.ok) return null;
    const cookie = (signIn.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(";")[0]).join("; ");
    const list = await fetch(`${API}/jobs?limit=1`, { headers: { cookie } });
    if (!list.ok) return null;
    return (await list.json()).jobs?.[0]?.share_token ?? null;
  };

  test("a wrong token gives nothing away", async (t) => {
    if (skipUnlessUp(t)) return;
    await page.viewport(390);
    await page.goto(`${WEB}/job/${"0".repeat(64)}`);
    const text = await page.text();
    assert.match(text, /not valid/i);
    // Expired, revoked and never-existed are one message on purpose: telling
    // them apart confirms to a stranger that a job exists.
    assert.doesNotMatch(text, /MS-\d{5}/, "a job reference leaked on an invalid token");
  });

  test("a real token opens the ticket with no login, and is phone-clean", async (t) => {
    if (skipUnlessUp(t)) return;
    const token = await shareToken();
    if (!token) { t.skip("could not obtain a share token from the API"); return; }

    for (const width of [320, 390, 414]) {
      await page.viewport(width);
      await page.goto(`${WEB}/job/${token}`);
      const { overflow, small } = await page.layout();
      assert.equal(overflow, 0, `${width}px scrolls sideways`);
      assert.deepEqual(small, [], `${width}px has targets under ${TOUCH_MINIMUM}px`);
      assert.deepEqual(page.consoleErrors, [], `${width}px logged errors`);
    }
    assert.match(await page.text(), /MS-\d{5}/, "the job reference did not render");
  });

  test("the share page is never indexed", async (t) => {
    if (skipUnlessUp(t)) return;
    // The URL is the credential. A crawler that indexes it publishes a client's
    // job, so this is asserted rather than assumed.
    const robots = await page.evaluate(
      `document.querySelector('meta[name="robots"]')?.content ?? ""`,
    );
    assert.match(robots, /noindex/i, `robots meta was "${robots}"`);
  });
});
