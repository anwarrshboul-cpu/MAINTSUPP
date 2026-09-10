"use client";

/**
 * SETTINGS — §13's approval bands, §7's tolerances, §5's status map, §15.13's
 * recurring rules, and §16's bank accounts.
 *
 * ── EVERY NUMBER ON THIS PAGE IS A NUMBER SOMEBODY TYPED ──────────────────
 *
 * That is the whole point of the tab. §5 puts the status vocabulary in a table
 * "following the Module 2 pattern"; §7 makes the over-quote tolerance and the
 * duplicate window configurable; §13 makes the approval thresholds rows rather
 * than constants. A threshold in code is a threshold nobody can change when the
 * business does, and then somebody works around it.
 *
 * ── §16: BANK DETAILS APPEAR ONLY IN SETTINGS, NEVER IN CODE ──────────────
 *
 * `contractors` deliberately carries no account number and this repository is
 * public, so the workspace's own accounts live in `bank_accounts` and are typed
 * by an administrator. Without `billing.manage` the sort code and account
 * number arrive from the server already masked, and this screen renders the
 * masking it was given rather than un-masking anything or asking again. A
 * client-side reveal would make the server's masking decorative.
 *
 * The flag that decides it is `canSeeBankDetails` from the settings payload —
 * the SERVER's own answer, computed by the same check that masks the digits and
 * that refuses a `bankAccount` in a PUT with a 403. Asking `/api/context` for the
 * capability separately would be a second answer to one question, and the two
 * would eventually differ; the screen that renders a mask should be told by
 * whoever applied it.
 */

import { useMemo, useState } from "react";
import { Icon } from "../../../components";
import {
  INVOICE_DIRECTIONS,
  UNMAPPED_STATUS_COLOUR,
  formatPence,
} from "../../../lib/finance/model";
import {
  Confirmation,
  DegradedNotice,
  Field,
  FinanceState,
  Money,
  MoneyField,
  Refusal,
  dayText,
  fieldPence,
  plural,
  useFinanceEndpoint,
  useFinanceWrite,
} from "./finance-shared";
import { presentStatus } from "./finance-status";
import type { StatusMapEntry } from "./finance-status";
import type { ApprovalBand } from "./finance-records";

interface ToleranceSettings {
  overQuoteToleranceBasisPoints: number;
  overQuoteTolerancePence: number;
  duplicateWindowDays: number;
  payableTermsDays: number;
  receivableTermsDays?: number;
  financeInboxAddress?: string | null;
  currency?: string;
}

interface BankAccountRow {
  id: string;
  label: string;
  accountName?: string | null;
  bankName?: string | null;
  /** Already masked by the server for anybody without `billing.manage`. */
  sortCode?: string | null;
  accountNumber?: string | null;
  iban?: string | null;
  active?: boolean;
}

interface RecurringRule {
  id: string;
  direction: string;
  counterpartyId: string | null;
  description: string | null;
  netPence: number;
  category: string | null;
  frequency: string;
  dayOfMonth: number;
  nextRunDate: string | null;
  lastRunAt: string | null;
  active: boolean;
}

interface SettingsPayload extends Partial<ToleranceSettings> {
  settings?: ToleranceSettings;
  /** The server's own answer, and the same one that masked the digits below. */
  canSeeBankDetails?: boolean;
  approvalRules?: ApprovalBand[];
  rules?: ApprovalBand[];
  statusMap?: StatusMapEntry[];
  statuses?: StatusMapEntry[];
  bankAccounts?: BankAccountRow[];
  accounts?: BankAccountRow[];
}

interface RecurringPayload {
  rules?: RecurringRule[];
  recurring?: RecurringRule[];
  /** The frequencies the route will accept, so the select cannot offer a fifth. */
  frequencies?: string[];
  today?: string;
}

