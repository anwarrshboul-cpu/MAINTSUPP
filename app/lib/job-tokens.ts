import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { getDb } from "../../db";
import { jobAccessTokens } from "../../db/schema";

type Database = Awaited<ReturnType<typeof getDb>>;

export type EvidenceKind = "issue" | "completion" | "nameplate" | "general";

/** What `attachments.kind` is physically able to hold — see `AttachmentKind`. */
export type StorageKind = "issue" | "completion" | "general";

/**
 * The grant vocabulary is not the storage vocabulary.
 *
 * A link is issued in the words a coordinator thinks in — "completion photo",
 * "nameplate" — but `attachments.kind` only has three values, and "nameplate"
 * is not one of them. `/api/files` coerces an unknown kind to `"issue"` and
 * then checks the *coerced* value against the link's grant, so a link granting
 * `["completion","nameplate"]` answered every nameplate upload
 * "This link cannot upload issue evidence." Proven against the running server
 * before this map existed: `kind=nameplate` → 403.
 *
 * Translating once, here, keeps both vocabularies honest: `evidenceSlots` is
 * what the shared page offers, `allowedKinds` is what may actually be written,
 * and the page uploads the storage kind it was told to.
 */
const STORAGE_KIND: Record<EvidenceKind, StorageKind> = {
  issue: "issue",
  completion: "completion",
  // A model plate is a general attachment. It earns its own slot on the page
  // because a contractor needs telling why it matters, not its own row shape.
  nameplate: "general",
  general: "general",
};

export function storageKindFor(kind: EvidenceKind): StorageKind {
  return STORAGE_KIND[kind] ?? "general";
}

export type TokenScope = {
  id: string;
  requestId: string;
  organisationId: string;
  audience: "reporter" | "contractor";
  label: string | null;
  /** The upload slots the shared page offers, in the words the link was issued in. */
  evidenceSlots: EvidenceKind[];
  /** What `attachments.kind` may be written as. This is what `/api/files` checks. */
  allowedKinds: EvidenceKind[];
  canComment: boolean;
  canRequestCompletion: boolean;
  /** Never true. A shared link must not expose commercial data. */
  canViewCost: false;
  expiresAt: string;
};

/** Default window. Long enough for a job to be scheduled and attended. */
export const DEFAULT_EXPIRY_DAYS = 14;

const VALID_KINDS: EvidenceKind[] = ["issue", "completion", "nameplate", "general"];

export async function hashToken(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generates a 32-byte token.
 *
 * The plaintext is returned exactly once, at creation, and is never stored or
 * logged — only its SHA-256 hash reaches the database. A dump of the tokens
 * table therefore cannot be turned back into working links.
 */
function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sanitiseKinds(input: unknown): EvidenceKind[] {
  if (!Array.isArray(input)) return ["completion", "nameplate"];
  const kinds = input
    .map((value) => String(value))
    .filter((value): value is EvidenceKind =>
      VALID_KINDS.includes(value as EvidenceKind),
    );
  return kinds.length ? kinds : ["completion", "nameplate"];
}

/**
 * The stored grant, or nothing.
 *
 * A bare `JSON.parse` on a column throws on a row written by anything other
 * than this file, and every caller of `resolveJobToken` turns a throw into a
 * 503 — so one malformed row would take the whole shared page down rather than
 * the one link. `sanitiseKinds` already handles "not a list".
 */
function parseKinds(raw: string | null): unknown {
  try {
    return JSON.parse(raw || "[]");
  } catch {
    return [];
  }
}

/** The storage kinds a grant implies, de-duplicated and order-preserving. */
function storageKinds(granted: EvidenceKind[]): EvidenceKind[] {
  const seen = new Set<StorageKind>();
  for (const kind of granted) seen.add(storageKindFor(kind));
  return [...seen];
}

export async function createJobToken(
  db: Database,
  input: {
    organisationId: string;
    requestId: string;
    audience?: "reporter" | "contractor";
    label?: string;
    allowedKinds?: unknown;
    canComment?: boolean;
    canRequestCompletion?: boolean;
    expiryDays?: number;
    createdBy?: string;
  },
): Promise<{ token: string; scope: TokenScope }> {
  const token = generateToken();
  const tokenHash = await hashToken(token);
  const days = Math.min(Math.max(Number(input.expiryDays) || DEFAULT_EXPIRY_DAYS, 1), 90);
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  const allowedKinds = sanitiseKinds(input.allowedKinds);
  const id = `jat_${crypto.randomUUID().replace(/-/g, "")}`;

  await db.insert(jobAccessTokens).values({
    id,
    organisationId: input.organisationId,
    requestId: input.requestId,
    tokenHash,
    audience: input.audience ?? "contractor",
    label: input.label?.trim().slice(0, 80) || null,
    allowedKinds: JSON.stringify(allowedKinds),
    canComment: input.canComment ?? true,
    canRequestCompletion: input.canRequestCompletion ?? true,
    expiresAt,
    createdBy: input.createdBy ?? null,
  });

  return {
    token,
    scope: {
      id,
      requestId: input.requestId,
      organisationId: input.organisationId,
      audience: input.audience ?? "contractor",
      label: input.label ?? null,
      evidenceSlots: allowedKinds,
      allowedKinds: storageKinds(allowedKinds),
      canComment: input.canComment ?? true,
      canRequestCompletion: input.canRequestCompletion ?? true,
      canViewCost: false,
      expiresAt,
    },
  };
}

/**
 * Resolves a token to its scope, or null.
 *
 * Returns null for unknown, expired and revoked tokens alike — the caller
 * cannot tell which, so a stale link cannot be used to probe whether a job
 * exists.
 */
export async function resolveJobToken(
  db: Database,
  token: string,
): Promise<TokenScope | null> {
  if (!token || token.length < 32) return null;
  const tokenHash = await hashToken(token);

  const [row] = await db
    .select()
    .from(jobAccessTokens)
    .where(and(eq(jobAccessTokens.tokenHash, tokenHash), isNull(jobAccessTokens.revokedAt)))
    .limit(1);

  if (!row) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) return null;

  const granted = sanitiseKinds(parseKinds(row.allowedKinds));
  return {
    id: row.id,
    requestId: row.requestId,
    organisationId: row.organisationId,
    audience: row.audience as TokenScope["audience"],
    label: row.label,
    evidenceSlots: granted,
    allowedKinds: storageKinds(granted),
    canComment: row.canComment,
    canRequestCompletion: row.canRequestCompletion,
    canViewCost: false,
    expiresAt: row.expiresAt,
  };
}

