/**
 * WHO a reminder reaches. Resolved at send time, de-duplicated, never guessed.
 *
 * ── WHY GROUPS ARE KEYS AND NOT COPIES ─────────────────────────────────────
 *
 * `reminder_recipients` stores one of three things per row: a `user_id`, a
 * literal `email`, or a `group_key`. The third is the one that needs defending,
 * because the obvious implementation is to expand "All admins" into the four
 * admins who exist when the certificate is saved and store those.
 *
 * That is wrong in the way that only shows up months later. A cascade written
 * in January is read by the cron in December, and by December an admin has
 * left, another has joined, and the renewal owner has changed twice. A copied
 * list is a snapshot of a staff structure that has silently stopped being true,
 * and the failure mode is the worst available: the email sends, the log says it
 * sent, and nobody who needed it received it.
 *
 * So a group is stored as a KEY and expanded here, against a context the caller
 * assembles from live data at the moment of sending. §6 says so in one line —
 * "resolved at send time rather than at save time so staff changes don't break
 * old records" — and this file is that line.
 *
 * ── DE-DUPLICATION IS AN ACCEPTANCE CRITERION, AND IT IS CASE-INSENSITIVE ──
 *
 * "The same address must never receive two copies of one reminder." That is not
 * a tidiness preference. The 14-day step's default recipients are "all of the
 * above plus the escalation contact", and the renewal owner is frequently also
 * the escalation contact and also on the internal team — three routes to one
 * mailbox. Two identical emails about a lapsing certificate teaches the reader
 * that this system repeats itself, which is exactly how the next one gets
 * ignored.
 *
 * The domain half of an address is case-insensitive by RFC and the local half
 * is case-insensitive at every mail provider anyone here uses, so
 * `Foo@Example.com` and `foo@example.com` are ONE recipient. Comparing the raw
 * strings would let a free-typed address slip past a picked one.
 *
 * Everything here is pure: no database, no directory lookup, no clock. The
 * caller does the querying and hands the results in.
 */

/**
 * The dynamic groups, as stored in `reminder_recipients.group_key` and in
 * `reminder_defaults.recipient_groups_json`.
 *
 * The first six are §6's list for certificates; the last two are Module 2 §8's
 * job ladder, which the spec is emphatic must use "the same reminder row
 * structure … one engine, not two". Keeping them in one vocabulary is what
 * makes that true rather than merely stated.
 */
export const DYNAMIC_GROUP_KEYS = [
  "all-admins",
  "internal-team",
  "renewal-owner",
  "escalation-contact",
  "site-contact",
  "client-contact",
  "assigned-engineer",
  "job-owner",
] as const;

export type DynamicGroupKey = (typeof DYNAMIC_GROUP_KEYS)[number];

export interface DynamicGroupDefinition {
  key: DynamicGroupKey;
  label: string;
  description: string;
}

/**
 * One wording per group, here rather than in the picker, because the same
 * phrase has to appear in the recipient chip, in the reminder preview panel and
 * in the activity log entry that records who a reminder went to. Three
 * renderers agreeing is only possible if there is one string.
 */
export const DYNAMIC_GROUPS: readonly DynamicGroupDefinition[] = [
  {
    key: "all-admins",
    label: "All admins",
    description: "Everyone holding an admin role when the reminder sends.",
  },
  {
    key: "internal-team",
    label: "Internal team",
    description: "Internal staff on the record's organisation.",
  },
  {
    key: "renewal-owner",
    label: "Renewal owner",
    description: "The person accountable for booking the renewal.",
  },
  {
    key: "escalation-contact",
    label: "Escalation contact",
    description: "Chosen per record; used by the 14-day and overdue steps.",
  },
  {
    key: "site-contact",
    label: "Site contact",
    description: "The contact held against the store or site.",
  },
  {
    key: "client-contact",
    label: "Client contact",
    description: "The contact held against the client the site belongs to.",
  },
  {
    key: "assigned-engineer",
    label: "Assigned engineer",
    description: "Whoever is assigned to the job when the reminder sends.",
  },
  {
    key: "job-owner",
    label: "Job owner",
    description: "The internal owner of the job record.",
  },
];

const GROUP_LABELS = new Map<DynamicGroupKey, string>(
  DYNAMIC_GROUPS.map((group) => [group.key, group.label]),
);

/** The group's display name, or the raw key when a later version invents one. */
export function dynamicGroupLabel(key: string): string {
  const normalised = normaliseGroupKey(key);
  return (normalised && GROUP_LABELS.get(normalised)) || String(key ?? "");
}

/**
 * A stored group key, in whatever shape it was written.
 *
 * Tolerant on purpose. The spec's default cascade table names the groups in
 * prose — "Renewal owner", "Internal team" — and `reminder_defaults`
 * `recipient_groups_json` is edited by an admin in a text field, so "Renewal
 * Owner", "renewal_owner" and "renewal-owner" all reach this function meaning
 * one thing. Rejecting two of the three would drop recipients from a cascade
 * without saying anything, which is the failure this whole module exists to
 * prevent.
 */
