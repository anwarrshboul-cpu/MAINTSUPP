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
#   · a deployment belonging to any project other than `maintsupp-portal`, so a
#     stray URL from the older `maintsupp` or `website` projects cannot end up
#     behind the client's link;
#   · a deployment that is not READY, or that does not answer 200 on both the
#     landing page and the sign-in page. The alias only ever moves to something
#     that has been shown to work, which is what makes the previous deployment
#     a rollback rather than a hope.
#
# `--prod` appears nowhere in this file, and there is nothing here to make it
# appear: `vercel alias set` assigns a domain to a deployment and does not
# change that deployment's target. Verified — the deployment behind this alias
# still reports `target: preview`, and `maintsupp-portal` still reports no
# production URL at all.
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

die() { printf '\n  REFUSED: %s\n\n' "$1" >&2; exit 1; }
say() { printf '  %s\n' "$1"; }

# The alias must not be one of the production domains already in use. Belt and
# braces: the names are known, so there is no reason to rely on remembering.
case "$ALIAS" in
  maintsupp.vercel.app|maintsupp-maintsupp.vercel.app|\
  website-rho-seven-8mdd7vw83c.vercel.app|website-maintsupp.vercel.app|\
  maintsupp-portal.vercel.app)
    die "$ALIAS is a project's production domain. This script only moves a preview alias."
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

INSPECT="$(npx vercel inspect "$DEPLOYMENT" 2>&1 || true)"

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
after="$(
  npx vercel project ls 2>&1 |
    sed -e 's/\x1b\[[0-9;]*m//g' |
    awk -v p="$PROJECT" '$1 == p { print $2 }' |
    head -1 || true
)"

printf '\n  Stable client URL: https://%s  (HTTP %s)\n' "$ALIAS" "$code"
printf '  %s production URL after the change: %s\n' "$PROJECT" "${after:-could not read}"
# "--" is Vercel's own way of saying "no production deployment", which is the
# state this workflow keeps the project in. Anything that looks like a URL is
# worth stopping for; an unreadable table is worth a note and no more, because a
# warning that fires on its own parsing failure teaches people to ignore
# warnings.
if [[ "$after" == http* ]]; then
  printf '\n  WARNING: %s now reports a production URL. That is not expected from an\n' "$PROJECT"
  printf '  alias assignment — check the project before telling the client anything.\n\n'
  exit 1
fi
if [[ "$after" != "--" ]]; then
  printf '  (could not read the project table — confirm with: npx vercel project ls)\n'
fi
printf '\n  To roll back:  scripts/update-preview-alias.sh %s\n\n' "${PREVIOUS:-<previous-deployment-url>}"
