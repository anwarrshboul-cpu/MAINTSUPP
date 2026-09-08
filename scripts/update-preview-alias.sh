#!/usr/bin/env bash
#
# Point the stable client-review link at a verified Preview deployment.
#
# ---------------------------------------------------------------------------
# WHY THIS EXISTS
# ---------------------------------------------------------------------------
# Every `vercel deploy` mints a new URL — maintsupp-portal-<hash>-maintsupp
# .vercel.app — so sending the client a link after each update means sending a
# different link each time. `maintsupp-preview.vercel.app` is an alias that
# stays put; this script is how it is moved, and the reason it is a script
# rather than a line in a runbook is the set of things it refuses to do.
#
# ---------------------------------------------------------------------------
# WHAT IT REFUSES
# ---------------------------------------------------------------------------
#   · a deployment whose target is `production` — the whole point of this
#     workflow is that nothing is ever promoted;
#   · a deployment belonging to any project other than `maintsupp-portal`.
#     `maintsupp-portal` is now the ONLY project in the account — the older
#     `maintsupp`, `website` and `maintsupp-legacy-portal` were deleted on
#     2026-09-04 — so today this refusal has nothing left to catch. It stays
#     because "there is only one project" is a fact about an account, not an
#     invariant of this script, and the day a second one appears is exactly
#     the day nobody remembers to add the check back;
#   · a deployment that is not READY, or that does not answer 200 on both the
#     landing page and the sign-in page. The alias only ever moves to something
#     that has been shown to work, which is what makes the previous deployment
#     a rollback rather than a hope.
#
# `--prod` appears nowhere in this file, and there is nothing here to make it
# appear: `vercel alias set` assigns a domain to a deployment and does not
# change that deployment's target. Verified — the deployment behind this alias
# still reports `target: preview`.
#
# THE PROJECT NOW HAS A PRODUCTION URL, and that is not this script's doing.
# Two production deployments were made by hand on 2026-09-05 and the project
# reports the configured custom domain, https://maintsupp.com. The sentence
# that used to sit here said the opposite, and the check at the foot of the
# file was written to match it: any production URL at all was treated as a
# fault, so every ordinary run printed a warning and exited 1 after
# successfully moving the alias. A warning that always fires is one nobody
# reads, and an exit code that always says failure is worse.
#
# What that check watches for now is a CHANGE. The production URL is read
# before the assignment and again afterwards; the two must agree, and the value
# must be either "--" or `EXPECTED_PRODUCTION`. The gates that do the real work
# are earlier and are untouched: the deployment must belong to this project,
# its target must be `preview`, and it must answer 200 twice.
#
# No token, project id or password is stored here. Authentication is whatever
# `vercel whoami` already has.
#
# ---------------------------------------------------------------------------
# USAGE
# ---------------------------------------------------------------------------
#   scripts/update-preview-alias.sh                       # newest READY preview
#   scripts/update-preview-alias.sh <deployment-url>      # a specific one
#   ALIAS=maintsupp-client-preview.vercel.app scripts/update-preview-alias.sh
#
set -euo pipefail

PROJECT="maintsupp-portal"
ALIAS="${ALIAS:-maintsupp-preview.vercel.app}"
# The Production URL this project is EXPECTED to have. It is read, never
# written: nothing in this file can create, promote or retarget a production
# deployment. Override it on the day the domain legitimately changes, so that
# the change is stated by whoever makes it rather than discovered later.
EXPECTED_PRODUCTION="${EXPECTED_PRODUCTION:-https://maintsupp.com}"

die() { printf '\n  REFUSED: %s\n\n' "$1" >&2; exit 1; }
say() { printf '  %s\n' "$1"; }

