/**
 * THE WORKSPACE LOGO — reading, adopting and removing it.
 *
 * Both upload paths end here: the single-shot route (`POST /api/branding/logo`,
 * files up to 900 KB) and the parts route (`/api/branding/logo/upload`, the #78
 * direct-upload path, for anything larger). Each has already stored the bytes
 * under a key this server chose and proved them with `inspectLogo`; what is
 * left — naming the new object as the workspace's logo, retiring the old one,
 * and saying so in the audit log — is one function so the two cannot drift.
 *
 * TENANCY. Every read and write names `organisationId` explicitly and the
 * callers pass the `scopedDb` workspace, never a value from the request. The
 * object keys sit under that workspace's own prefix (`logoObjectKey`), and the
 * bytes are served only through `/api/branding/logo/image`, which authorises
 * every request. The bucket stays private.
 */

import { and, eq } from "drizzle-orm";
import { organisationLogos } from "../../db/schema";
import { auditActor, recordAudit } from "./audit";
import { inspectPrintRendition, logoImageUrl, printRenditionKey } from "./organisation-logo-rules";
import type { ScopedDatabase } from "./tenant-db";

type Db = ScopedDatabase["db"];
export type OrganisationLogo = typeof organisationLogos.$inferSelect;

/** The storage calls this module makes — a subset of the R2 binding. */
export interface LogoStorage {
  delete(key: string): Promise<void>;
}

/** The storage read the documents make — a subset of the R2 binding. */
export interface LogoReader {
  get(key: string): Promise<{ body: ReadableStream | null } | null>;
}

/** What the browser is told about a logo. Never the object key. */
export type LogoDescription = {
  id: string;
  url: string;
  contentType: string;
  byteSize: number;
  width: number;
  height: number;
  originalName: string;
  updatedAt: string;
  /** The reports' JPEG copy of THIS logo, or null until the browser has made one. */
  printUrl: string | null;
};

export function describeLogo(row: OrganisationLogo | null): LogoDescription | null {
  if (!row) return null;
  return {
    id: row.logoId,
    url: logoImageUrl(row.logoId),
    contentType: row.contentType,
    byteSize: Number(row.byteSize),
    width: Number(row.width),
    height: Number(row.height),
    originalName: row.originalName,
    updatedAt: row.updatedAt,
    printUrl: row.printWidth && row.printHeight ? logoImageUrl(row.logoId, "print") : null,
  };
}

/**
 * This workspace's logo, or null. A failed read is null as well: a missing
 * logo draws the default mark, and the default mark must never be the reason a
 * page fails to load.
 */
