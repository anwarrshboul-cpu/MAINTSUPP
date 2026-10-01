/**
 * Whether a portal toast reports something that worked or something that did
 * not.
 *
 * QA: a refused action ("You do not have permission…") arrived in the same
 * toast as a success, under the same green check — so a refusal read as a
 * confirmation at a glance. The toast now carries a tone.
 *
 * The portal's own failure paths pass `"error"` explicitly. Child screens
 * report through a one-argument `onNotify(message)` — several dozen call sites
 * across many files — so a message that arrives WITHOUT a tone is classified
 * from its wording instead. Failure strings in this product are written in a
 * few forms ("could not", "failed", "permission", "must", …) and no literal
 * success `onNotify` string uses them (checked when this was written). A
 * failure worded some other way still shows — in the success tone, as before.
 */

export type ToastTone = "success" | "error";

const FAILURE_WORDING =
  /\b(could not|couldn['’]t|cannot|can['’]t|failed|failure|not allowed|not permitted|permission|denied|refused|forbidden|unauthori[sz]ed|invalid|is required|are required|not found|try again|went wrong|error|must|there is no)\b/i;

export function toastToneFor(message: string, explicit?: ToastTone): ToastTone {
  if (explicit) return explicit;
  return FAILURE_WORDING.test(message) ? "error" : "success";
}