export function FinanceSettingsPanel({ onNotify }: { onNotify: (message: string) => void }) {
  const settings = useFinanceEndpoint<SettingsPayload>("/api/finance/settings");
  const recurring = useFinanceEndpoint<RecurringPayload>("/api/finance/recurring");
  const write = useFinanceWrite();
  const [done, setDone] = useState<string | null>(null);

  const payload = settings.data ?? null;
  const tolerances = payload?.settings ?? (payload as ToleranceSettings | null);
  const bands = payload?.approvalRules ?? payload?.rules ?? [];
  const statusMap = payload?.statusMap ?? payload?.statuses ?? [];
  const accounts = payload?.bankAccounts ?? payload?.accounts ?? [];
  const canSeeBankDetails = payload?.canSeeBankDetails === true;
  const rules = recurring.data?.rules ?? recurring.data?.recurring ?? [];
  const frequencies = recurring.data?.frequencies ?? ["monthly", "quarterly", "annually"];

  const save = async (body: Record<string, unknown>, said: string) => {
    const result = await write.run("/api/finance/settings", { method: "PUT", body });
    if (!result.ok) return result;
    setDone(said);
    onNotify(said);
    settings.reload();
    return result;
  };

  return (
    <div className="fin-stack">
      <Refusal message={write.error} />
      <Confirmation message={done} />

      {settings.unavailable ? (
        <section className="fin-card">
          <div className="fin-card__head">
            <h2>Finance settings</h2>
          </div>
          <DegradedNotice
            endpoint="/api/finance/settings"
            what="Every setting on this tab"
            fallback="Until it answers, the built-in defaults apply: a 5% or £50 over-quote tolerance, whichever is greater, and a 30-day duplicate window."
          />
        </section>
      ) : (
        <>
          <ToleranceCard
            tolerances={tolerances}
            state={settings}
            busy={write.busy}
            onSave={save}
          />
          <ApprovalBandCard bands={bands} state={settings} busy={write.busy} onSave={save} />
          <StatusMapCard entries={statusMap} state={settings} busy={write.busy} onSave={save} />
          <BankAccountCard
            accounts={accounts}
            state={settings}
            canSee={canSeeBankDetails}
            busy={write.busy}
            onSave={save}
          />
        </>
      )}

      <RecurringCard
        rules={rules}
        frequencies={frequencies}
        state={recurring}
        onNotify={onNotify}
        onChanged={recurring.reload}
      />
    </div>
  );
}

/* ── §7: the two numbers the match engine reads ───────────────────────────── */

