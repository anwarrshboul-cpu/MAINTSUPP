/**
 * The invoice ledger — mounted at /invoices.
 *
 * ── RECORD AND TRACK ONLY ─────────────────────────────────────────────────
 * The owner's explicit decision, and it shapes every endpoint here: MAINTSUPP
 * does NOT issue invoices. There is no numbering, no PDF production, no
 * templating, no "next invoice number" anywhere in this file. An invoice exists
 * in somebody's accounting system; this writes down that it exists, what it was
 * for, when it is due and whether it has been paid, so that "what is
 * outstanding across the estate" has an answer. `invoice_number` is transcribed
 * from the document, which is why it is required and unique per client — a
 * figure in a total that traces back to no document is worse than no row at
 * all.
 *
 * ── CONTRACTORS SEE NOTHING ───────────────────────────────────────────────
 * The whole router is behind `canSeeMoney`, which is false for a contractor, so
 * every path answers 403 before it reads anything. That gate is one line and
 * one reordering away from being lost, so the row-level predicate refuses them
 * a second time — see `invoiceAccessSql`.
 *
 * ── STATUS IS COMPUTED ────────────────────────────────────────────────────
 * `invoices.status` stores three values only: awaiting_payment, paid,
 * cancelled. 'overdue' is never written, because it is not a decision anybody
 * makes — it is what "unpaid" becomes when the due date passes, and a stored
 * copy would be stale the morning after it was written. `EFFECTIVE_STATUS`
 * derives it in SQL, once, and the list, the filters and the totals all read
 * that same expression so they cannot disagree about which invoices are late.
 */
import { Hono } from "hono";
import {
  canRecordInvoices,
  canSeeMoney,
  organisationScopeFor,
  scopeFor,
  type Actor,
} from "../lib/access.ts";
import { requireActor, requireCapability, type Env } from "../lib/middleware.ts";
import { str } from "../lib/http.ts";
import {
  isoDate,
  receiveOneFile,
  sha256Of,
  UUID_SHAPE,
} from "../lib/attachments.ts";
import type { Db } from "../../../../packages/db/src/client.ts";
import { objectKeyFor } from "../lib/files.ts";
import { getStorage, SIGNED_URL_TTL_SECONDS } from "../lib/storage.ts";

export const invoices = new Hono<Env>();
invoices.use("*", requireActor);
/*
 * The money gate, on the router rather than on each handler. A contractor
 * reaching any invoice path — list, totals, one row, a PDF — is refused here
 * once, so a handler added later cannot forget it.
 */
invoices.use(
  "*",
  requireCapability(canSeeMoney, "Invoices are not part of your access."),
);

/**
 * Awaiting payment, paid, overdue or cancelled — derived, never stored.
 *
 * The order matters: cancelled wins over everything (a cancelled invoice is not
 * overdue, it is not owed), then paid, then the date. `i.paid_at is not null`
 * is checked alongside `status = 'paid'` so a row that got a payment date by
 * some other route still reads as paid rather than as overdue.
 */
const EFFECTIVE_STATUS = `
  case
    when i.status = 'cancelled' then 'cancelled'
    when i.status = 'paid' or i.paid_at is not null then 'paid'
    when i.due_at is not null and i.due_at < current_date then 'overdue'
    else 'awaiting_payment'
  end`;

/**
 * What `?status=` accepts, and the SQL each one means.
 *
 * A Map, not an object literal. `STATUS_FILTERS["constructor"]` on a literal
 * resolves up the prototype chain to the `Object` function — truthy, so it was
 * pushed into the WHERE list and stringified into the statement as
 * `function Object() { [native code] }`, giving a 500. Not injectable, since
 * the text came from Node rather than the caller, but caller-controlled input
 * was deciding what text reached the SQL, which is the rule this file is built
 * on. A Map has no prototype entries to walk into.
 */
