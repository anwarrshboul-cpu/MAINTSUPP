"use client";

/**
 * "Raise a ticket" — from wherever you happen to be standing.
 *
 * THE REQUIREMENT
 * ---------------
 * The owner's words: "we want to add option if we want to send a ticket from a
 * different section." Today a job can only be started in two places — the board
 * (Add item) and the public request form — so noticing a problem while looking
 * at a site, an asset, a contractor or a compliance record means leaving that
 * screen, going to the board, and retyping what you were already looking at.
 * Whatever you were looking at is then lost: the new job has no idea it came
 * from that asset or that certificate.
 *
 * This is one control — a button and a dialog — that any screen can drop in
 * with a `context`. It prefills the job from that context, says on screen what
 * it is attaching to, and files the job on the Jobs board.
 *
 * WHY IT POSTS TO /api/maintenance AND NOTHING ELSE
 * -------------------------------------------------
 * Three server paths can already bring a job into existence. A fourth would be
 * the bug this codebase keeps fighting — two creation flows producing rows that
 * disagree — so this adds none, and it picks the one that already means "raise
 * a maintenance job":
 *
 *   POST /api/maintenance       What the portal's own "New maintenance request"
 *                               dialog posts, and what the public /request form
 *                               posts. It is the only path that produces a
 *                               *complete* job: an MN-#### id in the same
 *                               series as everything else, a due date worked
 *                               out from the priority, `nextUpdateAt`, a tier,
 *                               an `activity_log` entry and an alert to the ops
 *                               inbox. Requires location (an exact `sites.name`),
 *                               requester, contact and a description of at least
 *                               ten characters — which is why this dialog asks
 *                               for exactly those and nothing more.
 *
 *   POST /api/board/items       title + siteId, and returns the created row.
 *                               Structurally the nicer API and it takes a real
 *                               `title` rather than deriving one — but it sets
 *                               no `dueAt` and no `nextUpdateAt` and sends no
 *                               alert, so a ticket raised through it is invisible
 *                               to every SLA meter in the product and nobody is
 *                               told it exists. It stays what it is: the board's
 *                               subitem API.
 *
 *   POST /api/board             `action: "create_item"` — the board's inline
 *                               "Add item". A placeholder row: siteId hardcoded
 *                               to "site-unassigned" (not a site that exists),
 *                               location "Choose a location", title "New item".
 *                               Raising a ticket through it would mean creating
 *                               a blank and then PATCHing every field, two
 *                               writes that can half-succeed.
 *
 * The one thing lost by choosing /api/maintenance is that it has no `title`
 * field: `requestTitle()` takes the first sentence of the description. That is
 * how every job raised through the portal today gets its title, so this matches
 * rather than diverges — and the dialog shows the derived title back before you
 * submit, so the rule is visible instead of surprising.
 *
 * THE SITE PREFILL, AND THE DEFECT IT AVOIDS
 * ------------------------------------------
 * 744 of the 775 jobs in this workspace carry `site_id = 'store-aldgate'` with
 * the real store sitting in `location` as free text — "Bullring", "Nottingham",
 * "Merry Hill", none of which are sites in the register. That is what happens
 * when the two fields are filled from different sources.
 *
 * So this control never copies a free-text location into the new row. It
 * resolves the context to a real row in the site register, and writes
 * `location` from *that site's registered name*. `site_id` and `location`
 * therefore agree by construction. When the context cannot be resolved to a
 * real site the picker opens unset and says why, rather than quietly defaulting
 * to Aldgate and adding to the pile.
 *
 * WHO IS OFFERED IT
 * -----------------
 * `board.edit`. The server is the authority — /api/maintenance refuses without
 * it and names the capability in the refusal — but a button that is going to be
 * refused should not be drawn, so the control resolves the caller first and
 * renders nothing if they may not use it. It fails *closed*: if the actor
 * cannot be resolved at all, no button.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../components";
import "./raise-ticket.css";

/* ------------------------------------------------------------------ */
/* The context a section hands over                                    */
/* ------------------------------------------------------------------ */

/**
 * What the calling screen was showing when the button was pressed.
 *
 * Every field is optional. A screen passes what it has; the dialog uses what it
 * can and shows the rest on the ticket so the link back is never lost.
 */
