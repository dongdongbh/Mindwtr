#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <git-ref> <flathub-repo-dir> <flatpak-builder-tools-dir>" >&2
  exit 1
fi

ref="$1"
flathub_dir="$2"
tools_dir="$3"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

manifest_path="${flathub_dir}/tech.dongdongbh.mindwtr.yml"
node_sources_path="${flathub_dir}/tech.dongdongbh.mindwtr.node-sources.json"
cargo_sources_path="${flathub_dir}/tech.dongdongbh.mindwtr.cargo-sources.json"
node_generator="${FLATPAK_NODE_GENERATOR:-flatpak-node-generator}"

required_paths=(
  "apps/desktop/package.json"
  "apps/desktop/package-lock.json"
  "packages/core/package.json"
  "apps/desktop/src-tauri/Cargo.lock"
  "apps/desktop/src-tauri/linux/Mindwtr.metainfo.xml"
  "apps/desktop/src-tauri/linux/tech.dongdongbh.mindwtr.desktop"
)

for relative_path in "${required_paths[@]}"; do
  if ! git -C "${repo_root}" cat-file -e "${ref}:${relative_path}" 2>/dev/null; then
    echo "Missing required file at ${ref}:${relative_path}" >&2
    exit 1
  fi
done

if [ ! -f "${manifest_path}" ]; then
  echo "Missing Flathub manifest: ${manifest_path}" >&2
  exit 1
fi

if [ ! -f "${tools_dir}/cargo/flatpak-cargo-generator.py" ]; then
  echo "Missing cargo generator in ${tools_dir}" >&2
  exit 1
fi

if ! command -v "${node_generator}" >/dev/null 2>&1; then
  echo "Missing node generator command: ${node_generator}" >&2
  exit 1
fi

upstream_commit="$(git -C "${repo_root}" rev-parse "${ref}^{commit}")"

python3 - "${manifest_path}" "${upstream_commit}" <<'PY'
from pathlib import Path
import re
import sys

manifest_path = Path(sys.argv[1])
commit = sys.argv[2]
text = manifest_path.read_text()
updated, count = re.subn(
    r'(^\s*commit:\s*)([0-9a-f]{7,40})(\s*$)',
    lambda match: f"{match.group(1)}{commit}{match.group(3)}",
    text,
    count=1,
    flags=re.MULTILINE,
)
if count != 1:
    raise SystemExit(f"Expected to update exactly one commit line in {manifest_path}")
manifest_path.write_text(updated)
PY

worktree_dir="$(mktemp -d)"

cleanup() {
  git -C "${repo_root}" worktree remove --force "${worktree_dir}" >/dev/null 2>&1 || true
  rm -rf "${worktree_dir}"
}

trap cleanup EXIT

git -C "${repo_root}" worktree add --force --detach "${worktree_dir}" "${upstream_commit}" >/dev/null

python3 "${repo_root}/scripts/ci/repair-package-lock.py" \
  --check \
  "${worktree_dir}/apps/desktop/package-lock.json"

python3 "${tools_dir}/cargo/flatpak-cargo-generator.py" \
  "${worktree_dir}/apps/desktop/src-tauri/Cargo.lock" \
  -o "${cargo_sources_path}"

"${node_generator}" npm \
  "${worktree_dir}/apps/desktop/package-lock.json" \
  -o "${node_sources_path}"

echo "Updated Flathub checkout in ${flathub_dir} for ${ref} (${upstream_commit})"