const STATUS_FILTERS = new Map<string, string>(Object.entries({
  paid: `(${EFFECTIVE_STATUS}) = 'paid'`,
  overdue: `(${EFFECTIVE_STATUS}) = 'overdue'`,
  awaiting_payment: `(${EFFECTIVE_STATUS}) = 'awaiting_payment'`,
  cancelled: `(${EFFECTIVE_STATUS}) = 'cancelled'`,
  /* Everything still owed: unpaid and not cancelled, late or not. This is the
     chase list, and it is the one people actually ask for. */
  outstanding: `(${EFFECTIVE_STATUS}) in ('awaiting_payment','overdue')`,
}));

/**
 * Who may see which invoice, composed from `access.ts` and nothing else.
 *
 * Two cases, because an invoice has two possible owners:
 *
 *   1. Raised against a JOB — it follows the job, through `scopeFor`. A client
 *      sees the invoice for work at their site because they can see the work.
 *   2. Raised against the ORGANISATION with no job — a monthly coordination
 *      fee, say. `organisationScopeFor` is DENY for a site-scoped client_user
 *      on purpose: a row with no site is about the whole account, and showing
 *      it to a store manager would widen them past the sites they were given.
 *
 * `params` is appended to in the order the placeholders appear in the returned
 * fragment, so the `$n` numbering `scopeFor` produced stays correct.
 */
function invoiceAccessSql(actor: Actor, params: unknown[]): string {
  // Belt to the router's braces. `canSeeMoney` already refused a contractor
  // upstream; if that gate is ever moved or reordered, this still holds.
  if (!canSeeMoney(actor)) return "false";

  const viaJob = scopeFor(actor, "j", params.length);
  params.push(...viaJob.params);
  const viaOrg = organisationScopeFor(actor, "i", params.length);
  params.push(...viaOrg.params);

  return `((i.job_id is not null and (${viaJob.sql}))
        or (i.job_id is null and (${viaOrg.sql})))`;
}

/** Every invoice query joins the same three tables. */
const INVOICE_FROM = `
  from invoices i
  join organisations o on o.id = i.organisation_id
  left join jobs j on j.id = i.job_id
  left join contractors ct on ct.id = i.contractor_id`;

const INVOICE_COLUMNS = `
  i.id::text, i.invoice_number, i.amount_pence, i.notes,
  i.issued_at::text, i.due_at::text, i.paid_at::text,
  (${EFFECTIVE_STATUS}) as status,
  case when i.due_at is null then null
       else (i.due_at - current_date)::int end as days_to_due,
  i.organisation_id::text, o.name as organisation_name,
  i.job_id::text, j.reference as job_reference, j.title as job_title,
  i.contractor_id::text, ct.name as contractor_name,
  i.attachment_id::text, i.created_at::text`;

type InvoiceRow = Record<string, unknown> & { amount_pence: unknown };

/**
 * Money out of the database, as a number.
 *
 * `amount_pence` is `bigint`, and the two backends disagree about what that is
 * in JavaScript: PGlite hands back a number, `postgres` hands back a string so
 * that values above 2^53 survive. A string reaches the browser and
 * `formatMoney` returns null for it, so every total in the portal renders as a
 * dash — on production only. Coerced here, once, at the boundary.
 */
const asPence = (value: unknown): number => Number(value ?? 0);

const money = (row: InvoiceRow): InvoiceRow => ({
  ...row,
  amount_pence: asPence(row.amount_pence),
});

/* ================================================================ reading == */

/**
 * GET /invoices — the ledger, filtered and paged.
 *
 * ONE predicate list feeds the rows, the count AND the totals. Building them
 * separately is how a filtered page reports the unfiltered total and the reader
 * pages forward into nothing — a bug this product has already had once, on the
 * job board, and the fix there was the same discipline.
 */