export type RaiseTicketContext = {
  /** A real `sites.id`. Preselected when it exists in the register. */
  siteId?: string | null;
  /** The site's name, used to match the register when no id is given. */
  siteName?: string | null;
  unitId?: string | null;
  unitName?: string | null;
  contractorName?: string | null;
  complianceKind?: string | null;
  documentName?: string | null;
  /** Where the button lives — "Site", "Assets", "Contractors", "Compliance". */
  section?: string | null;
  /** One extra line worth carrying onto the ticket. */
  note?: string | null;
};

/** What the caller gets back once the job exists. */
export type RaisedTicket = {
  id: string;
  reference: string | null;
  title: string;
  siteId: string;
  siteName: string;
  groupId: string | null;
  groupName: string | null;
};

/* ------------------------------------------------------------------ */
/* Who is asking, and what they may pick from                          */
/* ------------------------------------------------------------------ */

type SiteChoice = { id: string; name: string };
type Choice = { value: string; label: string };

type RaiseTicketAccess = {
  actorName: string;
  actorEmail: string;
  role: string;
  /** Whether `board.edit` is held. See the module header. */
  canRaise: boolean;
  sites: SiteChoice[];
  priorities: Choice[];
  categories: Choice[];
  /** The group a new job is filed into, resolved from the board's own stages. */
  group: { id: string; name: string } | null;
};

/**
 * One request per page, however many buttons are on it.
 *
 * A site detail screen can carry a "Raise a ticket" on the header and one per
 * asset row; each mounting its own fetch of /api/context would be a dozen
 * identical round trips. A rejected promise is dropped rather than cached, so a
 * transient failure does not permanently hide every button on the page.
 */
let accessPromise: Promise<RaiseTicketAccess> | null = null;

type ContextPayload = {
  context?: {
    actor?: { displayName?: string; email?: string; role?: string };
    /**
     * Not published today. Read anyway, so the moment /api/context starts
     * returning effective capabilities this control stops guessing from the
     * role and starts using the same answer the server enforces. See the
     * handover note for the four-line patch.
     */
    capabilities?: Record<string, boolean>;
    requestConfiguration?: {
      sites?: Array<{ id: string; name: string }>;
      priorities?: Array<{ value: string; label: string }>;
      categories?: Array<{ value: string; label: string }>;
    };
  };
  error?: string;
};

type GroupsPayload = {
  groups?: Array<{ id: string; name: string; stageKey: string | null }>;
};

async function loadAccess(): Promise<RaiseTicketAccess> {
  const contextResponse = await fetch("/api/context", {
    headers: { accept: "application/json" },
  });
  const contextPayload = (await contextResponse.json().catch(() => ({}))) as ContextPayload;
  if (!contextResponse.ok || !contextPayload.context) {
    throw new Error(contextPayload.error || "The workspace context could not be read.");
  }

  const actor = contextPayload.context.actor ?? {};
  const role = typeof actor.role === "string" ? actor.role : "";
  const capability = contextPayload.context.capabilities?.["board.edit"];
  const configuration = contextPayload.context.requestConfiguration ?? {};

  /*
   * The group a new job will land in — read so the dialog can say it, not so it
   * can set it.
   *
   * `/api/maintenance` writes no board placement. `ensureBoardState` does it on
   * the next board read, filing the row into the group whose `stageKey` matches
   * the job's stage — "Incoming" for a new job. That is the rule this repeats,
   * so what the dialog promises and what the board does come from one source.
   * Best effort: a failure here only costs the group's name in one sentence,
   * which is not worth refusing a ticket over.
   */
  let group: RaiseTicketAccess["group"] = null;
  try {
    const groupsResponse = await fetch("/api/board/groups?board=maintenance", {
      headers: { accept: "application/json" },
    });
    if (groupsResponse.ok) {
      const groupsPayload = (await groupsResponse.json()) as GroupsPayload;
      const groups = groupsPayload.groups ?? [];
      const incoming = groups.find((entry) => entry.stageKey === "Incoming") ?? groups[0];
      if (incoming) group = { id: incoming.id, name: incoming.name };
    }
  } catch {
    // Falls through to `null`. See above.
  }

  return {
    actorName: actor.displayName || actor.email || "Workspace",
    actorEmail: actor.email ?? "",
    role,
    canRaise: typeof capability === "boolean" ? capability : role !== "client" && role !== "",
    sites: (configuration.sites ?? []).map((site) => ({ id: site.id, name: site.name })),
    priorities: (configuration.priorities ?? []).map((item) => ({
      value: item.value,
      label: item.label || item.value,
    })),
    categories: (configuration.categories ?? []).map((item) => ({
      value: item.value,
      label: item.label || item.value,
    })),
    group,
  };
}

