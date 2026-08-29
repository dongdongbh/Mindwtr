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
default_analytics_heartbeat_url="https://analytics.mindwtr.app/"
analytics_heartbeat_url="${ANALYTICS_HEARTBEAT_URL:-${default_analytics_heartbeat_url}}"
analytics_release_version="${VITE_ANALYTICS_RELEASE_VERSION:-${ref}}"
dropbox_app_key="${VITE_DROPBOX_APP_KEY:-}"
feedback_endpoint_url="${VITE_FEEDBACK_ENDPOINT_URL:-}"
manifest_only="${MINDWTR_FLATHUB_MANIFEST_ONLY:-0}"

manifest_path="${flathub_dir}/tech.dongdongbh.mindwtr.yml"
node_sources_path="${flathub_dir}/tech.dongdongbh.mindwtr.node-sources.json"
cargo_sources_path="${flathub_dir}/tech.dongdongbh.mindwtr.cargo-sources.json"
node_generator="${FLATPAK_NODE_GENERATOR:-flatpak-node-generator}"
shared_modules_dir="${flathub_dir}/shared-modules"
appindicator_module_path="${shared_modules_dir}/libayatana-appindicator/libayatana-appindicator-gtk3.json"

required_paths=(
  "apps/desktop/package.json"
  "apps/desktop/package-lock.json"
  "packages/core/package.json"
  "packages/core/package-lock.json"
  "apps/desktop/src-tauri/Cargo.lock"
  "apps/desktop/src-tauri/linux/Mindwtr.metainfo.xml"
  "apps/desktop/src-tauri/linux/tech.dongdongbh.mindwtr.desktop"
)

if [ "${manifest_only}" != "1" ]; then
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

if [ ! -f "${appindicator_module_path}" ]; then
  if git -C "${flathub_dir}" config --file .gitmodules --get submodule.shared-modules.path >/dev/null 2>&1; then
    git -C "${flathub_dir}" submodule update --init --recursive shared-modules
  elif [ ! -e "${shared_modules_dir}" ]; then
    git -C "${flathub_dir}" submodule add https://github.com/flathub/shared-modules.git shared-modules
  fi
fi

if [ ! -f "${appindicator_module_path}" ]; then
  echo "Missing Flathub shared module: ${appindicator_module_path}" >&2
  exit 1
fi

if ! command -v "${node_generator}" >/dev/null 2>&1; then
  echo "Missing node generator command: ${node_generator}" >&2
  exit 1
fi

