/**
 * How a CMS block becomes markup.
 *
 * A SERVER COMPONENT, AND THAT IS NOT INCIDENTAL. Nothing here is interactive, so
 * nothing here is "use client" — which also means a block cannot accidentally
 * become a place that reads the database from a browser. The page fetches once, on
 * the server, and hands these plain data.
 *
 * WHY THIS IS NOT IN `_sections/`.
 *
 * Two of that directory's tests are exact-set assertions over its contents:
 * `tests/stage-twelve-images.test.mjs` deep-equals the list of files that render a
 * photograph, and `tests/stage-eleven-marketing.test.mjs` fails any file but
 * `workflow.tsx` that names three of the five workflow stages. A CMS block library
 * added there would break the first the day it renders an image and the second the
 * day somebody writes a workflow stage into a page. Those are the homepage's tests
 * and this is not the homepage, so this lives beside it rather than inside it.
 *
 * The leading underscore keeps the directory out of the route tree, the same way
 * `_sections/` is kept out.
 *
 * WHY IT REUSES THE MARKETING STYLESHEET INSTEAD OF BRINGING ITS OWN.
 *
 * `.m-section`, `.m-shell`, `.m-prose`, `.m-eyebrow`, `.m-card` and `.btn--primary`
 * already exist and already describe this site. A CMS page built on them looks like
 * MAINTSUPP; one built on a parallel set would look like a page somebody bolted on,
 * and it would also cost media queries the marketing stylesheet cannot spare — four
 * separate tests cap its distinct breakpoint count, the tightest at 28 against 23
 * in use. Every class below either already existed or is a `cms-` class that adds
 * spacing only and declares no breakpoint at all.
 *
 * ESCAPING IS REACT'S JOB HERE, DELIBERATELY. Every stored value below reaches the
 * DOM as a text child or as a plain attribute value, so React escapes it. There is
 * no `dangerouslySetInnerHTML` on this path and a test asserts its absence.
 * `app/lib/cms-blocks.ts` therefore validates SHAPE, not safety — with one
 * exception, the `href`, which is the only field a browser acts on rather than
 * displays.
 */

import type { CmsBlock } from "../../lib/cms-repository.ts";

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function asPairs(value: unknown): Array<{ question: string; answer: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ question: string; answer: string }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const question = asText(record.question);
    const answer = asText(record.answer);
    if (question && answer) out.push({ question, answer });
  }
  return out;
}

/*
 * Every renderer narrows the body AGAIN, even though the write path validated it
 * and `readBlockBody` validated it on the way out of storage. That is not
 * belt-and-braces for its own sake: these functions are the last thing between a
 * stored row and a public page, a row can predate any catalogue change, and a
 * renderer that indexes a field which turned out to be absent throws during render
 * — which on a public URL is a 500 where a missing paragraph would have done.
 *
 * A block with nothing left to show returns null, so it occupies no space at all.
 */

function Heading({ body }: { body: CmsBlock["body"] }) {
  const title = asText(body.title);
  if (!title) return null;
  const eyebrow = asText(body.eyebrow);
  const lead = asText(body.lead);
  return (
    <div className="cms-block cms-block--heading">
      {eyebrow ? <p className="m-eyebrow">{eyebrow}</p> : null}
      <h2>{title}</h2>
      {lead ? <p className="m-lead">{lead}</p> : null}
    </div>
  );
}

function RichText({ body }: { body: CmsBlock["body"] }) {
  const paragraphs = asList(body.paragraphs);
  if (!paragraphs.length) return null;
  return (
    <div className="cms-block cms-block--text m-prose">
      {paragraphs.map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </div>
  );
}

function Bullets({ body }: { body: CmsBlock["body"] }) {
  const items = asList(body.items);
  if (!items.length) return null;
  const title = asText(body.title);
  return (
    <div className="cms-block cms-block--bullets">
      {title ? <h3>{title}</h3> : null}
      <ul className="cms-list">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The one block with a link, and the one place the href restriction earns itself.
 *
 * `target` and `rel` are set only for an off-site address. An internal path opens
 * in the same tab, because that is what a visitor expects of a link to another page
 * of the site they are already on.
 */
function Cta({ body }: { body: CmsBlock["body"] }) {
  const title = asText(body.title);
  const label = asText(body.buttonLabel);
  const href = asText(body.buttonHref);
  if (!title || !label || !href) return null;
  const external = !href.startsWith("/");
  const copy = asText(body.body);
  return (
    <div className="cms-block cms-block--cta">
      <h3>{title}</h3>
      {copy ? <p>{copy}</p> : null}
      <a
        className="btn btn--primary"
        href={href}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {label}
      </a>
    </div>
  );
}

/**
 * Questions and answers, as a definition list rather than a details/summary
 * accordion.
 *
 * A definition list is the right element for a pair and it reads correctly with no
 * script at all. It also keeps this off the homepage's ground: `/faqs` owns the
 * site's `FAQPage` structured data, and `tests/stage-eleven-marketing.test.mjs`
 * enforces that only one page claims it — so a CMS page renders the questions and
 * deliberately declares no schema for them.
 */
function Questions({ body }: { body: CmsBlock["body"] }) {
  const pairs = asPairs(body.pairs);
  if (!pairs.length) return null;
  const title = asText(body.title);
  return (
    <div className="cms-block cms-block--faq">
      {title ? <h3>{title}</h3> : null}
      <dl className="cms-faq">
        {pairs.map((pair, index) => (
          <div className="cms-faq__pair" key={index}>
            <dt>{pair.question}</dt>
            <dd>{pair.answer}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * One block, dispatched by kind.
 *
 * An unknown kind renders NOTHING rather than a placeholder or an error. A row
 * whose kind this build no longer knows is history, not a fault, and a visitor is
 * not the person who needs to be told about it.
 */
export function CmsBlockView({ block }: { block: CmsBlock }) {
  switch (block.kind) {
    case "heading":
      return <Heading body={block.body} />;
    case "richText":
      return <RichText body={block.body} />;
    case "bullets":
      return <Bullets body={block.body} />;
    case "cta":
      return <Cta body={block.body} />;
    case "faq":
      return <Questions body={block.body} />;
    default:
      return null;
  }
}

export function CmsBlocks({ blocks }: { blocks: readonly CmsBlock[] }) {
  return (
    <>
      {blocks.map((block) => (
        <CmsBlockView block={block} key={block.id} />
      ))}
    </>
  );
}