function useRaiseTicketAccess() {
  const [access, setAccess] = useState<RaiseTicketAccess | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (!accessPromise) {
      accessPromise = loadAccess();
      accessPromise.catch(() => {
        // Do not cache a failure — the next button to mount retries.
        accessPromise = null;
      });
    }
    void accessPromise
      .then((value) => {
        if (live) setAccess(value);
      })
      .catch((caught: unknown) => {
        if (!live) return;
        setFailure(
          caught instanceof Error ? caught.message : "The workspace context could not be read.",
        );
      });
    return () => {
      live = false;
    };
  }, []);

  return { access, failure };
}

/* ------------------------------------------------------------------ */
/* Resolving the context to a real site                                */
/* ------------------------------------------------------------------ */

type SitePrefill = {
  siteId: string;
  /** Why the picker is set the way it is, said in the dialog. */
  reason: string;
};

/**
 * The context, reduced to a site that actually exists.
 *
 * The interesting case is disagreement. 744 jobs in this workspace store
 * `site_id = 'store-aldgate'` while naming a different store in `location` —
 * "Bullring", "Nottingham", "Merry Hill". A screen showing one of those rows
 * hands over both values, and taking the id on trust would silently raise the
 * new ticket against Aldgate, propagating the defect into fresh data.
 *
 * So when the id and the name point at different places:
 *   - if the name is itself a site in the register, the name wins. It is the
 *     field a human filled in, and the id is the one the import got wrong.
 *   - if the name matches nothing, neither is trustworthy and the picker is
 *     left unset with both values quoted, so the person can see the conflict
 *     rather than discover it on a report three weeks later.
 *
 * The one thing this must never do is guess quietly.
 */
export function resolveSitePrefill(
  context: RaiseTicketContext,
  sites: SiteChoice[],
): SitePrefill {
  const byId = context.siteId ? sites.find((site) => site.id === context.siteId) : undefined;
  const named = (context.siteName ?? "").trim();
  const wanted = named.toLowerCase();
  const byName = wanted
    ? sites.find((site) => site.name.trim().toLowerCase() === wanted)
    : undefined;
  const from = context.section ? context.section.toLowerCase() : "record";

  if (byId && (!named || byName?.id === byId.id)) {
    return { siteId: byId.id, reason: `Taken from the ${from} you were viewing.` };
  }

  if (byId && byName) {
    return {
      siteId: byName.id,
      reason: `That record is stored against ${byId.name} but names “${named}”. “${byName.name}” is the site in the register, so it is selected here — change it if that is wrong.`,
    };
  }

  if (byId) {
    return {
      siteId: "",
      reason: `That record is stored against ${byId.name} but names “${named}”, which is not a site in this workspace. Neither can be trusted, so choose the site this job belongs to.`,
    };
  }

  if (byName) {
    return { siteId: byName.id, reason: `Matched “${named}” to the site register.` };
  }

  const quoted = named || (context.siteId ?? "").trim();
  return {
    siteId: "",
    reason: quoted
      ? `“${quoted}” is not a site in this workspace, so choose the one this job belongs to.`
      : "Choose the site this job belongs to.",
  };
}

/** The one-line summary of everything the ticket is being attached to. */
export function attachmentChips(context: RaiseTicketContext): Array<{ label: string; value: string }> {
  return [
    context.siteName ? { label: "Site", value: context.siteName } : null,
    context.unitName || context.unitId
      ? { label: "Asset", value: context.unitName ?? String(context.unitId) }
      : null,
    context.contractorName ? { label: "Contractor", value: context.contractorName } : null,
    context.complianceKind ? { label: "Compliance", value: context.complianceKind } : null,
    context.documentName ? { label: "Document", value: context.documentName } : null,
  ].filter((entry): entry is { label: string; value: string } => entry !== null);
}