invoices.get("/", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");

  const params: unknown[] = [];
  const where: string[] = [invoiceAccessSql(actor, params)];

  const status = str(c.req.query("status"), 20);
  const statusFilter = status ? STATUS_FILTERS.get(status) : undefined;
  if (statusFilter) where.push(statusFilter);

  const organisationId = str(c.req.query("organisationId"), 40);
  if (organisationId && UUID_SHAPE.test(organisationId)) {
    params.push(organisationId);
    where.push(`i.organisation_id = $${params.length}`);
  }

  const jobId = str(c.req.query("jobId"), 40);
  if (jobId && UUID_SHAPE.test(jobId)) {
    params.push(jobId);
    where.push(`i.job_id = $${params.length}`);
  }

  const search = str(c.req.query("q"), 80);
  if (search) {
    // People look for an invoice by its number or by the job it was for.
    params.push(`%${search}%`);
    where.push(
      `(i.invoice_number ilike $${params.length} or j.reference ilike $${params.length}
        or o.name ilike $${params.length})`,
    );
  }

  const whereSql = `where ${where.join(" and ")}`;
  const limit = Math.min(Math.max(Math.trunc(Number(c.req.query("limit")) || 100), 1), 500);
  const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);

  const rows = await db.query<InvoiceRow>(
    `select ${INVOICE_COLUMNS} ${INVOICE_FROM} ${whereSql}
      -- i.id last: this endpoint pages, and every sort key above it can tie
      -- (invoices imported or entered in a batch share a date). Without a
      -- unique final key, LIMIT/OFFSET silently drops and repeats rows.
      order by coalesce(i.due_at, i.issued_at, i.created_at::date) desc, i.created_at desc, i.id desc
      limit $${params.length + 1} offset $${params.length + 2}`,
    [...params, limit, offset],
  );

  const [totals] = await db.query<Record<string, unknown>>(
    `select count(*)::int as n,
            coalesce(sum(i.amount_pence),0)::bigint as total_pence,
            coalesce(sum(i.amount_pence) filter (where (${EFFECTIVE_STATUS}) = 'paid'),0)::bigint as paid_pence,
            coalesce(sum(i.amount_pence) filter (where (${EFFECTIVE_STATUS}) in ('awaiting_payment','overdue')),0)::bigint as outstanding_pence,
            coalesce(sum(i.amount_pence) filter (where (${EFFECTIVE_STATUS}) = 'overdue'),0)::bigint as overdue_pence,
            count(*) filter (where (${EFFECTIVE_STATUS}) = 'overdue')::int as overdue_count
       ${INVOICE_FROM} ${whereSql}`,
    params,
  );

  const total = Number(totals.n);
  return c.json({
    invoices: rows.map(money),
    total,
    limit,
    offset,
    hasMore: offset + rows.length < total,
    /* Totals for the CURRENT filter, so the figure on screen and the list under
       it are answers to the same question. Portfolio totals live on /summary. */
    totals: {
      count: total,
      totalPence: asPence(totals.total_pence),
      paidPence: asPence(totals.paid_pence),
      outstandingPence: asPence(totals.outstanding_pence),
      overduePence: asPence(totals.overdue_pence),
      overdueCount: Number(totals.overdue_count),
    },
    canRecord: canRecordInvoices(actor),
  });
});

/**
 * GET /invoices/summary — totals per organisation, unfiltered.
 *
 * The organisation view the brief asks for. Unfiltered on purpose: this is the
 * "who owes what" figure, and it must not move when somebody types in the
 * search box above it.
 */
