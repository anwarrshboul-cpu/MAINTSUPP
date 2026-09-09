"use client";

/**
 * Settings → Appearance — the theme control, where somebody would look for it.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE TWO CONTROLS THAT ALREADY DID
 *
 * There was a `<select>` in the topbar and a card under the avatar menu's
 * Explore section, and neither is where a person goes to change a setting: the
 * topbar one is a 15px glyph beside the workspace indicator, and the account
 * one is three clicks into a menu about the person rather than the workspace.
 * The Settings screen had a Notifications card and a Service levels card and no
 * mention of the theme at all. So this is a discoverability fix, not a third
 * implementation.
 *
 * IT IS EXPLICITLY NOT A FOURTH COPY OF THE STATE. Everything here goes
 * through `theme.ts`, which is the single store the whole app reads and the
 * only thing that writes the stored key. Before that store existed there were
 * five writers racing on every mount and the topbar could read "Light" while
 * the board's picker read "Dark" in the same document; adding a control that
 * kept its own `useState` would put that straight back.
 *
 * AND IT DELIBERATELY DOES NOT PATCH `/api/account`.
 *
 * `theme-toggle.tsx` is mounted in the topbar on every dashboard screen, this
 * one included, and it mirrors any change to `users.theme_preference` already
 * — it watches the STORE, not its own rendered value, so a change made from
 * here reaches it. Saving from here as well would send two identical PATCHes
 * for one click, which is what the account panel does and what this should not
 * copy. One writer of the row per gesture.
 *
 * It lives in `views/` rather than in `portal-app.tsx` because that file is
 * over 7,000 lines and is under an enforced size ceiling elsewhere in the
 * suite; the mount there is two lines, an import and a tag.
 */

import { Icon } from "../../../components";
import {
  type ThemeChoice,
  setThemeChoice,
  useResolvedTheme,
  useThemeChoice,
} from "../theme";
import "./appearance-panel.css";

/**
 * The three options, in the order the picker offers them.
 *
 * Dark is first because it is the DEFAULT — what an absent preference paints,
 * on a phone and on a desktop alike. The copy says so rather than leaving a
 * person to infer it, because the previous default ("the device, unless you are
 * on a phone") was invisible and generated the support question this batch is
 * answering.
 */
const CHOICES: ReadonlyArray<{
  value: ThemeChoice;
  label: string;
  icon: "moon" | "sun" | "settings";
  detail: string;
}> = [
  {
    value: "dark",
    label: "Dark",
    icon: "moon",
    detail: "The default, and what the product was designed in.",
  },
  {
    value: "light",
    label: "Light",
    icon: "sun",
    detail: "The original palette, on a white canvas.",
  },
  {
    value: "system",
    label: "System",
    icon: "settings",
    detail: "Follow whatever this device asks for, and change with it.",
  },
];

export function AppearancePanel() {
  const choice = useThemeChoice();
  /*
   * What is actually painted, which is only the same as `choice` for the two
   * explicit options. Showing it matters precisely for System: "System —
   * currently dark" is the sentence that stops somebody selecting System, seeing
   * no change on a dark device, and concluding the control is broken.
   */
  const resolved = useResolvedTheme();

  return (
    <section className="panel settings-card">
      <div className="settings-card__heading">
        <span>
          <Icon name={resolved === "dark" ? "moon" : "sun"} size={19} />
        </span>
        <div>
          <h2>Appearance</h2>
          <p>Choose how MAINTSUPP is painted on this device.</p>
        </div>
      </div>

      <div className="appearance-choices">
        {CHOICES.map((option) => (
          <button
            key={option.value}
            type="button"
            className="appearance-choice"
            /*
             * `aria-pressed` carries the selected state and the stylesheet
             * reads the same attribute, so the ring and the announcement cannot
             * drift apart. A group of buttons rather than a `<select>`: the
             * three options need a swatch and a sentence each, which an
             * `<option>` cannot hold.
             */
            aria-pressed={choice === option.value}
            onClick={() => setThemeChoice(option.value)}
          >
            <span
              className={`appearance-swatch appearance-swatch--${option.value}`}
              aria-hidden="true"
            />
            <strong>
              <Icon name={option.icon} size={15} />
              {option.label}
            </strong>
            <small>{option.detail}</small>
          </button>
        ))}
      </div>

      <p className="appearance-summary">
        {choice === "system"
          ? `Following this device, which is currently ${resolved}. Saved to your account, so it applies wherever you sign in.`
          : `${choice === "dark" ? "Dark" : "Light"} on every device. Saved to your account, so it applies wherever you sign in.`}
      </p>
    </section>
  );
}

export default AppearancePanel;