function ToleranceCard({
  tolerances,
  state,
  busy,
  onSave,
}: {
  tolerances: ToleranceSettings | null | undefined;
  state: { loading: boolean; error: string | null; unavailable: boolean; reload: () => void };
  busy: boolean;
  onSave: (
    body: Record<string, unknown>,
    said: string,
  ) => Promise<{ ok: boolean; payload: Record<string, unknown> | null }>;
}) {
  const [percent, setPercent] = useState<string | null>(null);
  const [floor, setFloor] = useState<string | null>(null);
  const [window, setWindow] = useState<string | null>(null);
  const [terms, setTerms] = useState<string | null>(null);
  const [unchanged, setUnchanged] = useState(false);

  const percentValue = percent
    ?? (tolerances ? String((tolerances.overQuoteToleranceBasisPoints ?? 0) / 100) : "");
  const floorValue = floor ?? (tolerances ? String(tolerances.overQuoteTolerancePence ?? 0) : "");
  const windowValue = window ?? (tolerances ? String(tolerances.duplicateWindowDays ?? 0) : "");
  const termsValue = terms ?? (tolerances ? String(tolerances.payableTermsDays ?? 0) : "");

  return (
    <section className="fin-card">
      <div className="fin-card__head">
        <h2>Matching tolerances</h2>
        <p className="fin-card__note">
          What the three-way match is willing to let through without raising a flag.
        </p>
      </div>
      {unchanged ? (
        <div className="fin-notice fin-notice--admin" role="note">
          <p>
            <strong>That did not save.</strong> The settings route accepted the request and sent
            back the tolerances unchanged, which means it does not take these four fields yet —
            it currently saves the bank account, the approval bands and the status map. Nothing
            has been altered, and the match engine is still using the figures shown below. This
            is checked against what came back rather than assumed from a 200.
          </p>
        </div>
      ) : null}
      <FinanceState
        loading={state.loading}
        error={state.error}
        unavailable={state.unavailable}
        endpoint="/api/finance/settings"
        what="Matching tolerances"
        onRetry={state.reload}
      >
        <div className="fin-form__grid">
          <Field
            label="Over-quote tolerance, per cent"
            hint="An invoice above the approved quote by more than this raises a blocking flag."
          >
            <input
              type="number"
              min={0}
              step="0.1"
              value={percentValue}
              onChange={(event) => setPercent(event.target.value)}
            />
          </Field>
          <MoneyField
            label="Over-quote tolerance, floor"
            value={floorValue}
            onChange={setFloor}
            hint="Whichever of the two is greater applies, so small jobs get slack in cash terms."
          />
          <Field
            label="Duplicate window, days"
            hint="Same supplier, same amount, inside this many days is a possible duplicate."
          >
            <input
              type="number"
              min={0}
              value={windowValue}
              onChange={(event) => setWindow(event.target.value)}
            />
          </Field>
          <Field label="Default payable terms, days" hint="Used when the supplier's terms are unknown.">
            <input
              type="number"
              min={0}
              value={termsValue}
              onChange={(event) => setTerms(event.target.value)}
            />
          </Field>
        </div>
        <p className="fin-card__note">
          On a £1,000 quote {percentValue || 0}% is{" "}
          {formatPence(Math.round(100000 * (Number(percentValue) || 0)) / 100)} and the floor is{" "}
          {formatPence(fieldPence(floorValue) ?? 0)}, so the tolerance there is the greater of the
          two.
        </p>
        <div className="fin-actions fin-actions--end">
          <button
            type="button"
            className="fin-button fin-button--primary"
            disabled={busy}
            onClick={() => {
              const sent = {
                overQuoteToleranceBasisPoints: Math.round((Number(percentValue) || 0) * 100),
                overQuoteTolerancePence: fieldPence(floorValue) ?? 0,
                duplicateWindowDays: Math.trunc(Number(windowValue) || 0),
                payableTermsDays: Math.trunc(Number(termsValue) || 0),
              };
              void onSave(sent, "Matching tolerances saved.").then((result) => {
                if (!result.ok) return;
                /*
                 * DID IT ACTUALLY TAKE? The PUT answers with the whole fresh
                 * settings payload, so the figure that came back is the figure
                 * the match engine will now use. Comparing it against what was
                 * sent is the difference between "saved" and "the server said
                 * 200", and those are not the same sentence.
                 */
                const back = (result.payload?.settings ?? result.payload) as
                  | ToleranceSettings
                  | undefined;
                const stuck = back
                  ? back.overQuoteToleranceBasisPoints === sent.overQuoteToleranceBasisPoints
                    && back.duplicateWindowDays === sent.duplicateWindowDays
                  : true;
                setUnchanged(!stuck);
                if (!stuck) return;
                setPercent(null);
                setFloor(null);
                setWindow(null);
                setTerms(null);
              });
            }}
          >
            Save the tolerances
          </button>
        </div>
      </FinanceState>
    </section>
  );
}

/* ── §13: the approval ladder ─────────────────────────────────────────────── */

/**
 * BANDS ARE HALF-OPEN AND THE LADDER MUST NOT HAVE A HOLE IN IT.
 *
 * `max_amount_pence` NULL means "and above", and `resolveApprovalBand` returns
 * NULL rather than a default when nothing matches — because inventing "one
 * approver" for an amount nobody wrote a rule for is how a £40,000 invoice gets
 * signed off by one person. The card therefore says out loud when the top of
 * the ladder is not open-ended, since that is what a hole looks like.
 */