invoices.get("/summary", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");

  const params: unknown[] = [];
  const access = invoiceAccessSql(actor, params);

  const rows = await db.query<Record<string, unknown>>(
    `select o.id::text as organisation_id, o.name as organisation_name,
            count(*)::int as invoice_count,
            coalesce(sum(i.amount_pence),0)::bigint as total_pence,
            coalesce(sum(i.amount_pence) filter (where (${EFFECTIVE_STATUS}) = 'paid'),0)::bigint as paid_pence,
            coalesce(sum(i.amount_pence) filter (where (${EFFECTIVE_STATUS}) in ('awaiting_payment','overdue')),0)::bigint as outstanding_pence,
            coalesce(sum(i.amount_pence) filter (where (${EFFECTIVE_STATUS}) = 'overdue'),0)::bigint as overdue_pence,
            count(*) filter (where (${EFFECTIVE_STATUS}) = 'overdue')::int as overdue_count
       ${INVOICE_FROM}
      where ${access}
      group by 1,2
      order by o.name`,
    params,
  );

  const organisations = rows.map((row) => ({
    organisationId: row.organisation_id as string,
    organisationName: row.organisation_name as string,
    invoiceCount: Number(row.invoice_count),
    totalPence: asPence(row.total_pence),
    paidPence: asPence(row.paid_pence),
    outstandingPence: asPence(row.outstanding_pence),
    overduePence: asPence(row.overdue_pence),
    overdueCount: Number(row.overdue_count),
  }));

  return c.json({
    organisations,
    totals: organisations.reduce(
      (sum, org) => ({
        invoiceCount: sum.invoiceCount + org.invoiceCount,
        totalPence: sum.totalPence + org.totalPence,
        paidPence: sum.paidPence + org.paidPence,
        outstandingPence: sum.outstandingPence + org.outstandingPence,
        overduePence: sum.overduePence + org.overduePence,
        overdueCount: sum.overdueCount + org.overdueCount,
      }),
      {
        invoiceCount: 0,
        totalPence: 0,
        paidPence: 0,
        outstandingPence: 0,
        overduePence: 0,
        overdueCount: 0,
      },
    ),
  });
});

/** One invoice, or the same 404 an unknown id gets. */
invoices.get("/:id", async (c) => {
  const db = c.get("db");
  const invoice = await invoiceInScope(db, c.get("actor"), c.req.param("id"));
  if (!invoice) return c.json({ error: "No such invoice." }, 404);
  return c.json({ invoice: money(invoice) });
});

/**
 * GET /invoices/:id/pdf — a short-lived signed URL for the attached document.
 *
 * Deliberately NOT `/uploads/:id/url`. That endpoint's access check ORs over
 * job / comment / site / job_request owners, and an invoice attachment is owned
 * by `invoice_id` — so it matches none of them and that route answers 404 for
 * these rows by construction. That is the point: had the PDF been filed against
 * the job instead, a contractor assigned to the job could have listed it and
 * minted a URL for a document they must never see. The owner column decides the
 * access rule, so the access rule decides the owner column.
 */
invoices.get("/:id/pdf", async (c) => {
  const db = c.get("db");
  const invoice = await invoiceInScope(db, c.get("actor"), c.req.param("id"));
  if (!invoice) return c.json({ error: "No such invoice." }, 404);

  const [file] = await db.query<{
    object_key: string;
    content_type: string;
    original_name: string;
  }>(
    `select object_key, content_type, original_name from attachments
      where id = $1 and invoice_id = $2`,
    [invoice.attachment_id, invoice.id],
  );
  if (!file) return c.json({ error: "No document is attached." }, 404);

  return c.json({
    ok: true,
    url: await getStorage().getSignedUrl(file.object_key, SIGNED_URL_TTL_SECONDS),
    expiresIn: SIGNED_URL_TTL_SECONDS,
    contentType: file.content_type,
    originalName: file.original_name,
  });
});

/* ================================================================ writing == */

type Invoice = Record<string, unknown> & {
  id: string;
  organisation_id: string;
  attachment_id: string | null;
};

/** The invoice, if this caller may see it. The only lookup the writes use. */
async function invoiceInScope(
  db: Db,
  actor: Actor,
  id: string,
): Promise<Invoice | null> {
  if (!UUID_SHAPE.test(id)) return null;
  const params: unknown[] = [id];
  const access = invoiceAccessSql(actor, params);
  const [row] = await db.query<Invoice>(
    `select ${INVOICE_COLUMNS} ${INVOICE_FROM} where i.id = $1 and ${access}`,
    params,
  );
  return row ?? null;
}