/**
 * The provenance block appended to the ticket's description.
 *
 * `maintenance_requests` has a column for a site and nothing for an asset, a
 * contractor or a certificate, so the only place those can be recorded at
 * creation time is the description. Writing them as prose is not ideal and the
 * dialog says as much on screen rather than pretending the link is structural —
 * a `unit_id` column is the proper fix and is in the handover note.
 */
export function provenanceBlock(context: RaiseTicketContext, siteName: string) {
  const lines = [
    `Site: ${siteName}`,
    context.unitName || context.unitId ? `Asset: ${context.unitName ?? context.unitId}` : null,
    context.contractorName ? `Contractor: ${context.contractorName}` : null,
    context.complianceKind ? `Compliance record: ${context.complianceKind}` : null,
    context.documentName ? `Document: ${context.documentName}` : null,
    context.note ? context.note : null,
  ].filter(Boolean);
  return [`Raised from ${context.section ?? "the portal"}.`, ...lines].join("\n");
}

/**
 * The description as /api/maintenance will receive it.
 *
 * The summary goes first and alone on its line, because the server derives the
 * job's title from the first sentence of this text. Everything after it — the
 * detail, then the provenance — is below the fold of that rule.
 *
 * Capped at 800 to match `trimString(payload.description, 800)` on the route:
 * being truncated server-side without warning is how a provenance block gets
 * silently cut in half, so the same limit is applied here where the character
 * count is on screen.
 */
export function composeDescription(
  summary: string,
  detail: string,
  context: RaiseTicketContext,
  siteName: string,
) {
  return [summary.trim(), detail.trim(), provenanceBlock(context, siteName)]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 800);
}

/**
 * The title the board will show, worked out by the server's own rule.
 *
 * `requestTitle()` in app/api/maintenance/route.ts takes everything up to the
 * first `.`, `!`, `?` or newline and ellipsises past 72 characters. Restating
 * it here is duplication, and deliberate: the alternative is a person typing a
 * two-sentence summary and finding out after the fact that half of it is the
 * title. Shown, not assumed. If the server's rule changes, the Stage 22 test
 * pins the two together.
 */