# The project's current Production URL, or "--" when it has none, or empty when
# the table could not be read. Called once before the alias move and once after:
# a CHANGE across those two is the thing worth stopping for.
#
# `|| true` because a failed pipe under `set -e` would kill the script after the
# alias had already moved, which is the one place a spurious failure would be
# actively misleading. The CLI colourises its table, so the escape sequences
# have to come off before awk sees a column, and it prints that table to STDERR,
# so 2>&1 rather than 2>/dev/null: discarding stderr discards the answer.
production_url() {
  npx vercel project ls 2>&1 |
    sed -e 's/\x1b\[[0-9;]*m//g' |
    awk -v p="$PROJECT" '$1 == p { print $2 }' |
    head -1 || true
}


# The alias must never be one of these host names. Two different reasons, and
# both still hold after the 2026-09-04 consolidation:
#
#   · `maintsupp-portal.vercel.app` is a live project's own production domain.
#     Handing it to this script would point the client's link at the project
#     that owns it, which is not a preview alias at all.
#
#   · the other four belonged to `maintsupp` and `website`, both deleted on
#     2026-09-04. They are NOT "production domains" any more — they are worse.
#     A deleted project's `*.vercel.app` name is released, so anybody with a
#     Vercel account can now claim one. The client's link resolving to a
#     stranger's deployment is a failure mode the old wording did not even
#     describe, so the entries stay and the reason is written down.
#
# Belt and braces: the names are known, so there is no reason to rely on
# remembering them.
case "$ALIAS" in
  maintsupp.vercel.app|maintsupp-maintsupp.vercel.app|\
  website-rho-seven-8mdd7vw83c.vercel.app|website-maintsupp.vercel.app|\
  maintsupp-portal.vercel.app)
    die "$ALIAS is a project's own host name, or a released one a stranger could claim. This script only moves a preview alias."
    ;;
esac

printf '\nStable preview alias → %s\n\n' "$ALIAS"

# ---- 1. which deployment ---------------------------------------------------

DEPLOYMENT="${1:-}"
if [[ -z "$DEPLOYMENT" ]]; then
  say "No deployment given; taking the newest READY Preview from $PROJECT."
  DEPLOYMENT="$(
    npx vercel ls "$PROJECT" 2>&1 |
      grep -F '● Ready' |
      grep -F 'Preview' |
      grep -oE 'https://[a-z0-9.-]+\.vercel\.app' |
      head -1
  )"
  [[ -n "$DEPLOYMENT" ]] || die "No READY Preview deployment found in $PROJECT."
fi
DEPLOYMENT="${DEPLOYMENT%/}"
# `vercel alias ls` prints bare hosts, so the rollback hint at the end is a bare
# host. Accept one: without a scheme curl would use http, take the 308 and fail
# the smoke test for a reason that has nothing to do with the deployment.
[[ "$DEPLOYMENT" == http* ]] || DEPLOYMENT="https://${DEPLOYMENT}"
say "Deployment: $DEPLOYMENT"

# A URL from one of the older projects is rejected on sight, before any network
# call, because the host name alone is enough to know.
case "$DEPLOYMENT" in
  *maintsupp-portal-*) ;;
  *) die "$DEPLOYMENT does not look like a $PROJECT deployment." ;;
esac

# ---- 2. what Vercel says it is ---------------------------------------------

# ANSI stripped for the same reason `production_url` strips it: the CLI
# colourises this output, so `name` arrives wrapped in escape sequences and a
# `^[[:space:]]*name` pattern never matches it. The symptom is the refusal
# "That deployment belongs to 'unknown'" on a deployment that is perfectly
# valid — a gate failing open-ended rather than the deployment failing.
INSPECT="$(npx vercel inspect "$DEPLOYMENT" 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g' || true)"

NAME="$(printf '%s' "$INSPECT" | sed -n 's/^[[:space:]]*name[[:space:]]*//p' | head -1 | tr -d '[:space:]')"
TARGET="$(printf '%s' "$INSPECT" | sed -n 's/^[[:space:]]*target[[:space:]]*//p' | head -1 | tr -d '[:space:]')"