/**
 * Pence, as an integer, or null.
 *
 * A float is refused rather than rounded. `12.5` reaching this endpoint means
 * somebody sent pounds where pence were asked for, and rounding it to 13p turns
 * a £12.50 invoice into a twelve-pence one that reconciles against nothing. The
 * message says which unit is wanted.
 */
function pence(value: unknown): number | null {
  const amount = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  if (!Number.isInteger(amount) || amount < 0) return null;
  // Above this, JavaScript integers stop being exact and a total silently
  // drifts. No real invoice is £90 trillion.
  if (amount > Number.MAX_SAFE_INTEGER) return null;
  return amount;
}

const isDuplicateKey = (error: unknown): boolean =>
  (error as { code?: string })?.code === "23505" ||
  /duplicate key|unique constraint/i.test(String((error as Error)?.message ?? ""));

/**
 * POST /invoices — write down an invoice that already exists.
 *
 * Against a job (by id or by the reference somebody reads off the paperwork) or
 * against the organisation. The job wins if both are given, and the
 * organisation is taken FROM the job rather than from the request — otherwise a
 * caller could file client A's job under client B's account and move both
 * clients' totals with one request.
 */
invoices.post("/", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  if (!canRecordInvoices(actor)) {
    return c.json({ error: "Only staff record invoices." }, 403);
  }

  const body = await c.req.json().catch(() => ({}));

  const invoiceNumber = str(body.invoiceNumber, 60);
  if (!invoiceNumber) {
    return c.json({ error: "Enter the invoice number from the document." }, 400);
  }

  const amountPence = pence(body.amountPence);
  if (amountPence === null) {
    return c.json({ error: "Enter the amount in whole pence, as a number." }, 400);
  }

  const issuedAt = body.issuedAt ? isoDate(body.issuedAt) : null;
  const dueAt = body.dueAt ? isoDate(body.dueAt) : null;
  const paidAt = body.paidAt ? isoDate(body.paidAt) : null;
  for (const [name, raw, parsed] of [
    ["issued", body.issuedAt, issuedAt],
    ["due", body.dueAt, dueAt],
    ["paid", body.paidAt, paidAt],
  ] as const) {
    if (raw && !parsed) {
      return c.json({ error: `Enter the ${name} date as YYYY-MM-DD.` }, 400);
    }
  }
  if (issuedAt && dueAt && dueAt < issuedAt) {
    // Caught here because the symptom is silent: an invoice due before it was
    // issued is instantly "overdue" and sits at the top of the chase list.
    return c.json({ error: "The due date is before the issue date." }, 400);
  }

  /* Which client this belongs to — resolved from the job when there is one. */
  const jobId = str(body.jobId, 40);
  const jobReference = str(body.jobReference, 20);
  let job: { id: string; organisation_id: string } | null = null;

  if (jobId || jobReference) {
    const params: unknown[] = [jobId && UUID_SHAPE.test(jobId) ? jobId : null, jobReference || null];
    const scope = scopeFor(actor, "j", params.length);
    const [found] = await db.query<{ id: string; organisation_id: string }>(
      `select j.id::text, j.organisation_id::text from jobs j
        where (($1::uuid is not null and j.id = $1::uuid)
            or ($2::text is not null and upper(j.reference) = upper($2::text)))
          and ${scope.sql}`,
      [...params, ...scope.params],
    );
    if (!found) return c.json({ error: "No such job." }, 404);
    job = found;
  }

  const organisationId = job?.organisation_id ?? str(body.organisationId, 40);
  if (!organisationId || !UUID_SHAPE.test(organisationId)) {
    return c.json({ error: "Choose a job or an organisation." }, 400);
  }
  if (!job) {
    // Checked rather than left to the foreign key, which would surface as a
    // 500 and tell the person nothing about what to fix.
    const [organisation] = await db.query<{ id: string }>(
      "select id::text from organisations where id = $1 and active",
      [organisationId],
    );
    if (!organisation) return c.json({ error: "No such organisation." }, 404);
  }

  const contractorId = str(body.contractorId, 40);

  try {
    const [invoice] = await db.query<Invoice>(
      `insert into invoices
         (organisation_id, job_id, contractor_id, invoice_number, amount_pence,
          issued_at, due_at, paid_at, status, notes, recorded_by)
       values ($1,$2,$3,$4,$5,$6::date,$7::date,$8::timestamptz,
               case when $8::timestamptz is null then 'awaiting_payment'::invoice_status
                    else 'paid'::invoice_status end,
               nullif($9,''), $10)
       returning id::text, organisation_id::text, invoice_number, amount_pence,
                 issued_at::text, due_at::text, paid_at::text, status::text`,
      [
        organisationId,
        job?.id ?? null,
        contractorId && UUID_SHAPE.test(contractorId) ? contractorId : null,
        invoiceNumber,
        amountPence,
        issuedAt,
        dueAt,
        paidAt,
        str(body.notes, 1000),
        actor.profileId,
      ],
    );

    await db.query(
      `insert into activity_log (organisation_id, actor_profile_id, actor_email, action, entity_type, entity_id, detail)
       values ($1,$2,$3,'invoice.recorded','invoice',$4,$5)`,
      [
        organisationId, actor.profileId, actor.email, invoice.id,
        JSON.stringify({ invoiceNumber, amountPence, jobId: job?.id ?? null }),
      ],
    );

    return c.json({ ok: true, invoice: money(invoice) });
  } catch (error) {
    /*
     * The unique index on (organisation_id, invoice_number) firing is the most
     * likely failure here and it is not a server error — it is somebody
     * recording the same invoice twice, which is exactly what that index is
     * for. Told plainly, because the alternative is a duplicate that doubles
     * the client's outstanding balance.
     */
    if (isDuplicateKey(error)) {
      return c.json(
        { error: `Invoice ${invoiceNumber} is already recorded for this client.` },
        409,
      );
    }
    throw error;
  }
});

