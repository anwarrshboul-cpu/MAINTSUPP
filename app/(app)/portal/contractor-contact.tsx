"use client";

/**
 * A CONTRACTOR'S PHONE, WHATSAPP AND EMAIL, AS THINGS YOU CAN ACT ON.
 *
 * MOVED HERE FROM `portal-app.tsx`, WHERE IT WAS DEFINED AND USED ONCE. W06-11
 * replaced the Contractors page's fixed eleven-column table with the shared
 * configurable register, and W06-10 added a contractor profile — so the same
 * three fields now have to be actionable on two surfaces. Two copies of the
 * WhatsApp rule would be two chances to build a `wa.me` link out of a national
 * number, which is the one thing `contact-links.ts` exists to prevent. So the
 * component moved rather than being duplicated, and both surfaces import it.
 *
 * Nothing about its behaviour changed in the move; the notes below are the ones
 * it carried.
 */

import { Icon } from "../../components";
import { telHref, whatsappHref } from "../../lib/contact-links";

/**
 * The WhatsApp mark, filled rather than stroked.
 *
 * Every other glyph on this row is a 1.8px outline, and this one deliberately
 * is not: WhatsApp is a brand a user recognises by its silhouette, and an
 * outlined approximation of it at 14px reads as "some bubble" rather than as
 * "the green one on my phone". Recognition is the whole job here — the row
 * exists so a coordinator can tell at a glance which of two numbers opens
 * WhatsApp — so the real shape wins over set consistency.
 *
 * It takes `currentColor`, so it is the link colour in both themes rather than
 * a hard-coded #25d366 that would fail contrast on the light ground.
 */
function WhatsAppGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      height={size}
      width={size}
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M12.04 2c-5.5 0-9.96 4.46-9.96 9.96 0 1.76.46 3.48 1.34 5L2 22l5.2-1.36a9.9 9.9 0 0 0 4.84 1.24h.01c5.49 0 9.95-4.46 9.95-9.96A9.9 9.9 0 0 0 19.08 4.9 9.9 9.9 0 0 0 12.04 2Zm0 1.85c2.16 0 4.19.84 5.72 2.37a8.05 8.05 0 0 1 2.37 5.74c0 4.47-3.63 8.1-8.1 8.1a8.2 8.2 0 0 1-4.18-1.15l-.3-.18-3.1.81.83-3.02-.2-.31a8.05 8.05 0 0 1-1.25-4.3c0-4.47 3.64-8.1 8.11-8.06Zm-3.5 4.02c-.16 0-.43.06-.66.31-.22.25-.86.84-.86 2.05 0 1.2.88 2.37 1 2.53.13.17 1.72 2.63 4.17 3.69.58.25 1.04.4 1.4.51.58.19 1.11.16 1.53.1.47-.07 1.44-.59 1.64-1.16.2-.57.2-1.06.14-1.16-.06-.1-.22-.16-.47-.28-.24-.13-1.44-.72-1.66-.8-.23-.08-.39-.12-.55.12-.16.25-.63.8-.77.96-.14.17-.29.19-.53.06-.25-.12-1.04-.38-1.97-1.22a7.4 7.4 0 0 1-1.37-1.7c-.14-.25-.01-.38.11-.5.11-.11.25-.29.37-.44.12-.14.16-.24.24-.4.08-.17.04-.31-.02-.44-.06-.12-.55-1.33-.76-1.82-.2-.47-.4-.41-.55-.41h-.47Z" />
    </svg>
  );
}

