"use client";

/**
 * THE LEDGER — ONE COMPONENT, ONE `direction` PROP, BOTH TABS. §1 and §16.
 *
 * "Most systems build one and bolt the other on badly." The Payable and
 * Receivable tabs are the same code with a different `direction`, so an
 * arithmetic fix cannot land on one side and miss the other, and the ONLY
 * things that differ are the words — supplied by `DIRECTION_WORDS`, which is
 * §4's asymmetric vocabulary in one table: "Received from" against "Issued to",
 * "Received date" against "Sent date", the supplier's number against ours.
 *
 * ── THE FILTERS ARE THE URL ───────────────────────────────────────────────
 *
 * Every filter is a query parameter through `useQueryValue`/`useQueryList`, so
 * a filtered ledger is a link somebody can send — which is how the landing
 * page's "show me the overdue ones" works: it writes `overdue=1` and switches
 * tab, rather than reaching into this component's state.
 *
 * ── THE TOTALS ARE THE SERVER'S, OVER THE WHOLE FILTERED SET ──────────────
 *
 * `GET /api/finance/invoices` computes them in SQL over every row the filter
 * matched, not over the fifty on the page, and this component prints them
 * unchanged. Adding up the visible rows would put a page subtotal under a
 * whole-ledger heading, which is a wrong number presented as a right one.
 *
 * ── 380px ─────────────────────────────────────────────────────────────────
 *
 * §16: "Every ledger view works at 380px width." The table below 768px becomes
 * a stack of cards through `finance.css`, which is why every cell carries an
 * explicit `role` and a `data-label`: `display: block` strips the table
 * semantics out of the accessibility tree, and the label is what replaces the
 * header row the card no longer has.
 */

import { useMemo, useState } from "react";
import { Icon } from "../../../components";
import {
  financeStatusKey,
  statusLadder,
  FINANCE_CATEGORIES,
  type InvoiceDirection,
} from "../../../lib/finance/model";
import { useQueryList, useQueryValue } from "../ops/ops-url-state";
import {
  AgeBadge,
  Confirmation,
  Field,
  FinanceState,
  FinanceStatusChip,
  Money,
  MoneyField,
  Refusal,
  UnmappedStatusNotice,
  dayText,
  fieldPence,
  plural,
  todayDay,
  unmappedKeys,
  useFinanceEndpoint,
  useFinanceWrite,
} from "./finance-shared";
import { DIRECTION_WORDS, presentStatus, type StatusMapEntry } from "./finance-status";
import { InvoicePanel } from "./finance-invoice-panel";
import {
  recordBalance,
  type LedgerPayload,
  type LedgerRow,
} from "./finance-records";

interface StatusMapPayload {
  statusMap?: StatusMapEntry[];
  statuses?: StatusMapEntry[];
}