upstream_commit="$(git -C "${repo_root}" rev-parse "${ref}^{commit}")"
else
  if ! [[ "${ref}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Manifest-only mode requires a full 40-character commit ref" >&2
    exit 1
  fi
  if [ ! -f "${manifest_path}" ]; then
    echo "Missing Flathub manifest: ${manifest_path}" >&2
    exit 1
  fi
  upstream_commit="${ref}"
fi

python3 - "${manifest_path}" "${upstream_commit}" "${analytics_heartbeat_url}" "${analytics_release_version}" "${dropbox_app_key}" "${feedback_endpoint_url}" <<'PY'
from pathlib import Path
import re
import sys

manifest_path = Path(sys.argv[1])
commit = sys.argv[2]
heartbeat_url = sys.argv[3]
release_version = sys.argv[4]
dropbox_app_key = sys.argv[5]
feedback_endpoint_url = sys.argv[6]
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

workspace_protocol_pattern = re.compile(
    r'^(?P<indent>[ \t]*)if requested_spec\.startswith\(\("file:", "workspace:", "git\+", "github:", "http:", "https:", "link:", "npm:"\)\):\n'
    r'(?P=indent)    continue\n'
    r'(?P=indent)locked = packages\.get\(f"node_modules/\{dependency_name\}"\)$',
    flags=re.MULTILINE,
)

def workspace_protocol_block(indent: str) -> str:
    block = [
        'locked = packages.get(f"node_modules/{dependency_name}")',
        'if requested_spec.startswith("workspace:"):',
        '    locked_resolved = locked.get("resolved") if isinstance(locked, dict) else None',
        '    if (',
        '        not isinstance(locked, dict)',
        '        or locked.get("link") is not True',
        '        or not isinstance(locked_resolved, str)',
        '        or not locked_resolved',
        '        or Path(locked_resolved).is_absolute()',
        '    ):',
        '        raise SystemExit(',
        '            f"Expected a relative package-lock link for workspace dependency {dependency_name}"',
        '        )',
        '    checkout_root = Path.cwd().resolve()',
        '    dependency_path = (package_path.parent / locked_resolved).resolve()',
        '    if dependency_path != checkout_root and checkout_root not in dependency_path.parents:',
        '        raise SystemExit(',
        '            f"Workspace dependency {dependency_name} resolves outside the source checkout"',
        '        )',
        '    local_spec = f"file:{locked_resolved}"',
        '    section[dependency_name] = local_spec',
        '    synced_specs.append(',
        '        f"{section_name}:{dependency_name}:{requested_spec}->{local_spec}"',
        '    )',
        '    continue',
        'if requested_spec.startswith(("file:", "git+", "github:", "http:", "https:", "link:", "npm:")):',
        '    continue',
    ]
    return '\n'.join(f'{indent}{line}' for line in block)

def replace_workspace_protocol(match: re.Match[str]) -> str:
    return workspace_protocol_block(match.group('indent'))

updated, _workspace_protocol_count = workspace_protocol_pattern.subn(
    replace_workspace_protocol,
    updated,
    count=1,
)
workspace_markers = list(re.finditer(
    r'^(?P<indent>[ \t]*)if requested_spec\.startswith\("workspace:"\):$',
    updated,
    flags=re.MULTILINE,
))
workspace_block_is_canonical = (
    len(workspace_markers) == 1
    and workspace_protocol_block(workspace_markers[0].group('indent')) in updated
)
if not workspace_block_is_canonical:
    raise SystemExit(f"Could not find the desktop workspace dependency repair block in {manifest_path}")

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

def remove_patch_source(path: str) -> None:
    index = 0
    while index < len(lines):
        if lines[index].strip() != '- type: patch':
            index += 1
            continue
        indent = len(lines[index]) - len(lines[index].lstrip())
        block_end_index = find_block_end(index, indent)
        block = [line.strip() for line in lines[index:block_end_index]]
        if f'path: {path}' in block:
            del lines[index:block_end_index]
            continue
        index += 1

remove_patch_source('appstream-homepage.patch')

appindicator_module = "shared-modules/libayatana-appindicator/libayatana-appindicator-gtk3.json"
appindicator_module_entry = f"- {appindicator_module}"
lines = [line for line in lines if line.strip() != appindicator_module_entry]

modules_line_index = next((index for index, line in enumerate(lines) if line.strip() == 'modules:'), None)
if modules_line_index is None:
    raise SystemExit(f"Expected modules block in {manifest_path}")

modules_indent = len(lines[modules_line_index]) - len(lines[modules_line_index].lstrip())
modules_entry_indent = modules_indent + 2
modules_block_end_index = find_block_end(modules_line_index, modules_indent)
mindwtr_module_index = next(
    (
        index
        for index in range(modules_line_index + 1, modules_block_end_index)
        if lines[index].strip() == '- name: mindwtr'
    ),
    None,
)
if mindwtr_module_index is None:
    raise SystemExit(f"Expected mindwtr module in {manifest_path}")

lines.insert(mindwtr_module_index, f"{' ' * modules_entry_indent}{appindicator_module_entry}")

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
ensure_finish_arg('--talk-name=org.freedesktop.Notifications', after='--share=network')
ensure_finish_arg('--talk-name=org.kde.StatusNotifierWatcher', after='--talk-name=org.freedesktop.Notifications')
ensure_finish_arg('--talk-name=org.gnome.evolution.dataserver.Calendar8', after='--talk-name=org.kde.StatusNotifierWatcher')
ensure_finish_arg('--talk-name=org.gnome.evolution.dataserver.Sources5', after='--talk-name=org.gnome.evolution.dataserver.Calendar8')
ensure_finish_arg('--talk-name=org.gnome.evolution.dataserver.Subprocess.Backend.*', after='--talk-name=org.gnome.evolution.dataserver.Sources5')
# org.freedesktop.portal.* talk-names are intentionally not added:
# portals are allowed by Flatpak by default and Flathub lints manual entries.

env_line_index = next((index for index, line in enumerate(lines) if line.strip() == 'env:'), None)
if env_line_index is None:
    raise SystemExit(f"Expected build-options env block in {manifest_path}")

env_indent = len(lines[env_line_index]) - len(lines[env_line_index].lstrip())
entry_indent = env_indent + 2
block_end_index = find_block_end(env_line_index, env_indent)

env_values: dict[str, str] = {}
env_order: list[str] = []

def remember_env_value(name: str, value: str) -> None:
    if name not in env_values:
        env_order.append(name)
    env_values[name] = value

def normalize_env_scalar(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value

for line in lines[env_line_index + 1:block_end_index]:
    stripped = line.strip()
    if not stripped:
        continue
    if stripped.startswith('- '):
        assignment = stripped[2:].strip()
        if '=' in assignment:
            name, value = assignment.split('=', 1)
            if name:
                remember_env_value(name, value)
        continue
    if ':' in stripped:
        name, value = stripped.split(':', 1)
        if name:
            remember_env_value(name, normalize_env_scalar(value))

def set_env_value(name: str, value: str) -> None:
    remember_env_value(name, value)

def remove_env_value(name: str) -> None:
    env_values.pop(name, None)
    while name in env_order:
        env_order.remove(name)

set_env_value('VITE_ANALYTICS_HEARTBEAT_URL', heartbeat_url)
set_env_value('VITE_ANALYTICS_RELEASE_VERSION', release_version)
set_env_value('VITE_DONATION_PROMPT_ENABLED', 'true')
if dropbox_app_key:
    set_env_value('VITE_DROPBOX_APP_KEY', dropbox_app_key)
else:
    remove_env_value('VITE_DROPBOX_APP_KEY')
# The in-app feedback form is disabled at build time without this URL; the
# release workflows export it, so forward it like the Dropbox key.
if feedback_endpoint_url:
    set_env_value('VITE_FEEDBACK_ENDPOINT_URL', feedback_endpoint_url)
else:
    remove_env_value('VITE_FEEDBACK_ENDPOINT_URL')

lines[env_line_index + 1:block_end_index] = [
    f"{' ' * entry_indent}- {name}={env_values[name]}"
    for name in env_order
    if name in env_values
]

manifest_path.write_text("\n".join(lines) + "\n")
PY

if [ "${manifest_only}" = "1" ]; then
  echo "Updated Flathub manifest fixture in ${flathub_dir} for ${upstream_commit}"
  exit 0
fi

rm -f "${flathub_dir}/appstream-homepage.patch"

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

python3 - "${worktree_dir}/apps/desktop/package.json" "${worktree_dir}/apps/desktop/package-lock.json" <<'PY'
import json
from pathlib import Path
import sys

package_path = Path(sys.argv[1])
lock_path = Path(sys.argv[2])
package = json.loads(package_path.read_text())
lock = json.loads(lock_path.read_text())
packages = lock.get("packages")
if not isinstance(packages, dict):
    raise SystemExit(f"Missing packages map in {lock_path}")

checkout_root = package_path.parents[2].resolve()
converted = []
for section_name in ("dependencies", "devDependencies", "optionalDependencies"):
    section = package.get(section_name)
    if not isinstance(section, dict):
        continue
    for dependency_name, requested_spec in list(section.items()):
        if not isinstance(requested_spec, str) or not requested_spec.startswith("workspace:"):
            continue
        locked = packages.get(f"node_modules/{dependency_name}")
        locked_resolved = locked.get("resolved") if isinstance(locked, dict) else None
        if (
            not isinstance(locked, dict)
            or locked.get("link") is not True
            or not isinstance(locked_resolved, str)
            or not locked_resolved
            or Path(locked_resolved).is_absolute()
        ):
            raise SystemExit(
                f"Expected a relative package-lock link for workspace dependency {dependency_name}"
            )
        dependency_path = (package_path.parent / locked_resolved).resolve()
        if dependency_path != checkout_root and checkout_root not in dependency_path.parents:
            raise SystemExit(
                f"Workspace dependency {dependency_name} resolves outside the source checkout"
            )
        local_spec = f"file:{locked_resolved}"
        section[dependency_name] = local_spec
        converted.append(f"{section_name}:{dependency_name}:{requested_spec}->{local_spec}")

if converted:
    package_path.write_text(json.dumps(package, indent=2) + "\n")
    print("Prepared workspace dependencies for isolated Flathub npm validation:")
    for item in converted:
        print(f"  - {item}")
PY

npm ci \
  --prefix="${worktree_dir}/apps/desktop" \
  --package-lock-only \
  --ignore-scripts \
  --legacy-peer-deps \
  --workspaces=false \
  --no-audit \
  --no-fund

if ! git -C "${worktree_dir}" diff --quiet -- apps/desktop/package-lock.json; then
  echo "Isolated Flathub npm validation changed apps/desktop/package-lock.json" >&2
  git -C "${worktree_dir}" diff -- apps/desktop/package-lock.json >&2
  exit 1
fi

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