[[ "$NAME" == "$PROJECT" ]] || die "That deployment belongs to '${NAME:-unknown}', not $PROJECT."
[[ "$TARGET" == "preview" ]] || die "That deployment's target is '${TARGET:-unknown}'. Only a preview may go behind the client link."

say "Project:    $NAME"
say "Target:     $TARGET"

# ---- 3. it has to actually work --------------------------------------------
#
# The alias is the client's link. Moving it to something that 500s would take
# the client's preview down, and the previous deployment — which is known to
# work — would be gone from behind the link. So the smoke test is a gate, not a
# report.

for path in "/" "/login"; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "${DEPLOYMENT}${path}" || echo 000)"
  [[ "$code" == "200" ]] || die "GET ${path} answered ${code}. The alias has NOT been moved; the client still has the previous deployment."
  say "Smoke test: ${path} → ${code}"
done

# ---- 4. move it ------------------------------------------------------------

PREVIOUS="$(npx vercel alias ls 2>/dev/null | grep -F "$ALIAS" | awk '{print $1}' | head -1 || true)"
[[ -n "$PREVIOUS" ]] && say "Currently:  $PREVIOUS"

# Read BEFORE the assignment, so the check below compares like with like.
before="$(production_url)"
say "Production: ${before:-could not read}"

npx vercel alias set "$DEPLOYMENT" "$ALIAS" >/dev/null 2>&1 ||
  die "Vercel refused the alias assignment. Nothing changed."

# ---- 5. prove it ------------------------------------------------------------

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "https://${ALIAS}/" || echo 000)"
# THE POINT OF THIS CHECK is that an alias assignment must not have produced a
# production deployment. `|| true` because a failed pipe under `set -e` would
# kill the script after the alias had already moved — the one place a spurious
# failure would be actively misleading — and the CLI colourises its table, so
# the escape sequences have to come off before awk sees a column.
# 2>&1, not 2>/dev/null: the CLI prints this table to STDERR, so discarding
# stderr discards the answer.
after="$(production_url)"

printf '\n  Stable client URL: https://%s  (HTTP %s)\n' "$ALIAS" "$code"
printf '  %s production URL after the change: %s\n' "$PROJECT" "${after:-could not read}"
# WHAT THIS CHECK IS FOR, AND WHAT IT STOPPED BEING FOR.
#
# `vercel alias set` assigns a domain to a deployment and does not change that
# deployment's target, so a production deployment must never appear because of
# a run of this script. That is still the thing being checked.
#
# It used to be checked by asserting the project had NO production URL at all,
# which was true when this was written and is not any more. The check fired on
# every ordinary run and exited 1 after successfully moving the alias, so a
# normal update reported failure — and a warning that always fires is one
# nobody reads.
#
# What is suspicious is a CHANGE. Kept as a function of its three inputs and
# nothing else, so it can be exercised without a network, a deployment or a
# Vercel account: see tests/preview-alias-guard.test.mjs.
production_verdict() {
  local was="$1" now="$2" want="$3"

  if [[ -z "$was" || -z "$now" ]]; then
    printf '  (could not read the project table — confirm with: npx vercel project ls)\n'
    return 0
  fi

  if [[ "$now" != "$was" ]]; then
    printf '\n  WARNING: the production URL changed during this run:\n'
    printf '           before: %s\n' "$was"
    printf '           after:  %s\n' "$now"
    printf '  An alias assignment must not do that. Check the project before telling\n'
    printf '  the client anything.\n\n'
    return 1
  fi

  if [[ "$now" != "--" && "$now" != "$want" ]]; then
    printf '\n  WARNING: production URL is %s, which is neither "--" nor the expected\n' "$now"
    printf '  %s. It did not change during this run, so this script did not cause\n' "$want"
    printf '  it — but confirm the project is the one you meant.\n\n'
    return 1
  fi

  return 0
}

production_verdict "$before" "$after" "$EXPECTED_PRODUCTION" || exit 1
printf '\n  To roll back:  scripts/update-preview-alias.sh %s\n\n' "${PREVIOUS:-<previous-deployment-url>}"
