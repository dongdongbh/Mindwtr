#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
package_dir="${repo_root}/apps/mobile"

for attempt in 1 2 3; do
    if npm ci \
        --workspaces=false \
        --legacy-peer-deps \
        --no-audit \
        --no-fund \
        --fetch-retries=5 \
        --fetch-retry-mintimeout=2000 \
        --fetch-retry-maxtimeout=30000 \
        --prefix "${package_dir}"; then


        bash "${repo_root}/scripts/ci/apply_bun_patches.sh" "${package_dir}/node_modules"
        exit 0
    fi

    if [ "${attempt}" -eq 3 ]; then
        exit 1
    fi

    echo "Retrying mobile dependency install after transient npm failure (attempt ${attempt}/3)." >&2
    sleep $((attempt * 5))
done
