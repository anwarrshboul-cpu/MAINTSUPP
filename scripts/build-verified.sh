#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${SITES_ENV_READY:-}" != "1" ]]; then
  exec "${script_dir}/sites-env.sh" -- "$0" "$@"
fi

timeout_bin="$(command -v timeout || true)"
[[ -n "${timeout_bin}" ]] || {
  echo "build-verified.sh requires GNU timeout." >&2
  exit 69
}

vinext="${SITES_PROJECT_ROOT}/node_modules/.bin/vinext"
if [[ ! -x "${vinext}" ]]; then
  echo "vinext is unavailable. Run npm run install:ci and wait for it to finish before building." >&2
  exit 69
fi

# `cloudflare:workers` is a workerd-only module and the deployment target is
# Node on Vercel. Without this flag the bundle keeps eight live
# `import("cloudflare:workers")` calls, and every one of them throws
# ERR_UNSUPPORTED_ESM_URL_SCHEME the first time a route touches the database —
# so login, the board and the public forms all 5xx while the build itself
# reports success. The flag resolves the module to db/node-workers-env.ts.
# vercel/build-output.mjs re-checks this; see the note there.
export D1_NODE_SHIM=1

echo "Running bounded vinext build..."
"${timeout_bin}" \
  --signal=TERM \
  --kill-after="${SITES_BUILD_KILL_AFTER:-10s}" \
  "${SITES_BUILD_TIMEOUT:-3m}" \
  "${vinext}" build

"${script_dir}/validate-artifact.sh"
