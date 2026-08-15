#!/usr/bin/env bash
#
# Railway entrypoint for the portal.
#
# A volume is mounted at /data and is empty the first time it is created. The
# application would happily bootstrap a fresh database into it — 48 tables and
# two seed organisations — and come up looking like a working deployment with
# nobody's data in it. That failure is quiet, and the moment anyone signs in and
# starts typing, restoring the real database on top becomes a merge.
#
# So the first boot seeds from a snapshot baked into the image, and every boot
# after it leaves the volume alone. The snapshot is deliberately NOT in git: the
# repository is public and this file is real client data. It reaches the image
# by `railway up`, which uploads from a developer's machine straight to the
# builder.
set -euo pipefail

DB_PATH="${D1_SQLITE_PATH:-/data/portal.sqlite}"
SEED_PATH="${PORTAL_SEED_PATH:-seed/portal-seed.sqlite}"

if [[ -f "${DB_PATH}" ]]; then
  echo "[start] ${DB_PATH} exists ($(stat -c %s "${DB_PATH}" 2>/dev/null || echo ?) bytes) — leaving it alone"
elif [[ -f "${SEED_PATH}" ]]; then
  mkdir -p "$(dirname "${DB_PATH}")"
  # Copy to a temporary name and rename, so a container killed mid-copy cannot
  # leave a half-written database that the next boot would treat as "exists".
  cp "${SEED_PATH}" "${DB_PATH}.seeding"
  mv "${DB_PATH}.seeding" "${DB_PATH}"
  echo "[start] seeded ${DB_PATH} from ${SEED_PATH} ($(stat -c %s "${DB_PATH}" 2>/dev/null || echo ?) bytes)"
else
  echo "[start] no database at ${DB_PATH} and no seed at ${SEED_PATH} — the app will bootstrap an EMPTY one" >&2
fi

mkdir -p "${R2_LOCAL_DIR:-/data/r2}"

exec npx vinext start
