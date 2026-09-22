/**
 * `GET /api/leads/csv` — the website enquiries the inbox is showing, as a spreadsheet.
 *
 * WHY THIS EXISTS. §12's inbox could be read and triaged on screen and there was no
 * way to get the list out of it. An enquiry is a sales record: it is followed up
 * outside this product, by people who do not have accounts in it, and the answer to
 * "send me this week's enquiries" was a person retyping them.
 *
 * THE SAME AUTHORITY AS THE SCREEN, AND THE SAME ROWS. `platformLeadsRefusal` and
 * `readLeadEnquiries` are imported from the inbox route rather than restated here.
 * That matters more than it usually would: these rows carry a customer workspace's
 * id while belonging to the platform (the reason is written at length in that file),
 * so a capability check copied slightly wrong would hand one client every enquiry
 * MAINTSUPP has received, including their competitors' names. One gate, one reader,
 * two callers.
 *
 * `?status=` MIRRORS THE SCREEN'S FILTER — `open` (the default the inbox opens on),
 * `all`, or one status key — so the download is what the reader is looking at rather
 * than a second, differently-filtered list. An unknown value is refused rather than
 * silently widened to everything.
 *
 * NO STATE CHANGES. A download is a read: nothing is marked exported, and no audit
 * row is written, for the same reason no other CSV export in this product writes one.
 */
import { ensureDatabase } from "../../../../db/init";
import { csvResponse, toCsv } from "../../../lib/csv";
import { isLeadStatus } from "../../../lib/lead-status";
import { anonymousRefusal, scopedDb } from "../../../lib/tenant-db";
import { platformLeadsRefusal, readLeadEnquiries } from "../route";

export const dynamic = "force-dynamic";

/**
 * The columns, in the order the screen reads left to right, then the fields it keeps
 * in the row's detail. `Filed under` is the workspace name and `Workspace id` the id
 * beside it: the name is what a person reads and the id is what a follow-up needs.
 */
const COLUMNS = [
  "Received",
  "Status",
  "Name",
  "Company",
  "Email",
  "Phone",
  "Sites",
  "Services",
  "Regions",
  "Challenge",
  "Notified",
  "Notify attempts",
  "Filed under",
  "Workspace id",
  "Enquiry id",
];

export async function GET(request: Request) {
  try {
    await ensureDatabase();
    const scope = await scopedDb(request);
    const refusal = platformLeadsRefusal(scope);
    if (refusal) return refusal;

    const requested = new URL(request.url).searchParams.get("status") ?? "open";
    if (requested !== "open" && requested !== "all" && !isLeadStatus(requested)) {
      return Response.json(
        { error: `There is no "${requested}" filter. Use open, all, or a status.` },
        { status: 400 },
      );
    }

    const { enquiries } = await readLeadEnquiries(scope);
    const filtered = enquiries.filter((entry) =>
      requested === "all" ? true : requested === "open" ? !entry.closed : entry.status === requested,
    );

    const rows = filtered.map((entry) => ({
      Received: entry.createdAt,
      Status: entry.status,
      Name: entry.name,
      Company: entry.company,
      Email: entry.email,
      Phone: entry.phone ?? "",
      Sites: entry.siteRange,
      /* One cell per list, semicolon-separated: a comma would need quoting in every
         row and reads as a second column to anyone scanning the file by eye. */
      Services: entry.services.join("; "),
      Regions: entry.regions.join("; "),
      Challenge: entry.challenge,
      Notified: entry.notifiedAt ?? "",
      "Notify attempts": entry.notifyAttempts,
      "Filed under": entry.workspaceName ?? "",
      "Workspace id": entry.organisationId,
      "Enquiry id": entry.id,
    }));

    /* The date and the filter in the filename: two downloads a week apart, or of
       two different filters, do not overwrite one another in a downloads folder. */
    const day = new Date().toISOString().slice(0, 10);
    return csvResponse(`maintsupp-enquiries-${requested}-${day}.csv`, toCsv(COLUMNS, rows));
  } catch (error) {
    const anonymous = anonymousRefusal(error);
    if (anonymous) return anonymous;
    return Response.json({ error: "The enquiries could not be exported." }, { status: 503 });
  }
}
