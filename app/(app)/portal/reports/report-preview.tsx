"use client";

/**
 * The combined document, on screen, from the same value the files are made of.
 *
 * This component gets a `CombinedReportPayload`, hands it to
 * `buildReportDocument()` — the same call `docx.ts`, `xlsx.ts` and `pdf.ts`
 * each make — and renders the thirteen sections that come back. It computes
 * nothing. It has no database handle, no fetch and no arithmetic: there is not
 * a `+` in this file that touches money.
 *
 * That is the whole reason the preview can be trusted. "ALL FORMAT TOTALS MUST
 * MATCH" is not a test that passes; it is a consequence of the preview being
 * unable to produce a number the exporters cannot. If a figure is on this
 * screen it is in the payload, and if it is in the payload every format shows
 * the same one.
 *
 * THE INTERNAL NOTE IS SHOWN HERE
 *
 * `sectionsFor(document, "internal")`, matching the contract's "Preview and
 * Excel only". The preview is the owner's working view of what they are about
 * to send; the Word file and the PDF are what they send. Internal content is
 * marked in the markup as well as filtered from the exports, so a reader can
 * see at a glance which lines will not leave the building.
 */

import { Fragment } from "react";
import { Icon } from "../../../components";
import type { CombinedReportPayload, DocumentKind } from "../../../lib/reporting/contract";
import {
  buildReportDocument,
  keyValuesFor,
  sectionsFor,
} from "../../../lib/exports/document-model";
import type { DocCell, DocSection } from "../../../lib/exports/document-model";

function toneClass(tone: DocCell["tone"]): string {
  return tone ? ` reports-cell--${tone}` : "";
}

function CellText({ cell }: { cell: DocCell }) {
  return (
    <span className={`reports-cell${toneClass(cell.tone)}${cell.emphasis ? " is-emphasis" : ""}`}>
      {cell.text || " "}
    </span>
  );
}

function SectionTable({ section }: { section: DocSection }) {
  const table = section.table;
  if (!table) return null;
  if (!table.rows.length) {
    return <p className="reports-empty">{section.emptyMessage}</p>;
  }
  const groupAt = new Map<number, string>();
  for (const group of table.groups ?? []) groupAt.set(group.from, group.label);

  return (
    /*
     * The scroll container is the table's own, not the page's. A thirteen or
     * sixteen column table at 390px has to move sideways somewhere, and the one
     * place it must never move is the body — a document preview that makes the
     * whole dashboard scroll horizontally has broken the dashboard.
     *
     * `tabIndex` because a region that scrolls must be reachable without a
     * pointer; the board's own tables carry the same affordance.
     */
    <div className="reports-table-scroll" tabIndex={0} role="region" aria-label={`${section.title} table`}>
      <table className="reports-table">
        <thead>
          <tr>
            {table.columns.map((column) => (
              <th key={column.key} scope="col" className={`is-${column.align}`}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((cells, index) => (
            <Fragment key={index}>
              {groupAt.has(index) && (
                <tr className="reports-table__group">
                  <th scope="colgroup" colSpan={table.columns.length}>
                    {groupAt.get(index)}
                  </th>
                </tr>
              )}
              <tr>
                {cells.map((cell, cellIndex) => (
                  <td
                    key={table.columns[cellIndex]?.key ?? cellIndex}
                    className={`is-${table.columns[cellIndex]?.align ?? "left"}`}
                    data-label={table.columns[cellIndex]?.header}
                  >
                    <CellText cell={cell} />
                  </td>
                ))}
              </tr>
            </Fragment>
          ))}
        </tbody>
        {table.totals && (
          <tfoot>
            <tr>
              {table.totals.map((cell, index) => (
                <td
                  key={table.columns[index]?.key ?? index}
                  className={`is-${table.columns[index]?.align ?? "left"}`}
                  data-label={table.columns[index]?.header}
                >
                  <CellText cell={cell} />
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function PreviewSection({ section }: { section: DocSection }) {
  const keyValues = keyValuesFor(section, "internal");
  return (
    <section className="reports-doc__section" id={`preview-${section.id}`}>
      <header className="reports-doc__section-head">
        <h3>
          <span className="reports-doc__number">{section.number}</span>
          {section.title}
        </h3>
        {section.note && <p className="reports-doc__note">{section.note}</p>}
      </header>

      {section.paragraphs.map((paragraph, index) => (
        <p className="reports-doc__paragraph" key={index}>
          {paragraph}
        </p>
      ))}

      {keyValues.length > 0 && (
        <dl className="reports-facts">
          {keyValues.map((entry) => (
            <div
              key={entry.label}
              className={`reports-facts__row${entry.audience === "internal" ? " is-internal" : ""}`}
            >
              <dt>
                {entry.label}
                {entry.audience === "internal" && (
                  <span className="reports-internal-tag" title="Shown here and in the workbook. Never written into the Word document or the PDF.">
                    Internal
                  </span>
                )}
              </dt>
              <dd className={entry.emphasis ? "is-emphasis" : undefined}>{entry.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <SectionTable section={section} />
    </section>
  );
}

export function CombinedDocumentPreview({
  payload,
  snapshot = false,
  kind = "combined",
}: {
  payload: CombinedReportPayload;
  /**
   * Whether this is the stored snapshot of a finalised document rather than a
   * fresh computation. Said on the page, because "these figures are what was
   * issued" and "these figures are what the data says today" are different
   * claims and a reader must not have to guess which they are reading.
   */
  snapshot?: boolean;
  /**
   * Which document to draw. The Report tab passes "report" and the Invoice tab
   * "invoice", so the preview on each is the file that tab exports — the same
   * `buildReportDocument` call with the same argument the exporter is given,
   * which is what stops the screen and the download disagreeing about what is
   * in the document.
   */
  kind?: DocumentKind;
}) {
  const document = buildReportDocument(payload, kind);
  const sections = sectionsFor(document, "internal");

  return (
    <article className="reports-doc" aria-label={`${document.title} preview`}>
      <header className="reports-doc__cover">
        <p className="reports-doc__eyebrow">
          <Icon name="document" size={14} />
          {snapshot ? "Issued document — stored snapshot" : "Preview — nothing has been saved"}
        </p>
        <h2>{document.title}</h2>
        <p className="reports-doc__subtitle">
          <strong>{document.clientName}</strong>
          <span>
            {document.periodLabel} · {document.periodStart} to {document.periodEnd}
          </span>
        </p>
        <p className="reports-doc__meta">
          Invoice {document.invoiceNumber} · Status {document.status} · Prepared by{" "}
          {document.organisationName} · Generated {document.generatedAt}
        </p>
        {payload.period.partialMonth && (
          <p className="reports-doc__warning">
            <Icon name="alert" size={14} />
            This period is not a whole calendar month. Fees and monthly comparisons are
            reported for the range shown, not for a full month.
          </p>
        )}
      </header>

      {document.parts.map((part) => {
        const inPart = sections.filter((section) => section.part === part.number);
        if (!inPart.length) return null;
        return (
          <div className="reports-doc__part" key={part.number}>
            <h3 className="reports-doc__part-title">{part.title}</h3>
            <p className="reports-doc__part-subtitle">{part.subtitle}</p>
            {inPart.map((section) => (
              <PreviewSection section={section} key={section.id} />
            ))}
          </div>
        );
      })}
    </article>
  );
}
