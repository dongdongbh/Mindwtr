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
default_analytics_heartbeat_url="https://mindwtr-analytics.mindwtr.workers.dev/"
analytics_heartbeat_url="${ANALYTICS_HEARTBEAT_URL:-${default_analytics_heartbeat_url}}"

manifest_path="${flathub_dir}/tech.dongdongbh.mindwtr.yml"
node_sources_path="${flathub_dir}/tech.dongdongbh.mindwtr.node-sources.json"
cargo_sources_path="${flathub_dir}/tech.dongdongbh.mindwtr.cargo-sources.json"
node_generator="${FLATPAK_NODE_GENERATOR:-flatpak-node-generator}"

required_paths=(
  "apps/desktop/package.json"
  "apps/desktop/package-lock.json"
  "packages/core/package.json"
  "packages/core/package-lock.json"
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

python3 - "${manifest_path}" "${upstream_commit}" "${analytics_heartbeat_url}" <<'PY'
from pathlib import Path
import re
import sys

manifest_path = Path(sys.argv[1])
commit = sys.argv[2]
heartbeat_url = sys.argv[3]
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

lines = updated.splitlines()
env_line_index = next((index for index, line in enumerate(lines) if line.strip() == 'env:'), None)
if env_line_index is None:
    raise SystemExit(f"Expected build-options env block in {manifest_path}")

env_indent = len(lines[env_line_index]) - len(lines[env_line_index].lstrip())
entry_indent = env_indent + 2
block_end_index = len(lines)
for index in range(env_line_index + 1, len(lines)):
    stripped = lines[index].strip()
    if not stripped:
        continue
    indent = len(lines[index]) - len(lines[index].lstrip())
    if indent <= env_indent:
        block_end_index = index
        break

heartbeat_line = f"{' ' * entry_indent}VITE_ANALYTICS_HEARTBEAT_URL: {heartbeat_url}"
for index in range(env_line_index + 1, block_end_index):
    if lines[index].lstrip().startswith('VITE_ANALYTICS_HEARTBEAT_URL:'):
        lines[index] = heartbeat_line
        break
else:
    lines.insert(env_line_index + 1, heartbeat_line)

manifest_path.write_text("\n".join(lines) + "\n")
PY

worktree_dir="$(mktemp -d)"

cleanup() {
  git -C "${repo_root}" worktree remove --force "${worktree_dir}" >/dev/null 2>&1 || true
  rm -rf "${worktree_dir}"
}

trap cleanup EXIT

git -C "${repo_root}" worktree add --force --detach "${worktree_dir}" "${upstream_commit}" >/dev/null

node "${repo_root}/scripts/ci/check-package-lock-sync.js" \
  "${worktree_dir}/apps/desktop/package.json" \
  "${worktree_dir}/apps/desktop/package-lock.json"

node "${repo_root}/scripts/ci/check-package-lock-sync.js" \
  "${worktree_dir}/packages/core/package.json" \
  "${worktree_dir}/packages/core/package-lock.json"

python3 "${repo_root}/scripts/ci/repair-package-lock.py" \
  --check \
  "${worktree_dir}/apps/desktop/package-lock.json"

python3 "${repo_root}/scripts/ci/repair-package-lock.py" \
  --check \
  "${worktree_dir}/packages/core/package-lock.json"

python3 "${tools_dir}/cargo/flatpak-cargo-generator.py" \
  "${worktree_dir}/apps/desktop/src-tauri/Cargo.lock" \
  -o "${cargo_sources_path}"

# Recursive mode walks base.parent, so this synthetic root path makes the
# generator scan both workspace lockfiles from the checkout root.
"${node_generator}" npm \
  "${worktree_dir}/package-lock.json" \
  -r \
  -R "apps/desktop/package-lock.json" \
  -R "packages/core/package-lock.json" \
  -o "${node_sources_path}"

echo "Updated Flathub checkout in ${flathub_dir} for ${ref} (${upstream_commit})"
