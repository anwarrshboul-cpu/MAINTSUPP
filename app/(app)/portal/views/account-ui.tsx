"use client";

/**
 * The handful of shapes every account screen is built from.
 *
 * Kept in one place so the twelve panels behind the avatar menu look like one
 * product rather than twelve, and so `AccountEmpty` is always as easy to reach
 * for as a fabricated table would have been. An honest empty state is the
 * default here, not the fallback.
 */

import type { ReactNode } from "react";
import { Icon, type IconName } from "../../../components";
import { formatShortDateTime } from "../../../lib/format-date";

export function AccountHeading({
  eyebrow,
  title,
  lede,
  actions,
}: {
  eyebrow: string;
  title: string;
  lede?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="account-heading">
      <div>
        <span className="account-heading__eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {lede && <p>{lede}</p>}
      </div>
      {actions && <div className="account-heading__actions">{actions}</div>}
    </header>
  );
}

export function AccountCard({
  title,
  description,
  aside,
  children,
  tone,
}: {
  title?: string;
  description?: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
  /** `notice` marks a card whose whole job is to state a limitation. */
  tone?: "default" | "notice";
}) {
  return (
    <section className={`account-card${tone === "notice" ? " account-card--notice" : ""}`}>
      {(title || aside) && (
        <div className="account-card__head">
          <div>
            {title && <h2>{title}</h2>}
            {description && <p>{description}</p>}
          </div>
          {aside && <div className="account-card__aside">{aside}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * The empty state. Always says what would be here and why it is not, because
 * "nothing yet" and "this cannot happen in this product" are different facts
 * and a blank panel conflates them.
 */
export function AccountEmpty({
  icon = "inbox",
  title,
  children,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="account-empty">
      <Icon name={icon} size={22} />
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export function AccountStats({
  items,
}: {
  items: Array<{ label: string; value: ReactNode; hint?: string }>;
}) {
  return (
    <div className="account-stats">
      {items.map((item) => (
        <div key={item.label}>
          <strong>{item.value}</strong>
          <span>{item.label}</span>
          {item.hint && <small>{item.hint}</small>}
        </div>
      ))}
    </div>
  );
}

/** A yes/no fact about the runtime, rendered as a labelled state chip. */
export function AccountStatus({
  ok,
  okLabel = "Configured",
  offLabel = "Not configured",
}: {
  ok: boolean;
  okLabel?: string;
  offLabel?: string;
}) {
  return (
    <span className={`account-status account-status--${ok ? "on" : "off"}`}>
      <Icon name={ok ? "check" : "close"} size={13} />
      {ok ? okLabel : offLabel}
    </span>
  );
}

export function AccountField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="account-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

/** A loading placeholder that does not pretend to be content. */
export function AccountLoading({ label = "Loading" }: { label?: string }) {
  return (
    <p className="account-loading" role="status">
      {label}…
    </p>
  );
}

export function AccountError({ message }: { message: string }) {
  return (
    <p className="account-error" role="alert">
      <Icon name="alert" size={16} />
      {message}
    </p>
  );
}

/** Formats an ISO or SQLite timestamp for display, or says it is missing. */
export function formatMoment(value: string | null | undefined, timezone?: string) {
  if (!value) return "—";
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return formatShortDateTime(date, { timeZone: timezone || "Europe/London" });
  } catch {
    // An invalid IANA zone from a stored profile throws inside `Intl`. Falling
    // back to the ISO stamp is honest about what is known.
    return date.toISOString().slice(0, 16).replace("T", " ");
  }
}