export function FinanceLedger({
  direction,
  onOpenJob,
  onNotify,
}: {
  direction: InvoiceDirection;
  onOpenJob: (id: string) => void;
  onNotify: (message: string) => void;
}) {
  const words = DIRECTION_WORDS[direction];
  const today = todayDay();

  const [search, setSearch] = useQueryValue("q", "");
  const [statuses, , toggleStatus] = useQueryList("status");
  const [counterparty, setCounterparty] = useQueryValue("party", "");
  const [site, setSite] = useQueryValue("site", "");
  const [job, setJob] = useQueryValue("job", "");
  const [overdue, setOverdue] = useQueryValue("overdue", "");
  const [unmatched, setUnmatched] = useQueryValue("unmatched", "");
  const [from, setFrom] = useQueryValue("from", "");
  const [to, setTo] = useQueryValue("to", "");

  const query = useMemo(() => {
    const params = new URLSearchParams();
    params.set("direction", direction);
    params.set("limit", "50");
    if (search) params.set("q", search);
    for (const status of statuses) params.append("status", status);
    if (counterparty) params.set("counterparty", counterparty);
    if (site) params.set("site", site);
    if (job) params.set("job", job);
    if (overdue === "1") params.set("overdue", "1");
    if (unmatched === "1") params.set("unmatched", "1");
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params.toString();
  }, [counterparty, direction, from, job, overdue, search, site, statuses, to, unmatched]);

  const ledger = useFinanceEndpoint<LedgerPayload>("/api/finance/invoices", query);
  /* The workspace's own §5 vocabulary, when the settings route exists. Absent,
     `presentStatus` answers from the built-in ladder and nothing breaks. */
  const settings = useFinanceEndpoint<StatusMapPayload>("/api/finance/settings");
  const statusMap = settings.data?.statusMap ?? settings.data?.statuses ?? null;

  const [selected, setSelected] = useState<string | null>(null);

  /* Memoised because it feeds a `useMemo` below: a fresh `[]` on every render
     would re-run the unmapped-status scan on every keystroke in a filter. */
  const rows = useMemo(() => ledger.data?.invoices ?? [], [ledger.data]);
  const totals = ledger.data?.totals ?? null;
  const unmapped = useMemo(
    () => unmappedKeys(rows.map((row) => row.status), statusMap),
    [rows, statusMap],
  );

  const filtered = statuses.length > 0
    || Boolean(search || counterparty || site || job || from || to)
    || overdue === "1"
    || unmatched === "1";

  return (
    <div className="fin-stack">
      <section className="fin-card">
        <div className="fin-card__head">
          <h2>{words.title}</h2>
          <p className="fin-card__note">
            {direction === "payable"
              ? "Invoices received from contractors and suppliers. You owe this."
              : "Invoices issued to clients. They owe you."}
          </p>
        </div>

        <div className="fin-filters">
          <div className="fin-filters__row">
            <Field label="Search" hint="Invoice number, internal reference or counterparty.">
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label={words.counterparty} hint="The counterparty's id, exactly.">
              <input
                type="text"
                value={counterparty}
                onChange={(event) => setCounterparty(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label="Site">
              <input
                type="text"
                value={site}
                onChange={(event) => setSite(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label="Job">
              <input
                type="text"
                value={job}
                onChange={(event) => setJob(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label="Invoiced from">
              <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </Field>
            <Field label="Invoiced to">
              <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </Field>
          </div>

          <div className="fin-filters__row">
            {statusLadder(direction).map((key) => {
              const on = statuses.includes(key);
              return (
                <button
                  type="button"
                  key={key}
                  className="fin-toggle"
                  aria-pressed={on}
                  onClick={() => toggleStatus(key)}
                >
                  {presentStatus(key, statusMap).label}
                </button>
              );
            })}
          </div>

          <div className="fin-filters__row">
            <button
              type="button"
              className="fin-toggle"
              aria-pressed={overdue === "1"}
              onClick={() => setOverdue(overdue === "1" ? "" : "1")}
            >
              <Icon name="alert" size={13} aria-hidden="true" /> Overdue only
            </button>
            <button
              type="button"
              className="fin-toggle"
              aria-pressed={unmatched === "1"}
              onClick={() => setUnmatched(unmatched === "1" ? "" : "1")}
            >
              <Icon name="shield" size={13} aria-hidden="true" /> Unmatched only
            </button>
            {filtered ? (
              <button
                type="button"
                className="fin-button"
                onClick={() => {
                  setSearch("");
                  setCounterparty("");
                  setSite("");
                  setJob("");
                  setOverdue("");
                  setUnmatched("");
                  setFrom("");
                  setTo("");
                  for (const status of statuses) toggleStatus(status);
                }}
              >
                Clear the filters
              </button>
            ) : null}
          </div>
        </div>

        {totals ? (
          <div className="fin-tiles">
            <Total label="Invoices" value={plural(totals.invoiceCount, "invoice")} />
            <Total label="Gross" pence={totals.grossPence} />
            <Total label="Settled" pence={totals.paidPence + totals.creditedPence} />
            <Total label="Outstanding" pence={totals.outstandingPence} />
          </div>
        ) : null}
        <p className="fin-card__note">
          The four figures above are measured over every invoice this filter matched, not over the
          rows on this page.
        </p>

        <UnmappedStatusNotice keys={unmapped} />

        <FinanceState
          loading={ledger.loading}
          error={ledger.error}
          unavailable={ledger.unavailable}
          endpoint="/api/finance/invoices"
          what="The ledger"
          empty={Boolean(ledger.data) && rows.length === 0}
          emptyLabel={
            filtered
              ? "No invoice matches those filters."
              : `Nothing has been recorded as ${direction} yet.`
          }
          onRetry={ledger.reload}
        >
          <div className="fin-table-wrap">
            <table className="fin-table" role="table">
              <caption className="visually-hidden">
                {words.title} invoices, {plural(rows.length, "row")} shown
              </caption>
              <thead>
                <tr role="row">
                  <th scope="col" role="columnheader">
                    Reference
                  </th>
                  <th scope="col" role="columnheader">
                    {words.counterparty}
                  </th>
                  <th scope="col" role="columnheader">
                    Status
                  </th>
                  <th scope="col" role="columnheader">
                    Due
                  </th>
                  <th scope="col" role="columnheader" className="th--number">
                    Gross
                  </th>
                  <th scope="col" role="columnheader" className="th--number">
                    Outstanding
                  </th>
                  <th scope="col" role="columnheader">
                    <span className="visually-hidden">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <LedgerLine
                    key={row.id}
                    row={row}
                    today={today}
                    statusMap={statusMap}
                    selected={selected === row.id}
                    onOpen={() => setSelected(row.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </FinanceState>
      </section>

      <CreateCard
        direction={direction}
        onNotify={onNotify}
        onCreated={(id) => {
          ledger.reload();
          setSelected(id);
        }}
      />

      {selected ? (
        <InvoicePanel
          invoiceId={selected}
          statusMap={statusMap}
          onClose={() => setSelected(null)}
          onChanged={ledger.reload}
          onOpenJob={onOpenJob}
          onNotify={onNotify}
        />
      ) : null}
    </div>
  );
}

function Total({ label, pence, value }: { label: string; pence?: number; value?: string }) {
  return (
    <div className="fin-tile">
      <span className="fin-tile__label">{label}</span>
      <span className="fin-tile__value">
        {value !== undefined ? value : <Money pence={pence ?? 0} />}
      </span>
    </div>
  );
}

/**
 * One invoice, one row — and below 768px, one card.
 *
 * Three signals per row and none of them colour alone: the chip carries a glyph
 * and the status WORD, the badge carries the number of days, and a voided row
 * is struck through. §5's rule read literally: turn the page greyscale and
 * every state is still legible.
 */
function LedgerLine({
  row,
  today,
  statusMap,
  selected,
  onOpen,
}: {
  row: LedgerRow;
  today: string;
  statusMap: readonly StatusMapEntry[] | null;
  selected: boolean;
  onOpen: () => void;
}) {
  const presentation = presentStatus(row.status, statusMap);
  const balance = recordBalance(row);
  const open = row.flags.filter((flag) => flag.status === "open");
  const struck = financeStatusKey(row.status) === "voided" || Boolean(row.voidedAt);

  return (
    <tr
      role="row"
      className={`${selected ? "fin-row--selected" : ""}${struck ? " fin-row--struck" : ""}`}
    >
      <th scope="row" role="rowheader" data-label="Reference">
        <span className="fin-cell__ref">{row.internalRef ?? row.invoiceNumber ?? row.id}</span>
        {row.invoiceNumber && row.internalRef ? (
          <span className="fin-cell__sub">{row.invoiceNumber}</span>
        ) : null}
      </th>
      <td role="cell" data-label="Counterparty">
        <span className="fin-cell__ref">{row.counterpartyName ?? "—"}</span>
        {row.siteId ? <span className="fin-cell__sub">{row.siteId}</span> : null}
      </td>
      <td role="cell" data-label="Status">
        <FinanceStatusChip presentation={presentation} size="small" />
        {open.length > 0 ? (
          <span className="fin-cell__sub">{plural(open.length, "open flag")}</span>
        ) : null}
      </td>
      <td role="cell" data-label="Due">
        <span className="fin-cell__ref">{dayText(row.dueAt)}</span>
        <AgeBadge dueDay={row.dueAt} today={today} />
      </td>
      <td role="cell" data-label="Gross" className="td--number">
        <Money pence={row.grossPence} currency={row.currency ?? undefined} />
      </td>
      <td role="cell" data-label="Outstanding" className="td--number">
        <Money pence={balance.balancePence} currency={row.currency ?? undefined} />
      </td>
      <td role="cell" data-label="">
        <button
          type="button"
          className="fin-row__open"
          onClick={onOpen}
          aria-label={`Open ${row.internalRef ?? row.invoiceNumber ?? "this invoice"}`}
        >
          Open
        </button>
      </td>
    </tr>
  );
}

/* ── §12: manual entry ────────────────────────────────────────────────────── */

/**
 * A NEW INVOICE IS ALWAYS A DRAFT, and this form does not pretend otherwise.
 *
 * The server forces `status: "draft"` whatever a body asks for, because every
 * later status is reached through the actions route where the band, the flags
 * and the history are enforced. So the form has no status control at all — an
 * input the server ignores is a lie about what happens when you press save.
 */
function CreateCard({
  direction,
  onNotify,
  onCreated,
}: {
  direction: InvoiceDirection;
  onNotify: (message: string) => void;
  onCreated: (id: string) => void;
}) {
  const words = DIRECTION_WORDS[direction];
  const write = useFinanceWrite();
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [counterpartyName, setCounterpartyName] = useState("");
  const [counterpartyId, setCounterpartyId] = useState("");
  const [department, setDepartment] = useState("");
  const [fao, setFao] = useState("");
  const [job, setJob] = useState("");
  const [siteId, setSiteId] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [sideDate, setSideDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [net, setNet] = useState("");
  const [vat, setVat] = useState("");
  const [category, setCategory] = useState("general");
  const [notes, setNotes] = useState("");

  const netPence = fieldPence(net);
  const vatPence = fieldPence(vat) ?? 0;

  return (
    <section className="fin-card">
      <div className="fin-card__head">
        <h2>Record a {direction} invoice</h2>
        <p className="fin-card__note">
          It is saved as a draft and the three-way match runs immediately, so a duplicate is flagged
          before anybody moves on.
        </p>
      </div>
      <Refusal message={write.error} />
      <Confirmation message={done} />

      {!open ? (
        <div className="fin-actions">
          <button
            type="button"
            className="fin-button fin-button--primary"
            onClick={() => setOpen(true)}
          >
            <Icon name="plus" size={14} aria-hidden="true" /> New {direction} invoice
          </button>
        </div>
      ) : (
        <div className="fin-form">
          <div className="fin-form__grid">
            <Field label={words.numberLabel} hint={words.numberHint}>
              <input
                type="text"
                value={invoiceNumber}
                onChange={(event) => setInvoiceNumber(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label={words.counterparty} hint={words.counterpartyHint}>
              <input
                type="text"
                value={counterpartyName}
                onChange={(event) => setCounterpartyName(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label="Counterparty id" hint="Optional. Links the invoice to the register record.">
              <input
                type="text"
                value={counterpartyId}
                onChange={(event) => setCounterpartyId(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label={words.departmentLabel}>
              <input
                type="text"
                value={department}
                onChange={(event) => setDepartment(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label="FAO contact">
              <input
                type="text"
                value={fao}
                onChange={(event) => setFao(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label="Job" hint="A quote with no job is an orphan, and so is a cost.">
              <input
                type="text"
                value={job}
                onChange={(event) => setJob(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label="Site">
              <input
                type="text"
                value={siteId}
                onChange={(event) => setSiteId(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label="Invoice date">
              <input
                type="date"
                value={invoiceDate}
                onChange={(event) => setInvoiceDate(event.target.value)}
              />
            </Field>
            <Field label={words.dateLabel}>
              <input
                type="date"
                value={sideDate}
                onChange={(event) => setSideDate(event.target.value)}
              />
            </Field>
            <Field label="Due date" hint="Left blank, the supplier or agreement terms decide it.">
              <input
                type="date"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
              />
            </Field>
            <MoneyField label="Net" value={net} onChange={setNet} />
            <MoneyField label="VAT" value={vat} onChange={setVat} />
            <Field label="Category">
              <select value={category} onChange={(event) => setCategory(event.target.value)}>
                {FINANCE_CATEGORIES.map((option) => (
                  <option key={option} value={option}>
                    {option.charAt(0).toUpperCase() + option.slice(1)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Notes">
              <textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
            </Field>
          </div>
          <p className="fin-card__note">
            Gross will be {netPence === null ? "the net plus the VAT" : <Money pence={netPence + vatPence} />}.
          </p>
          <div className="fin-actions fin-actions--end">
            <button type="button" className="fin-button" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="fin-button fin-button--primary"
              disabled={write.busy || netPence === null}
              onClick={() => {
                const body: Record<string, unknown> = {
                  direction,
                  invoiceNumber: invoiceNumber || undefined,
                  counterpartyName: counterpartyName || undefined,
                  counterpartyId: counterpartyId || undefined,
                  faoContact: fao || undefined,
                  requestId: job || undefined,
                  siteId: siteId || undefined,
                  invoiceDate: invoiceDate || undefined,
                  dueDate: dueDate || undefined,
                  netPence,
                  vatPence,
                  category,
                  notes: notes || undefined,
                };
                body[words.departmentField] = department || undefined;
                if (sideDate) body[words.dateField] = sideDate;
                void write
                  .run("/api/finance/invoices", { method: "POST", body })
                  .then((result) => {
                    if (!result.ok) return;
                    const id = typeof result.payload?.id === "string" ? result.payload.id : null;
                    const said = `Recorded ${String(result.payload?.internalRef ?? "the invoice")} as a draft.`;
                    setDone(said);
                    onNotify(said);
                    setOpen(false);
                    if (id) onCreated(id);
                  });
              }}
            >
              Save the draft
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