/** POST /invoices/:id/paid — the money arrived, and when. */
invoices.post("/:id/paid", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  if (!canRecordInvoices(actor)) {
    return c.json({ error: "Only staff settle invoices." }, 403);
  }

  const invoice = await invoiceInScope(db, actor, c.req.param("id"));
  if (!invoice) return c.json({ error: "No such invoice." }, 404);

  const body = await c.req.json().catch(() => ({}));
  const paidAt = body.paidAt ? isoDate(body.paidAt) : null;
  if (body.paidAt && !paidAt) {
    return c.json({ error: "Enter the payment date as YYYY-MM-DD." }, 400);
  }

  const rows = await db.query<Invoice>(
    `update invoices
        set status = 'paid', paid_at = coalesce($2::timestamptz, now())
      where id = $1 and status <> 'cancelled'
      returning id::text, status::text, paid_at::text, amount_pence`,
    [invoice.id, paidAt],
  );
  if (!rows.length) {
    return c.json({ error: "That invoice was cancelled." }, 400);
  }

  await db.query(
    `insert into activity_log (organisation_id, actor_profile_id, actor_email, action, entity_type, entity_id, detail)
     values ($1,$2,$3,'invoice.paid','invoice',$4,$5)`,
    [
      invoice.organisation_id, actor.profileId, actor.email, invoice.id,
      JSON.stringify({ paidAt: rows[0].paid_at }),
    ],
  );
  return c.json({ ok: true, invoice: money(rows[0]) });
});

/**
 * POST /invoices/:id/cancel — the record was wrong, or the invoice was voided.
 *
 * Not a delete. The row stays, out of every total, with an audit entry saying
 * who removed it from the ledger — deleting it would leave the client's total
 * changing for no recorded reason.
 */