export async function readOrganisationLogo(db: Db, organisationId: string): Promise<OrganisationLogo | null> {
  try {
    return await loadLogoRow(db, organisationId);
  } catch (error) {
    console.error("[organisation-logo] the logo could not be read", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The same read, allowed to FAIL — for the writes. A replace or a removal that
 * could not see the current row must say so, not carry on as if there were none
 * (a removal would report success and change nothing; a replace would orphan
 * the old object).
 */
async function loadLogoRow(db: Db, organisationId: string): Promise<OrganisationLogo | null> {
  const [row] = await db
    .select()
    .from(organisationLogos)
    .where(eq(organisationLogos.organisationId, organisationId))
    .limit(1);
  return row ?? null;
}

/** The URL the browser draws, or null when the workspace has no logo. */
export async function organisationLogoUrl(db: Db, organisationId: string): Promise<string | null> {
  const row = await readOrganisationLogo(db, organisationId);
  return row ? logoImageUrl(row.logoId) : null;
}

type AuditScope = Parameters<typeof auditActor>[0];

/** The objects a logo row owns: the original and the documents' JPEG. */
async function discardObjects(storage: LogoStorage, objectKey: string) {
  await storage.delete(objectKey).catch(() => undefined);
  await storage.delete(printRenditionKey(objectKey)).catch(() => undefined);
}

/**
 * NAME A STORED, PROVEN OBJECT AS THIS WORKSPACE'S LOGO.
 *
 * The row is written first and the previous objects are deleted only once it
 * is: a failure part-way leaves the old logo showing (and at worst an orphaned
 * new object, which the caller deletes), never a row naming bytes that are
 * gone. If the write itself fails the new object is deleted here, so a refused
 * logo leaves nothing behind in the bucket.
 */
export async function adoptOrganisationLogo(input: {
  db: Db;
  storage: LogoStorage;
  organisationId: string;
  logo: {
    logoId: string;
    objectKey: string;
    contentType: string;
    byteSize: number;
    width: number;
    height: number;
    originalName: string;
  };
  scope: AuditScope;
  request: Request;
  multipart: boolean;
}): Promise<OrganisationLogo> {
  const { db, storage, organisationId, logo } = input;
  let previous: OrganisationLogo | null;
  try {
    previous = await loadLogoRow(db, organisationId);
  } catch (error) {
    await discardObjects(storage, logo.objectKey);
    throw error;
  }
  const values = {
    logoId: logo.logoId,
    objectKey: logo.objectKey,
    contentType: logo.contentType,
    byteSize: logo.byteSize,
    width: logo.width,
    height: logo.height,
    originalName: logo.originalName.slice(0, 255),
    /* A new logo has no print copy yet — the one before was drawn from other pixels. */
    printWidth: null,
    printHeight: null,
    uploadedByEmail: input.scope.identityEmail.toLowerCase().slice(0, 200),
    updatedAt: new Date().toISOString(),
  };
  let row: OrganisationLogo | undefined;
  try {
    if (previous) {
      [row] = await db
        .update(organisationLogos)
        .set(values)
        .where(eq(organisationLogos.organisationId, organisationId))
        .returning();
    } else {
      [row] = await db
        .insert(organisationLogos)
        .values({ organisationId, ...values })
        .onConflictDoUpdate({ target: organisationLogos.organisationId, set: values })
        .returning();
    }
  } catch (error) {
    await discardObjects(storage, logo.objectKey);
    throw error;
  }
  if (!row) {
    await discardObjects(storage, logo.objectKey);
    throw new Error("The logo could not be saved.");
  }
  if (previous && previous.objectKey !== logo.objectKey) {
    await discardObjects(storage, previous.objectKey);
  }

  await recordAudit({
    db,
    organisationId,
    actor: auditActor(input.scope),
    action: "theme.logo_changed",
    entityType: "organisation_logo",
    entityId: organisationId,
    summary: previous
      ? `Replaced the workspace logo with ${values.originalName} (${logo.width}×${logo.height}).`
      : `Added a workspace logo, ${values.originalName} (${logo.width}×${logo.height}).`,
    detail: {
      logoId: logo.logoId,
      previousLogoId: previous?.logoId ?? null,
      fileName: values.originalName,
      contentType: logo.contentType,
      byteSize: logo.byteSize,
      width: logo.width,
      height: logo.height,
      multipart: input.multipart,
    },
    request: input.request,
  });
  return row;
}

/**
 * REMOVE THE LOGO — the workspace goes back to the default mark. The row goes
 * first, then the objects, for the same reason as above. Removing a logo that
 * is not there changes nothing and records nothing.
 */
export async function removeOrganisationLogo(input: {
  db: Db;
  storage: LogoStorage;
  organisationId: string;
  scope: AuditScope;
  request: Request;
}): Promise<boolean> {
  const { db, storage, organisationId } = input;
  const previous = await loadLogoRow(db, organisationId);
  if (!previous) return false;
  await db.delete(organisationLogos).where(eq(organisationLogos.organisationId, organisationId));
  await discardObjects(storage, previous.objectKey);
  await recordAudit({
    db,
    organisationId,
    actor: auditActor(input.scope),
    action: "theme.logo_removed",
    entityType: "organisation_logo",
    entityId: organisationId,
    summary: `Removed the workspace logo (${previous.originalName}). The portal shows the default mark again.`,
    detail: { logoId: previous.logoId, fileName: previous.originalName },
    request: input.request,
  });
  return true;
}

/**
 * RECORD THE REPORTS' COPY — for the logo it was drawn from and no other.
 *
 * Conditional on `logo_id`: a copy made in one tab from a logo another tab has
 * since replaced matches no row, and the caller then deletes the object it
 * wrote rather than filing old pixels under the new logo.
 */
export async function recordPrintRendition(
  db: Db,
  organisationId: string,
  logoId: string,
  size: { width: number; height: number },
): Promise<boolean> {
  const updated = await db
    .update(organisationLogos)
    .set({ printWidth: size.width, printHeight: size.height })
    .where(and(eq(organisationLogos.organisationId, organisationId), eq(organisationLogos.logoId, logoId)))
    .returning({ logoId: organisationLogos.logoId });
  return updated.length > 0;
}

/** What a PDF or a Word file embeds: a proven JPEG and its size. */
export type DocumentLogo = { jpeg: Uint8Array; width: number; height: number; components: 1 | 3 };

/**
 * THE LOGO FOR A DOCUMENT, read from the workspace's own copy — or null, and
 * the document simply prints without one. Re-inspected on the way out: a copy
 * is embedded byte-for-byte into a file a client will open, so it is checked
 * again rather than trusted because it was checked once.
 */
export async function documentLogo(
  db: Db,
  storage: LogoReader | undefined,
  organisationId: string,
): Promise<DocumentLogo | null> {
  try {
    if (!storage) return null;
    const row = await readOrganisationLogo(db, organisationId);
    if (!row || !row.printWidth || !row.printHeight) return null;
    const object = await storage.get(printRenditionKey(row.objectKey));
    if (!object?.body) return null;
    const jpeg = new Uint8Array(await new Response(object.body).arrayBuffer());
    const inspected = inspectPrintRendition(jpeg);
    if (!inspected.ok || (inspected.components !== 1 && inspected.components !== 3)) return null;
    return { jpeg, width: inspected.width, height: inspected.height, components: inspected.components };
  } catch (error) {
    console.error("[organisation-logo] the document logo could not be read", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