/** Records a use. First open is captured separately so it can be reported on. */
export async function recordTokenUse(db: Database, tokenId: string) {
  await db
    .update(jobAccessTokens)
    .set({
      useCount: sql`${jobAccessTokens.useCount} + 1`,
      lastUsedAt: sql`CURRENT_TIMESTAMP`,
      firstOpenedAt: sql`COALESCE(${jobAccessTokens.firstOpenedAt}, CURRENT_TIMESTAMP)`,
    })
    .where(eq(jobAccessTokens.id, tokenId));
}

export async function revokeJobToken(
  db: Database,
  organisationId: string,
  tokenId: string,
) {
  await db
    .update(jobAccessTokens)
    .set({ revokedAt: sql`CURRENT_TIMESTAMP` })
    .where(
      and(
        eq(jobAccessTokens.id, tokenId),
        eq(jobAccessTokens.organisationId, organisationId),
      ),
    );
}

export async function listJobTokens(
  db: Database,
  organisationId: string,
  requestId: string,
) {
  const rows = await db
    .select()
    .from(jobAccessTokens)
    .where(
      and(
        eq(jobAccessTokens.organisationId, organisationId),
        eq(jobAccessTokens.requestId, requestId),
      ),
    )
    .orderBy(desc(jobAccessTokens.createdAt));

  const now = Date.now();
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    audience: row.audience,
    allowedKinds: sanitiseKinds(parseKinds(row.allowedKinds)),
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    firstOpenedAt: row.firstOpenedAt,
    lastUsedAt: row.lastUsedAt,
    useCount: row.useCount,
    state: row.revokedAt
      ? "revoked"
      : new Date(row.expiresAt).getTime() < now
        ? "expired"
        : row.firstOpenedAt
          ? "opened"
          : "sent",
  }));
}

/**
 * What a contractor is allowed to see.
 *
 * Deliberately a whitelist rather than a redaction: adding a column to the
 * jobs table must never silently expose it through a shared link.
 */
export function contractorSafeJob(job: Record<string, unknown>) {
  return {
    reference: job.reference ?? null,
    title: job.title ?? "",
    description: job.description ?? "",
    /*
     * `location` is the store the work is in, as typed on the board — often a
     * different string from the site record's name, and the one the engineer
     * is actually told to attend. A link that names the site but not the
     * location sends somebody to the wrong shopping centre.
     */
    location: job.location ?? null,
    /*
     * `status` and the completion date, so the page shows where the job stands
     * rather than only what it is. Both are operational facts the person doing
     * the work already has; neither is commercial.
     */
    status: job.status ?? null,
    completedAt: job.completedAt ?? null,
    priority: job.priority ?? null,
    tier: job.tier ?? null,
    engineer: job.engineer ?? null,
    category: job.category ?? null,
    requestedAt: job.requestedAt ?? null,
    dueAt: job.dueAt ?? null,
    completionRequestedAt: job.completionRequestedAt ?? null,
    completionRequestedBy: job.completionRequestedBy ?? null,
    // Explicitly excluded: cost, invoice, approvedBy, contractor rates,
    // assignee, other jobs, other sites, internal comments.
  };
}
