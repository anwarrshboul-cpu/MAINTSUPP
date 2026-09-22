/**
 * THE WORKSPACE LOGO — what it is, a small upload, and removal.
 *
 *   GET    — this workspace's logo as metadata (never its bytes, never its
 *            object key), whether the caller may change it, and the limits.
 *            Open to any member, like `GET /api/theme`: the answer is what the
 *            portal they are looking at already shows.
 *   POST   — a logo up to 900 KB, as `multipart/form-data` with a `file`.
 *            Anything larger is sent in parts through `./upload` — the #78
 *            direct-upload path — because the Workers form parser refuses a
 *            form body at 1 MiB with a bare-text 413. `uploadWorkspaceLogo()`
 *            in `app/lib/client-upload.ts` chooses between the two.
 *   DELETE — back to the default mark.
 *
 * Writes need `settings.edit` and a signed-in account (see `./gate.ts`), are
 * audited (`theme.logo_changed` / `theme.logo_removed`), and are scoped to the
 * caller's own workspace by `scopedDb` — nothing in the request names one.
 *
 * WHAT IS STORED IS WHAT THE BYTES PROVED. `inspectLogo` requires the declared
 * type, the extension and the file's own signature to agree and reads the
 * image's size out of its header, before anything is stored. SVG is refused
 * however it is named or declared.
 */

import { ensureDatabase } from "../../../../db/init";
import {
  LOGO_ACCEPT,
  LOGO_DIRECT_LIMIT,
  LOGO_MAX_BYTES,
  LOGO_MAX_EDGE,
  LOGO_MIN_EDGE,
  inspectLogo,
  logoObjectKey,
} from "../../../lib/organisation-logo-rules";
import {
  adoptOrganisationLogo,
  describeLogo,
  readOrganisationLogo,
  removeOrganisationLogo,
} from "../../../lib/organisation-logo";
import { anonymousRefusal, scopedDb } from "../../../lib/tenant-db";
import { canEditLogo, logoBucket, logoEditorScope, storageUnavailable } from "./gate";

export const dynamic = "force-dynamic";

function unavailable(error?: unknown) {
  // A session that has ended is not an outage — see `anonymousRefusal`.
  const refusal = anonymousRefusal(error);
  if (refusal) return refusal;
  return Response.json({ error: "The workspace logo is temporarily unavailable." }, { status: 503 });
}

const LIMITS = {
  types: ["PNG", "JPEG", "WebP"],
  accept: LOGO_ACCEPT,
  maxBytes: LOGO_MAX_BYTES,
  directLimit: LOGO_DIRECT_LIMIT,
  minEdge: LOGO_MIN_EDGE,
  maxEdge: LOGO_MAX_EDGE,
};

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const scope = await scopedDb(request);
    const row = await readOrganisationLogo(scope.db, scope.orgId);
    return Response.json(
      {
        canEdit: await canEditLogo(scope),
        logo: describeLogo(row),
        limits: LIMITS,
        organisation: { id: scope.orgId, name: scope.organisation?.name ?? null },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return unavailable(error);
  }
}

export async function POST(request: Request) {
  try {
    await ensureDatabase();
    const gate = await logoEditorScope(request);
    if (gate.denied) return gate.denied;
    const { scope } = gate;

    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      return Response.json({ error: "Choose a logo to upload." }, { status: 400 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const inspected = inspectLogo(file.type, file.name, bytes);
    if (!inspected.ok) {
      return Response.json({ error: inspected.error }, { status: inspected.status });
    }

    const storage = await logoBucket();
    if (!storage) return storageUnavailable();

    const logoId = crypto.randomUUID();
    const objectKey = logoObjectKey(scope.orgId, logoId, inspected.type);
    await storage.put(objectKey, bytes, {
      httpMetadata: {
        contentType: inspected.type,
        contentDisposition: `inline; filename="workspace-logo.${inspected.extension}"`,
      },
      customMetadata: {
        organisationId: scope.orgId,
        purpose: "organisation-logo",
        logoId,
        originalName: file.name.slice(0, 255),
        uploadedBy: scope.identityEmail,
      },
    });

    const row = await adoptOrganisationLogo({
      db: scope.db,
      storage,
      organisationId: scope.orgId,
      logo: {
        logoId,
        objectKey,
        contentType: inspected.type,
        byteSize: inspected.byteSize,
        width: inspected.width,
        height: inspected.height,
        originalName: file.name || `workspace-logo.${inspected.extension}`,
      },
      scope,
      request,
      multipart: false,
    });
    return Response.json({ canEdit: true, logo: describeLogo(row), limits: LIMITS }, { status: 201 });
  } catch (error) {
    return unavailable(error);
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureDatabase();
    const gate = await logoEditorScope(request);
    if (gate.denied) return gate.denied;
    const { scope } = gate;
    const storage = await logoBucket();
    if (!storage) return storageUnavailable();
    const removed = await removeOrganisationLogo({
      db: scope.db,
      storage,
      organisationId: scope.orgId,
      scope,
      request,
    });
    return Response.json({ canEdit: true, logo: null, removed, limits: LIMITS });
  } catch (error) {
    return unavailable(error);
  }
}
