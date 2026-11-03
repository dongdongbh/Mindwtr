#!/usr/bin/env bash


set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
modules_dir="${1:-${repo_root}/apps/mobile/node_modules}"

if [ ! -d "${modules_dir}" ]; then
    echo "ERROR: node_modules not found at ${modules_dir}" >&2
    exit 1
fi

status=0
while IFS=$'\t' read -r key patch_file; do
    name="${key%@*}"
    version="${key##*@}"
    patch_path="${repo_root}/${patch_file}"
    if [ ! -f "${patch_path}" ]; then
        echo "ERROR: patch file missing: ${patch_file}" >&2
        status=1
        continue
    fi


    found=0
    while IFS= read -r pkg_json; do
        pkg_dir="$(dirname "${pkg_json}")"
        installed="$(node -p "require(process.argv[1]).version" "${pkg_json}")"
        if [ "${installed}" != "${version}" ]; then
            echo "ERROR: ${name} at ${pkg_dir} is ${installed}, patch targets ${version}" >&2
            status=1
            continue
        fi
        found=1
        if patch -p1 -d "${pkg_dir}" --dry-run --reverse --force < "${patch_path}" >/dev/null 2>&1; then
            echo "ok ${key}: already applied at ${pkg_dir}"
        elif patch -p1 -d "${pkg_dir}" --force --no-backup-if-mismatch < "${patch_path}"; then
            echo "patched ${key} at ${pkg_dir}"
        else
            echo "ERROR: patch failed for ${key} at ${pkg_dir}" >&2
            status=1
        fi
    done < <(find "${modules_dir}" -path "*/node_modules/${name}/package.json" 2>/dev/null)

    if [ "${found}" -eq 0 ]; then
        echo "skip ${key}: not installed under ${modules_dir}"
    fi
done < <(node -e '
    const pkg = require(process.argv[1]);
    for (const [key, file] of Object.entries(pkg.patchedDependencies ?? {})) {
        process.stdout.write(`${key}\t${file}\n`);
    }
' "${repo_root}/package.json" | sort -u)

exit "${status}"