export function boardTitleFor(summary: string) {
  const firstLine = summary.split(/[.!?\n]/)[0]?.trim() || "Maintenance request";
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}…` : firstLine;
}

/* ------------------------------------------------------------------ */
/* The control                                                         */
/* ------------------------------------------------------------------ */

export function RaiseTicketButton({
  context,
  label = "Raise a ticket",
  variant = "secondary",
  canRaise,
  onRaised,
  onNotify,
  className,
}: {
  context: RaiseTicketContext;
  label?: string;
  variant?: "primary" | "secondary" | "quiet";
  /**
   * Overrides the capability probe when the caller already knows the answer.
   * The server still decides; this only controls whether the button is drawn.
   */
  canRaise?: boolean;
  onRaised?: (ticket: RaisedTicket) => void;
  onNotify?: (message: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const { access, failure } = useRaiseTicketAccess();

  const close = useCallback(() => {
    setOpen(false);
    // Focus goes back where it came from, or the section loses the caret.
    trigger.current?.focus();
  }, []);

  // Fail closed. An unresolved actor is not offered a button that will 403.
  const allowed = canRaise ?? access?.canRaise ?? false;
  if (!allowed) return null;

  const classes = [
    "raise-ticket-button",
    variant === "primary" ? "primary-button" : variant === "quiet" ? "icon-button" : "secondary-button",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <button ref={trigger} type="button" className={classes} onClick={() => setOpen(true)}>
        <Icon name="plus" size={17} />
        <span>{label}</span>
      </button>
      {open && (
        <RaiseTicketDialog
          access={access}
          accessError={failure}
          context={context}
          onClose={close}
          onNotify={onNotify}
          onRaised={onRaised}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* The dialog                                                          */
/* ------------------------------------------------------------------ */

function RaiseTicketDialog({
  access,
  accessError,
  context,
  onClose,
  onNotify,
  onRaised,
}: {
  access: RaiseTicketAccess | null;
  accessError: string | null;
  context: RaiseTicketContext;
  onClose: () => void;
  onNotify?: (message: string) => void;
  onRaised?: (ticket: RaisedTicket) => void;
}) {
  const titleId = useId();
  const firstField = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("Medium");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** `null` until the person picks for themselves; the prefill stands until then. */
  const [chosenSite, setChosenSite] = useState<string | null>(null);
  /*
   * Requester and contact are required by /api/maintenance and start blank in
   * the portal's own dialog. Here they are seeded from the signed-in actor —
   * whoever pressed the button is the person raising it — and stay editable,
   * because a manager raising a job on behalf of a store colleague should be
   * able to put that colleague's number on it.
   */
  const [requester, setRequester] = useState<string | null>(null);
  const [contact, setContact] = useState<string | null>(null);

  const sites = access?.sites ?? [];

  /*
   * The prefill is derived, not stored.
   *
   * The site register arrives asynchronously, so the obvious shape is an effect
   * that sets the field once `access` lands — and that is a cascading render
   * for a value that is a pure function of two things already in hand. Deriving
   * it and letting an explicit choice override it means the field is correct on
   * the very first paint after the register loads, and a person who picks a
   * different site is never overruled by a late-arriving prefill.
   */
  const prefill = access ? resolveSitePrefill(context, access.sites) : null;
  const siteId = chosenSite ?? prefill?.siteId ?? "";
  const prefillReason = chosenSite === null ? (prefill?.reason ?? null) : null;

  useEffect(() => {
    firstField.current?.focus();
  }, [access]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const chips = attachmentChips(context);
  const site = sites.find((entry) => entry.id === siteId) ?? null;
  const requesterValue = requester ?? access?.actorName ?? "";
  const contactValue = contact ?? access?.actorEmail ?? "";
  const bodyText = composeDescription(title, description, context, site?.name ?? "");
  /*
   * Exactly what POST /api/maintenance refuses without — location, requester,
   * contact, and a description of at least ten characters — and nothing more.
   * The description floor is never the binding constraint in practice, because
   * the provenance block alone clears it; it is checked anyway so the button
   * disables rather than the server 400ing.
   */
  const ready =
    Boolean(title.trim()) &&
    Boolean(site) &&
    Boolean(requesterValue.trim()) &&
    Boolean(contactValue.trim()) &&
    bodyText.length >= 10;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || saving || !site) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/maintenance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // The registered name of the site that was actually chosen — never
          // the caller's free text. /api/maintenance resolves `location` back
          // to a `sites` row, so passing anything else is both a 400 and a
          // repeat of the defect this control exists not to repeat.
          location: site.name,
          requester: requesterValue.trim(),
          contact: contactValue.trim(),
          description: bodyText,
          priority,
          ...(category ? { category } : {}),
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        request?: { id: string; reference?: string | null; title: string };
        notified?: boolean;
        error?: string;
      };

      if (!response.ok || !payload.request) {
        /*
         * The refusal the server actually gave, word for word.
         *
         * A missing capability comes back as 'Your role (Client) does not have
         * the "board.edit" permission in this workspace.'; a site that is not in
         * the register comes back as 'Choose a site from this client workspace.'
         * Both name the thing to fix. The fallback names the status rather than
         * saying "something went wrong", so even an empty body is diagnosable.
         */
        throw new Error(
          payload.error ||
            `The ticket could not be raised (HTTP ${response.status}${
              response.statusText ? ` ${response.statusText}` : ""
            }).`,
        );
      }

      const raised: RaisedTicket = {
        id: payload.request.id,
        reference: payload.request.reference ?? null,
        title: payload.request.title,
        siteId: site.id,
        siteName: site.name,
        groupId: access?.group?.id ?? null,
        groupName: access?.group?.name ?? null,
      };

      // The board and every view hanging off it already listen for this, so a
      // ticket raised from a site page appears on the board without a reload.
      window.dispatchEvent(new Event("maintsupp:refresh-board"));
      onRaised?.(raised);
      onNotify?.(
        `${raised.id} raised against ${site.name}${
          raised.groupName ? ` in ${raised.groupName}` : ""
        }. ${
          payload.notified
            ? "The maintenance inbox has been told."
            : "The alert to the maintenance inbox did not send and is queued for replay."
        }`,
      );
      onClose();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The ticket could not be raised.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-wrap raise-ticket-layer">
      <button
        className="modal-scrim"
        type="button"
        aria-label="Close raise a ticket"
        onClick={onClose}
      />
      <form
        className="raise-ticket"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={submit}
      >
        <header className="raise-ticket__top">
          <span className="modal-icon">
            <Icon name="wrench" size={19} />
          </span>
          <div className="raise-ticket__heading">
            <span>New maintenance job</span>
            <h2 id={titleId}>Raise a ticket</h2>
          </div>
          <button
            className="icon-button raise-ticket__close"
            type="button"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="close" size={20} />
          </button>
        </header>

        <div className="raise-ticket__body">
          {chips.length > 0 && (
            <div className="raise-ticket__attaching">
              <span className="raise-ticket__attaching-label">Attaching to</span>
              <ul>
                {chips.map((chip) => (
                  <li key={`${chip.label}:${chip.value}`}>
                    <b>{chip.label}</b>
                    <span>{chip.value}</span>
                  </li>
                ))}
              </ul>
              {chips.length > 1 && (
                <small>
                  Only the site is a field on a job. The rest is written onto the ticket
                  so the trail back to this record survives.
                </small>
              )}
            </div>
          )}

          {accessError && (
            <p className="raise-ticket__error" role="alert">
              {accessError}
            </p>
          )}

          <label className="form-field" htmlFor={`${titleId}-title`}>
            <span>What needs doing</span>
            <input
              id={`${titleId}-title`}
              ref={firstField}
              value={title}
              maxLength={200}
              required
              placeholder="Ceiling tile down over the till point"
              onChange={(event) => setTitle(event.target.value)}
            />
            {title.trim() && boardTitleFor(title) !== title.trim() && (
              <small>
                The board will show this as “{boardTitleFor(title)}” — a job takes its
                title from the first sentence of what you write here.
              </small>
            )}
          </label>

          <label className="form-field" htmlFor={`${titleId}-site`}>
            <span>Site</span>
            <select
              id={`${titleId}-site`}
              value={siteId}
              required
              onChange={(event) => setChosenSite(event.target.value)}
            >
              <option value="">Select a site</option>
              {sites.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
            {prefillReason && <small>{prefillReason}</small>}
          </label>

          <div className="raise-ticket__grid">
            <label className="form-field" htmlFor={`${titleId}-requester`}>
              <span>Raised by</span>
              <input
                id={`${titleId}-requester`}
                value={requesterValue}
                maxLength={120}
                required
                onChange={(event) => setRequester(event.target.value)}
              />
            </label>

            <label className="form-field" htmlFor={`${titleId}-contact`}>
              <span>Contact</span>
              <input
                id={`${titleId}-contact`}
                value={contactValue}
                maxLength={80}
                required
                placeholder="Phone or email"
                onChange={(event) => setContact(event.target.value)}
              />
            </label>
          </div>

          <div className="raise-ticket__grid">
            <label className="form-field" htmlFor={`${titleId}-priority`}>
              <span>Priority</span>
              <select
                id={`${titleId}-priority`}
                value={priority}
                onChange={(event) => setPriority(event.target.value)}
              >
                {(access?.priorities.length
                  ? access.priorities
                  : [
                      { value: "Urgent", label: "Urgent" },
                      { value: "Medium", label: "Medium" },
                      { value: "Low", label: "Low" },
                    ]
                ).map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="form-field" htmlFor={`${titleId}-category`}>
              <span>
                Category <em>optional</em>
              </span>
              <select
                id={`${titleId}-category`}
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                <option value="">Not set</option>
                {access?.categories.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="form-field" htmlFor={`${titleId}-detail`}>
            <span>
              Detail <em>optional</em>
            </span>
            <textarea
              id={`${titleId}-detail`}
              value={description}
              rows={3}
              maxLength={800}
              placeholder="Anything the engineer needs before they arrive…"
              onChange={(event) => setDescription(event.target.value)}
            />
            <small>{bodyText.length}/800 characters, including the record this came from.</small>
          </label>

          <p className="raise-ticket__destination">
            {site
              ? `It will be filed on the Jobs board${
                  access?.group ? ` under ${access.group.name}` : ""
                }, against ${site.name}, waiting for approval — and the maintenance inbox is told.`
              : "Choose a site and this ticket goes onto the Jobs board waiting for approval."}
          </p>
        </div>

        <footer className="raise-ticket__footer">
          {error && (
            <p className="raise-ticket__error" role="alert">
              {error}
            </p>
          )}
          <div className="raise-ticket__actions">
            <button type="button" className="secondary-button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary-button" disabled={!ready || saving}>
              {saving ? "Raising…" : "Raise ticket"}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}