export function normaliseGroupKey(value: unknown): DynamicGroupKey | null {
  if (typeof value !== "string") return null;
  const slug = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return (DYNAMIC_GROUP_KEYS as readonly string[]).includes(slug)
    ? (slug as DynamicGroupKey)
    : null;
}

export function isDynamicGroupKey(value: unknown): value is DynamicGroupKey {
  return normaliseGroupKey(value) !== null;
}

/* ─────────────────────────────────────────────────── address validation ── */

/**
 * Deliberately stricter than "has an @".
 *
 * §9 names a silently dead address as the most likely real-world failure of
 * this whole system, and the cheapest place to catch one is the moment somebody
 * types it. So a domain must carry a dot and a two-letter-or-longer TLD:
 * `ops@maintauk` parses as an address, is accepted by a naive check, and will
 * never deliver.
 *
 * Not RFC 5322. A full grammar accepts quoted local parts and bracketed IP
 * literals that no reminder will ever be sent to, and every extra thing it
 * accepts is another address that fails at Resend instead of in the picker.
 */
const RECIPIENT_EMAIL =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

/**
 * Whether a free-typed address may be saved.
 *
 * §6: "validate format; block save on invalid entries". The UI calls this on
 * the typed string before offering "Add typed@email.com" as a result, and the
 * save route calls it again — the second call is not redundant, because the
 * first one runs in a browser the server does not control.
 */
export function isValidRecipientEmail(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  /* 254 is the SMTP path limit; a longer address is undeliverable by
     definition and is far more likely to be a paste accident. */
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return false;
  if (at > 64) return false;
  return RECIPIENT_EMAIL.test(trimmed);
}

/**
 * The comparison key. Lowercased and trimmed, and this is the ONLY thing two
 * recipients are compared on — see the header.
 */
export function normaliseRecipientEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/* ─────────────────────────────────────────────────────────── resolution ── */

/** A person the context can offer, from any source. */
export interface RecipientPerson {
  userId?: string | null;
  email?: string | null;
  name?: string | null;
}

/** A `reminder_recipients` row, accepted in either the column or the client shape. */
export interface RecipientRow {
  user_id?: string | null;
  email?: string | null;
  group_key?: string | null;
  userId?: string | null;
  groupKey?: string | null;
}

/**
 * Everything the caller looked up. Assembled fresh on every send — that is the
 * point of the whole file.
 *
 * `groups` is a map rather than eight named fields so that a ninth group is a
 * key here and a row in the picker, and not a signature change in three files.
 * A value may be one person or many; a group nobody fills is reported rather
 * than silently empty.
 */
export interface RecipientContext {
  users?: readonly RecipientPerson[];
  groups?: Partial<Record<DynamicGroupKey, RecipientPerson | readonly RecipientPerson[] | null>>;
}

export interface ResolvedRecipient {
  email: string;
  name: string | null;
  userId: string | null;
  /**
   * Every route that led here — `"renewal-owner"`, `"direct"`, `"user"`. Kept
   * because the de-duplication is invisible otherwise: the send log should be
   * able to say the renewal owner was reached once via three routes rather than
   * leaving a reader to wonder why the escalation contact got nothing.
   */
  sources: string[];
}

export interface RecipientPlan {
  recipients: ResolvedRecipient[];
  /** Rows that cannot be delivered to, with the reason, for the admin banner. */
  invalid: Array<{ value: string; reason: string }>;
  /** Group keys that resolved to nobody at all — a real operational hole. */
  emptyGroups: DynamicGroupKey[];
  /** Group keys nothing recognises, kept visible rather than dropped. */
  unknownGroups: string[];
}

function asPeople(
  value: RecipientPerson | readonly RecipientPerson[] | null | undefined,
): RecipientPerson[] {
  if (!value) return [];
  return Array.isArray(value) ? [...value] : [value as RecipientPerson];
}

