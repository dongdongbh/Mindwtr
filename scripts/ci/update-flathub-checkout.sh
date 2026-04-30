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
dropbox_app_key="${VITE_DROPBOX_APP_KEY:-}"

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

python3 - "${manifest_path}" "${upstream_commit}" "${analytics_heartbeat_url}" "${dropbox_app_key}" <<'PY'
from pathlib import Path
import re
import sys

manifest_path = Path(sys.argv[1])
commit = sys.argv[2]
heartbeat_url = sys.argv[3]
dropbox_app_key = sys.argv[4]
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

# Flathub rejects this custom single-instance D-Bus name in finish-args, so the
# updater must scrub any previously injected entries instead of re-adding them.
blocked_finish_args = {
    '--talk-name=org.tech_dongdongbh_mindwtr.SingleInstance',
    '--own-name=org.tech_dongdongbh_mindwtr.SingleInstance',
}
lines = [line for line in lines if line.strip() not in {f'- {value}' for value in blocked_finish_args}]

def find_block_end(start_index: int, base_indent: int) -> int:
    block_end_index = len(lines)
    for index in range(start_index + 1, len(lines)):
        stripped = lines[index].strip()
        if not stripped:
            continue
        indent = len(lines[index]) - len(lines[index].lstrip())
        if indent <= base_indent:
            block_end_index = index
            break
    return block_end_index

finish_args_line_index = next((index for index, line in enumerate(lines) if line.strip() == 'finish-args:'), None)
if finish_args_line_index is None:
    raise SystemExit(f"Expected finish-args block in {manifest_path}")

finish_args_indent = len(lines[finish_args_line_index]) - len(lines[finish_args_line_index].lstrip())
finish_args_entry_indent = finish_args_indent + 2
finish_args_block_end_index = find_block_end(finish_args_line_index, finish_args_indent)

def ensure_finish_arg(value: str, after=None) -> None:
    formatted = f"{' ' * finish_args_entry_indent}- {value}"
    existing = {
        line.strip()
        for line in lines[finish_args_line_index + 1:finish_args_block_end_index]
    }
    if f'- {value}' in existing:
        return
    insert_index = finish_args_block_end_index
    if after:
        for index in range(finish_args_line_index + 1, finish_args_block_end_index):
            if lines[index].strip() == f'- {after}':
                insert_index = index + 1
                break
    lines.insert(insert_index, formatted)

ensure_finish_arg('--socket=pulseaudio', after='--socket=wayland')

env_line_index = next((index for index, line in enumerate(lines) if line.strip() == 'env:'), None)
if env_line_index is None:
    raise SystemExit(f"Expected build-options env block in {manifest_path}")

env_indent = len(lines[env_line_index]) - len(lines[env_line_index].lstrip())
entry_indent = env_indent + 2
block_end_index = find_block_end(env_line_index, env_indent)

def set_env_value(name: str, value: str) -> None:
    env_line = f"{' ' * entry_indent}{name}: {value}"
    for index in range(env_line_index + 1, block_end_index):
        if lines[index].lstrip().startswith(f'{name}:'):
            lines[index] = env_line
            return
    lines.insert(env_line_index + 1, env_line)

def remove_env_value(name: str) -> None:
    for index in range(env_line_index + 1, block_end_index):
        if lines[index].lstrip().startswith(f'{name}:'):
            del lines[index]
            return

set_env_value('VITE_ANALYTICS_HEARTBEAT_URL', heartbeat_url)
if dropbox_app_key:
    set_env_value('VITE_DROPBOX_APP_KEY', dropbox_app_key)
else:
    remove_env_value('VITE_DROPBOX_APP_KEY')

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