function ApprovalBandCard({
  bands,
  state,
  busy,
  onSave,
}: {
  bands: ApprovalBand[];
  state: { loading: boolean; error: string | null; unavailable: boolean; reload: () => void };
  busy: boolean;
  onSave: (
    body: Record<string, unknown>,
    said: string,
  ) => Promise<{ ok: boolean; payload: Record<string, unknown> | null }>;
}) {
  const [draft, setDraft] = useState<ApprovalBand[] | null>(null);
  const rows = draft ?? bands;

  const openEnded = rows.some((row) => row.maxAmountPence === null && row.active);

  const update = (id: string, patch: Partial<ApprovalBand>) => {
    setDraft(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  return (
    <section className="fin-card">
      <div className="fin-card__head">
        <h2>Approval bands</h2>
        <p className="fin-card__note">
          How many people have to sign off, by value. An approver may not approve an invoice against
          a quote they approved themselves above the maker/checker figure.
        </p>
      </div>
      <FinanceState
        loading={state.loading}
        error={state.error}
        unavailable={state.unavailable}
        endpoint="/api/finance/settings"
        what="Approval bands"
        empty={rows.length === 0}
        emptyLabel="No approval band is configured, so the server will refuse every approval until one is."
        onRetry={state.reload}
      >
        {!openEnded && rows.length > 0 ? (
          <div className="fin-notice fin-notice--admin" role="note">
            <p>
              No band is open-ended, so an invoice above the highest ceiling falls in no band at all
              and cannot be approved. Leave the top band&rsquo;s upper limit blank to mean
              &ldquo;and above&rdquo;.
            </p>
          </div>
        ) : null}
        <div className="fin-table-wrap">
          <table className="fin-table" role="table">
            <caption className="visually-hidden">Approval bands by value</caption>
            <thead>
              <tr role="row">
                <th scope="col" role="columnheader">
                  Direction
                </th>
                <th scope="col" role="columnheader" className="th--number">
                  From
                </th>
                <th scope="col" role="columnheader" className="th--number">
                  Up to
                </th>
                <th scope="col" role="columnheader" className="th--number">
                  Approvers
                </th>
                <th scope="col" role="columnheader">
                  Client sign-off
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr role="row" key={row.id}>
                  <th scope="row" role="rowheader" data-label="Direction">
                    {row.direction}
                  </th>
                  <td role="cell" data-label="From" className="td--number">
                    <Money pence={row.minAmountPence} />
                  </td>
                  <td role="cell" data-label="Up to" className="td--number">
                    {row.maxAmountPence === null ? "and above" : <Money pence={row.maxAmountPence} />}
                  </td>
                  <td role="cell" data-label="Approvers" className="td--number">
                    <input
                      type="number"
                      min={0}
                      max={5}
                      value={row.approversRequired}
                      aria-label={`Approvers required for the band from ${formatPence(row.minAmountPence)}`}
                      onChange={(event) =>
                        update(row.id, {
                          /* Zero is a real band: §13's "under £250 auto-approve
                             on match". The server takes 0 to 5. */
                          approversRequired: Math.min(
                            5,
                            Math.max(0, Math.trunc(Number(event.target.value) || 0)),
                          ),
                        })
                      }
                    />
                  </td>
                  <td role="cell" data-label="Client sign-off">
                    <label className="fin-select">
                      <input
                        type="checkbox"
                        checked={row.requiresClient}
                        aria-label={`Client sign-off for the band from ${formatPence(row.minAmountPence)}`}
                        onChange={(event) =>
                          update(row.id, { requiresClient: event.target.checked })
                        }
                      />
                      <span>{row.requiresClient ? "Required" : "Not required"}</span>
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="fin-actions fin-actions--end">
          <button
            type="button"
            className="fin-button fin-button--primary"
            disabled={busy || draft === null}
            onClick={() => {
              void onSave({ approvalRules: rows }, "Approval bands saved.").then((result) => {
                if (result.ok) setDraft(null);
              });
            }}
          >
            Save the bands
          </button>
        </div>
      </FinanceState>
    </section>
  );
}

/* ── §5: the editable vocabulary ──────────────────────────────────────────── */

function StatusMapCard({
  entries,
  state,
  busy,
  onSave,
}: {
  entries: StatusMapEntry[];
  state: { loading: boolean; error: string | null; unavailable: boolean; reload: () => void };
  busy: boolean;
  onSave: (
    body: Record<string, unknown>,
    said: string,
  ) => Promise<{ ok: boolean; payload: Record<string, unknown> | null }>;
}) {
  const [draft, setDraft] = useState<StatusMapEntry[] | null>(null);
  const rows = draft ?? entries;
  const byDirection = useMemo(
    () =>
      INVOICE_DIRECTIONS.map((direction) => ({
        direction,
        rows: rows.filter((row) => (row.direction ?? direction) === direction),
      })),
    [rows],
  );

  const update = (key: string, patch: Partial<StatusMapEntry>) => {
    setDraft(rows.map((row) => (row.statusKey === key ? { ...row, ...patch } : row)));
  };

  return (
    <section className="fin-card">
      <div className="fin-card__head">
        <h2>Status map</h2>
        <p className="fin-card__note">
          What each status is called and the colour it is drawn in. A status this table has never
          heard of is not hidden — it renders grey with its raw label and raises a notice on every
          screen it appears on.
        </p>
      </div>
      <FinanceState
        loading={state.loading}
        error={state.error}
        unavailable={state.unavailable}
        endpoint="/api/finance/settings"
        what="The status map"
        empty={rows.length === 0}
        emptyLabel="The status map has no rows, so the built-in vocabulary is in use."
        onRetry={state.reload}
      >
        {byDirection.map((group) => (
          <div key={group.direction}>
            <h3 className="fin-section-title">{group.direction}</h3>
            <div className="fin-table-wrap">
              <table className="fin-table" role="table">
                <caption className="visually-hidden">
                  {group.direction} statuses, {plural(group.rows.length, "row")}
                </caption>
                <thead>
                  <tr role="row">
                    <th scope="col" role="columnheader">
                      Key
                    </th>
                    <th scope="col" role="columnheader">
                      Shown as
                    </th>
                    <th scope="col" role="columnheader">
                      Colour
                    </th>
                    <th scope="col" role="columnheader">
                      Preview
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row) => (
                    <tr role="row" key={`${group.direction}-${row.statusKey}`}>
                      <th scope="row" role="rowheader" data-label="Key">
                        <code>{row.statusKey}</code>
                      </th>
                      <td role="cell" data-label="Shown as">
                        <input
                          type="text"
                          value={row.displayLabel ?? ""}
                          aria-label={`Label for ${row.statusKey}`}
                          onChange={(event) =>
                            update(row.statusKey, { displayLabel: event.target.value })
                          }
                        />
                      </td>
                      <td role="cell" data-label="Colour">
                        <input
                          type="color"
                          /* The one grey §5 names for a status nothing knows, from `model.ts`
                             rather than typed again here. */
                          value={row.colourHex ?? UNMAPPED_STATUS_COLOUR}
                          aria-label={`Colour for ${row.statusKey}`}
                          onChange={(event) =>
                            update(row.statusKey, { colourHex: event.target.value })
                          }
                        />
                      </td>
                      <td role="cell" data-label="Preview">
                        <span
                          className="fin-tile__rule"
                          style={{ background: presentStatus(row.statusKey, rows).tone }}
                          aria-hidden="true"
                        />
                        <span>{presentStatus(row.statusKey, rows).label}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
        <div className="fin-actions fin-actions--end">
          <button
            type="button"
            className="fin-button fin-button--primary"
            disabled={busy || draft === null}
            onClick={() => {
              void onSave({ statusMap: rows }, "Status map saved.").then((result) => {
                if (result.ok) setDraft(null);
              });
            }}
          >
            Save the status map
          </button>
        </div>
      </FinanceState>
    </section>
  );
}

/* ── §16: bank accounts ───────────────────────────────────────────────────── */

function BankAccountCard({
  accounts,
  state,
  canSee,
  busy,
  onSave,
}: {
  accounts: BankAccountRow[];
  state: { loading: boolean; error: string | null; unavailable: boolean; reload: () => void };
  canSee: boolean;
  busy: boolean;
  onSave: (
    body: Record<string, unknown>,
    said: string,
  ) => Promise<{ ok: boolean; payload: Record<string, unknown> | null }>;
}) {
  const [label, setLabel] = useState("");
  const [bankName, setBankName] = useState("");
  const [sortCode, setSortCode] = useState("");
  const [accountNumber, setAccountNumber] = useState("");

  return (
    <section className="fin-card">
      <div className="fin-card__head">
        <h2>Bank accounts</h2>
        <p className="fin-card__note">
          The accounts a payment run debits. They are typed here and held nowhere else — never in
          code, and never in this repository.
        </p>
      </div>
      <FinanceState
        loading={state.loading}
        error={state.error}
        unavailable={state.unavailable}
        endpoint="/api/finance/settings"
        what="Bank accounts"
        empty={accounts.length === 0}
        emptyLabel="No bank account has been recorded. A payment run needs one before it can export a bank file."
        onRetry={state.reload}
      >
        {canSee ? null : (
          <p className="fin-card__note">
            You are not a workspace owner, so the sort code and account number below arrived
            from the server already reduced to their last four digits. There is nothing on this
            screen that could un-mask them — the full digits were never sent to this browser —
            and a change to a bank account is refused for the same reason.
          </p>
        )}
        <ul className="fin-unbilled__list">
          {accounts.map((account) => (
            <li className="fin-unbilled__job" key={account.id}>
              <span>
                <strong>{account.label}</strong>
                {account.bankName ? ` · ${account.bankName}` : ""}
                {account.accountName ? ` · ${account.accountName}` : ""}
              </span>
              <span className="fin-masked">
                {account.sortCode ?? "—"} · {account.accountNumber ?? "—"}
              </span>
            </li>
          ))}
        </ul>
        {canSee ? (
          <div className="fin-form">
            <div className="fin-form__grid">
              <Field label="Label" hint="What a payment run calls this account.">
                <input
                  type="text"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  autoComplete="off"
                />
              </Field>
              <Field label="Bank">
                <input
                  type="text"
                  value={bankName}
                  onChange={(event) => setBankName(event.target.value)}
                  autoComplete="off"
                />
              </Field>
              <Field label="Sort code">
                <input
                  type="text"
                  value={sortCode}
                  onChange={(event) => setSortCode(event.target.value)}
                  autoComplete="off"
                />
              </Field>
              <Field label="Account number">
                <input
                  type="text"
                  value={accountNumber}
                  onChange={(event) => setAccountNumber(event.target.value)}
                  autoComplete="off"
                />
              </Field>
            </div>
            <div className="fin-actions fin-actions--end">
              <button
                type="button"
                className="fin-button fin-button--primary"
                disabled={busy || label.trim().length === 0}
                onClick={() => {
                  void onSave(
                    {
                      bankAccount: {
                        label: label.trim(),
                        bankName: bankName.trim() || undefined,
                        sortCode: sortCode.trim() || undefined,
                        accountNumber: accountNumber.trim() || undefined,
                      },
                    },
                    "Bank account saved.",
                  ).then((result) => {
                    if (!result.ok) return;
                    setLabel("");
                    setBankName("");
                    setSortCode("");
                    setAccountNumber("");
                  });
                }}
              >
                Save the account
              </button>
            </div>
          </div>
        ) : null}
      </FinanceState>
    </section>
  );
}

/* ── §15.13: the retainer that remembers itself ───────────────────────────── */

function RecurringCard({
  rules,
  frequencies,
  state,
  onNotify,
  onChanged,
}: {
  rules: RecurringRule[];
  frequencies: string[];
  state: { loading: boolean; error: string | null; unavailable: boolean; reload: () => void };
  onNotify: (message: string) => void;
  onChanged: () => void;
}) {
  const write = useFinanceWrite();
  const [done, setDone] = useState<string | null>(null);
  const [direction, setDirection] = useState("receivable");
  const [counterparty, setCounterparty] = useState("");
  const [description, setDescription] = useState("");
  const [net, setNet] = useState("");
  const [frequency, setFrequency] = useState("monthly");
  const [dayOfMonth, setDayOfMonth] = useState("1");

  return (
    <section className="fin-card">
      <div className="fin-card__head">
        <h2>Recurring invoices</h2>
        <p className="fin-card__note">
          The monthly retainer generates on a schedule rather than being remembered by somebody.
        </p>
      </div>
      <Refusal message={write.error} />
      <Confirmation message={done} />
      <FinanceState
        loading={state.loading}
        error={state.error}
        unavailable={state.unavailable}
        endpoint="/api/finance/recurring"
        what="Recurring rules"
        empty={Boolean(state) && rules.length === 0}
        emptyLabel="No recurring rule is set up."
        onRetry={state.reload}
      >
        <ul className="fin-unbilled__list">
          {rules.map((rule) => (
            <li className="fin-unbilled__job" key={rule.id}>
              <span>
                <strong>{rule.description ?? rule.id}</strong> · {rule.direction} · {rule.frequency}{" "}
                on day {rule.dayOfMonth}
                {rule.nextRunDate ? ` · next ${dayText(rule.nextRunDate)}` : ""}
                {rule.active ? "" : " · paused"}
              </span>
              <span>
                <Money pence={rule.netPence} />{" "}
                <button
                  type="button"
                  className="fin-link-button"
                  disabled={write.busy}
                  onClick={() => {
                    void write
                      .run("/api/finance/recurring", {
                        method: "PATCH",
                        body: { id: rule.id, active: !rule.active },
                      })
                      .then((result) => {
                        if (!result.ok) return;
                        const said = rule.active ? "Rule paused." : "Rule resumed.";
                        setDone(said);
                        onNotify(said);
                        onChanged();
                      });
                  }}
                >
                  {rule.active ? "Pause" : "Resume"}
                </button>
              </span>
            </li>
          ))}
        </ul>
      </FinanceState>

      {state.unavailable ? null : (
        <div className="fin-form">
          <div className="fin-form__grid">
            <Field label="Direction">
              <select value={direction} onChange={(event) => setDirection(event.target.value)}>
                {INVOICE_DIRECTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Counterparty">
              <input
                type="text"
                value={counterparty}
                onChange={(event) => setCounterparty(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label="Description">
              <input
                type="text"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <MoneyField label="Net each time" value={net} onChange={setNet} />
            <Field label="Frequency">
              <select value={frequency} onChange={(event) => setFrequency(event.target.value)}>
                {frequencies.map((option) => (
                  <option key={option} value={option}>
                    {option.charAt(0).toUpperCase() + option.slice(1)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Day of the month">
              <input
                type="number"
                min={1}
                max={28}
                value={dayOfMonth}
                onChange={(event) => setDayOfMonth(event.target.value)}
              />
            </Field>
          </div>
          <div className="fin-actions fin-actions--end">
            <button
              type="button"
              className="fin-button fin-button--primary"
              disabled={write.busy || fieldPence(net) === null}
              onClick={() => {
                void write
                  .run("/api/finance/recurring", {
                    method: "POST",
                    body: {
                      direction,
                      counterpartyId: counterparty || undefined,
                      description: description || undefined,
                      netPence: fieldPence(net),
                      frequency,
                      dayOfMonth: Math.trunc(Number(dayOfMonth) || 1),
                    },
                  })
                  .then((result) => {
                    if (!result.ok) return;
                    setDone("Recurring rule added.");
                    onNotify("Recurring rule added.");
                    setDescription("");
                    setNet("");
                    onChanged();
                  });
              }}
            >
              <Icon name="plus" size={14} aria-hidden="true" /> Add the rule
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