/**
 * A contractor's phone, WhatsApp and email, as things you can act on.
 *
 * These columns have existed on `contractors` since Stage 0 and the workspace
 * payload has always carried them; nothing rendered either, so the register
 * told you who a contractor was and gave you no way to reach them. On a phone —
 * which is where this is used, standing in a shop — a number you cannot tap is
 * a number you have to memorise and retype.
 *
 * WHY THE HREFS COME FROM contact-links.ts RATHER THAN A TEMPLATE HERE.
 *
 * The old `tel:` was built inline and that was fine, because a dialler is
 * forgiving and the user is standing there watching it. `wa.me` is neither: it
 * addresses people by full international number and answers a national one —
 * `07812 224644`, the shape every number on a van is written in — with "the
 * phone number shared via url is invalid". So a WhatsApp row that always
 * linked would be a button that is broken for most of the register.
 *
 * `whatsappHref` returns null rather than inventing a country code, and null
 * here means PLAIN TEXT, not a hidden row: the number is still readable and
 * still dialable by hand, it simply is not dressed up as an action that would
 * dead-end. The same guard is on the telephone row, for the four-digit
 * extensions that are not numbers anybody can be reached on.
 *
 * The numbers print as stored rather than reformatted: an operator recognises
 * the spacing they typed, and guessing at a national format is how a leading
 * zero goes missing.
 *
 * A contractor with nothing at all is not an error — most rows have no phone
 * yet — so it says so quietly rather than rendering an empty cell that reads
 * as a bug. A contractor with no WhatsApp gets no WhatsApp row at all: a dash
 * there would only make every row in the table taller to say nothing.
 */
export function ContractorContact({
  contractor,
}: {
  contractor: {
    name: string;
    contactName?: string | null;
    email?: string | null;
    phone?: string | null;
    whatsappNumber?: string | null;
  };
}) {
  const phone = (contractor.phone ?? "").trim();
  const email = (contractor.email ?? "").trim();
  const person = (contractor.contactName ?? "").trim();
  const whatsapp = (contractor.whatsappNumber ?? "").trim();

  const dial = telHref(phone);
  const chat = whatsappHref(whatsapp);

  if (!phone && !email && !person && !whatsapp) {
    return <span className="contractor-contact__none">No contact details</span>;
  }

  return (
    <span className="contractor-contact">
      {/* The person leads, because a number nobody has a name for is the
          thing that gets dialled last. */}
      {person && <strong className="contractor-contact__person">{person}</strong>}
      {phone &&
        (dial ? (
          <a
            className="contractor-contact__link"
            href={dial}
            aria-label={`Call ${contractor.name} on ${phone}`}
          >
            <Icon name="phone" size={14} />
            {phone}
          </a>
        ) : (
          /* Too short to be a number anybody answers — an internal extension,
             usually. Shown, because the coordinator may still know what to do
             with it; not linked, because the handset would not. */
          <span className="contractor-contact__plain">
            <Icon name="phone" size={14} />
            {phone}
          </span>
        ))}
      {/* Directly under the telephone row, because the two are read as a pair:
          "this is their number, and this is the one that opens WhatsApp". */}
      {whatsapp &&
        (chat ? (
          <a
            className="contractor-contact__link contractor-contact__link--whatsapp"
            href={chat}
            target="_blank"
            rel="noreferrer"
            aria-label={`Message ${contractor.name} on WhatsApp at ${whatsapp}`}
          >
            <WhatsAppGlyph />
            {whatsapp}
          </a>
        ) : (
          <span
            className="contractor-contact__plain contractor-contact__plain--whatsapp"
            /* The tooltip is for the mouse. It is NOT the accessible answer —
               `title` on a plain span is not reliably announced — which is why
               the same sentence is also in the text below. */
            title="Add the country code to make this a WhatsApp link"
          >
            <WhatsAppGlyph />
            {whatsapp}
            {/*
              * Said out loud, because everything that distinguishes this row
              * from the linked one is visual: no underline, a quieter colour,
              * no pointer. A screen reader would otherwise hear a WhatsApp
              * number and a glyph it cannot see, with nothing to say that
              * activating it does nothing.
              */}
            <span className="visually-hidden">
              {" "}
              — not a WhatsApp link; the country code is missing
            </span>
          </span>
        ))}
      {email && (
        <a
          className="contractor-contact__link"
          href={`mailto:${email}`}
          aria-label={`Email ${contractor.name} at ${email}`}
        >
          <Icon name="inbox" size={14} />
          {email}
        </a>
      )}
    </span>
  );
}