invoices.post("/:id/cancel", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  if (!canRecordInvoices(actor)) {
    return c.json({ error: "Only staff cancel invoices." }, 403);
  }

  const invoice = await invoiceInScope(db, actor, c.req.param("id"));
  if (!invoice) return c.json({ error: "No such invoice." }, 404);

  const reason = str((await c.req.json().catch(() => ({}))).reason, 300);
  if (!reason) return c.json({ error: "Say why it is being cancelled." }, 400);

  const rows = await db.query<Invoice>(
    /* `chr(10)` rather than an escape: this SQL lives in a JavaScript template
       literal, where a backslash-n would already have become a real newline
       before Postgres ever saw it. Spelling it out means the statement reads
       the same in both languages. */
    `update invoices set status = 'cancelled',
            notes = trim(both chr(10) from coalesce(notes,'') || chr(10) || 'Cancelled: ' || $2)
      where id = $1 and status <> 'paid'
      returning id::text, status::text, amount_pence`,
    [invoice.id, reason],
  );
  if (!rows.length) {
    return c.json({ error: "A paid invoice cannot be cancelled." }, 400);
  }

  await db.query(
    `insert into activity_log (organisation_id, actor_profile_id, actor_email, action, entity_type, entity_id, detail)
     values ($1,$2,$3,'invoice.cancelled','invoice',$4,$5)`,
    [invoice.organisation_id, actor.profileId, actor.email, invoice.id, JSON.stringify({ reason })],
  );
  return c.json({ ok: true, invoice: money(rows[0]) });
});

/**
 * POST /invoices/:id/pdf — attach the document itself.
 *
 * The same pipeline as every other upload: real type sniffed from the bytes,
 * key minted here, private bucket, signed URL to read it back. The attachment's
 * owner is the INVOICE, which is what keeps it out of `/uploads/:id/url` and
 * therefore away from a contractor who can see the job it belongs to.
 *
 * A previous document is kept rather than deleted — the invoice points at the
 * current one, and a superseded copy still belongs to the row it was filed
 * against.
 */
invoices.post("/:id/pdf", async (c) => {
  const db = c.get("db");
  const actor = c.get("actor");
  if (!canRecordInvoices(actor)) {
    return c.json({ error: "Only staff attach invoice documents." }, 403);
  }

  const invoice = await invoiceInScope(db, actor, c.req.param("id"));
  if (!invoice) return c.json({ error: "No such invoice." }, 404);

  const received = await receiveOneFile(c);
  if (!received.ok) return c.json({ error: received.error }, received.status);
  const { bytes, contentType, extension, originalName } = received.file;

  const key = objectKeyFor(`invoices/${invoice.id}`, extension);
  const storage = getStorage();
  await storage.put(key, bytes, contentType);

  try {
    const attachment = await db.transaction(async (tx) => {
      const [file] = await tx.query<{ id: string; original_name: string }>(
        `insert into attachments
           (kind, object_key, original_name, content_type, byte_size, sha256,
            invoice_id, organisation_id, uploaded_by, uploaded_by_name)
         values ('file',$1,$2,$3,$4,$5,$6,$7,$8,
                 (select full_name from profiles where id = $8))
         returning id::text, original_name`,
        [
          key, originalName, contentType, bytes.length, sha256Of(bytes),
          invoice.id, invoice.organisation_id, actor.profileId,
        ],
      );
      await tx.query("update invoices set attachment_id = $2 where id = $1", [
        invoice.id,
        file.id,
      ]);
      return file;
    });

    await db.query(
      `insert into activity_log (organisation_id, actor_profile_id, actor_email, action, entity_type, entity_id, detail)
       values ($1,$2,$3,'invoice.document_attached','invoice',$4,$5)`,
      [
        invoice.organisation_id, actor.profileId, actor.email, invoice.id,
        JSON.stringify({ attachmentId: attachment.id }),
      ],
    );
    return c.json({ ok: true, attachment });
  } catch (error) {
    // The bytes are already in the bucket; a failed insert would strand them.
    await storage.delete(key).catch(() => {});
    throw error;
  }
});