function rowUserId(row: RecipientRow): string | null {
  const value = row.user_id ?? row.userId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function rowGroupKey(row: RecipientRow): string | null {
  const value = row.group_key ?? row.groupKey;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The full picture: who is reached, who could not be, and which groups are
 * standing empty.
 *
 * `resolveRecipients` returns only the first of those because that is what a
 * sender needs. This returns all four because that is what an operator needs,
 * and the two must be computed together or they will eventually disagree about
 * the same reminder.
 *
 * Row order is preserved, and a group expands in place, so the resulting list
 * reads the way the picker's chips read. A recipient reached twice keeps the
 * position of its FIRST appearance and accumulates the later sources.
 */
export function resolveRecipientPlan(
  rows: readonly RecipientRow[] | null | undefined,
  context: RecipientContext | null | undefined,
): RecipientPlan {
  const byEmail = new Map<string, ResolvedRecipient>();
  const invalid: Array<{ value: string; reason: string }> = [];
  const emptyGroups: DynamicGroupKey[] = [];
  const unknownGroups: string[] = [];

  const usersById = new Map<string, RecipientPerson>();
  for (const user of context?.users ?? []) {
    if (user?.userId) usersById.set(String(user.userId), user);
  }

  const add = (person: RecipientPerson | null | undefined, source: string, label: string) => {
    const raw = typeof person?.email === "string" ? person.email.trim() : "";
    if (!raw) {
      invalid.push({ value: label, reason: "No email address is held for this recipient." });
      return;
    }
    if (!isValidRecipientEmail(raw)) {
      invalid.push({ value: raw, reason: "Not a valid email address." });
      return;
    }
    const key = normaliseRecipientEmail(raw);
    const existing = byEmail.get(key);
    if (existing) {
      /* One mailbox, one copy — the acceptance criterion. The extra route is
         recorded, not delivered to. */
      if (!existing.sources.includes(source)) existing.sources.push(source);
      /* A group expansion often carries a name where a free-typed address does
         not; filling the gap improves the greeting without creating a second
         recipient. */
      if (!existing.name && person?.name) existing.name = String(person.name);
      if (!existing.userId && person?.userId) existing.userId = String(person.userId);
      return;
    }
    byEmail.set(key, {
      /* Stored lowercased: the address that goes to the provider, the address
         in the log and the address the de-duplication compared must be one
         string, or the log stops proving what was sent. */
      email: key,
      name: person?.name ? String(person.name) : null,
      userId: person?.userId ? String(person.userId) : null,
      sources: [source],
    });
  };

  for (const row of rows ?? []) {
    if (!row) continue;

    const groupKey = rowGroupKey(row);
    if (groupKey) {
      const normalised = normaliseGroupKey(groupKey);
      if (!normalised) {
        if (!unknownGroups.includes(groupKey)) unknownGroups.push(groupKey);
        continue;
      }
      const people = asPeople(context?.groups?.[normalised]).map((person) => {
        /* A group may name somebody by id alone — "renewal owner" is a
           `renewal_owner_id` on the certificate. Filling in from `users` here
           means the caller can hand back ids without also joining.
           Field by field rather than by spread: a `{ userId, email: null }`
           entry spread over the looked-up user would ERASE the address it was
           supposed to supply. */
        if (person?.email || !person?.userId) return person;
        const user = usersById.get(String(person.userId));
        if (!user) return person;
        return {
          userId: person.userId,
          email: user.email ?? null,
          name: person.name ?? user.name ?? null,
        };
      });
      if (people.length === 0) {
        if (!emptyGroups.includes(normalised)) emptyGroups.push(normalised);
        continue;
      }
      for (const person of people) add(person, normalised, dynamicGroupLabel(normalised));
      continue;
    }

    const userId = rowUserId(row);
    if (userId) {
      const user = usersById.get(userId);
      if (!user) {
        invalid.push({ value: userId, reason: "No user with this id was supplied." });
        continue;
      }
      add(user, "user", user.name || userId);
      continue;
    }

    const email = typeof row.email === "string" ? row.email.trim() : "";
    if (email) {
      add({ email }, "direct", email);
      continue;
    }

    invalid.push({ value: "", reason: "The row names no user, address or group." });
  }

  return { recipients: [...byEmail.values()], invalid, emptyGroups, unknownGroups };
}

/**
 * The de-duplicated list a send actually goes to.
 *
 * Thin on purpose — the same computation as `resolveRecipientPlan`, so the
 * addresses in the log and the addresses in the admin's "could not deliver"
 * panel can never describe different sends.
 */
export function resolveRecipients(
  rows: readonly RecipientRow[] | null | undefined,
  context: RecipientContext | null | undefined,
): ResolvedRecipient[] {
  return resolveRecipientPlan(rows, context).recipients;
}

/**
 * Whether a set of rows may be SAVED, which is a different question from
 * whether it can be delivered to today.
 *
 * A group that is empty right now is valid to save — it is resolved at send
 * time and somebody may hold the role by then, which is the entire argument for
 * dynamic groups. A malformed address is not, and §6 says the save is blocked
 * on it rather than accepted and dropped later.
 */
export function validateRecipientRows(
  rows: readonly RecipientRow[] | null | undefined,
): { ok: boolean; invalid: Array<{ value: string; reason: string }> } {
  const invalid: Array<{ value: string; reason: string }> = [];
  for (const row of rows ?? []) {
    if (!row) continue;
    const groupKey = rowGroupKey(row);
    if (groupKey) {
      if (!isDynamicGroupKey(groupKey)) {
        invalid.push({ value: groupKey, reason: "Not a recognised recipient group." });
      }
      continue;
    }
    if (rowUserId(row)) continue;
    const email = typeof row.email === "string" ? row.email.trim() : "";
    if (!email) {
      invalid.push({ value: "", reason: "The row names no user, address or group." });
    } else if (!isValidRecipientEmail(email)) {
      invalid.push({ value: email, reason: "Not a valid email address." });
    }
  }
  return { ok: invalid.length === 0, invalid };
}
