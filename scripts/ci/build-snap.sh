#!/usr/bin/env bash
set -euo pipefail

ci_user="$(id -un)"
snapcraft_channel="${SNAPCRAFT_CHANNEL:-stable}"

run_snap_store_command() {
    local max_attempts="${SNAP_STORE_RETRIES:-3}"
    local attempt=1
    local status=0
    local output=""

    while true; do
        echo "+ $*"
        set +e
        output="$("$@" 2>&1)"
        status=$?
        set -e
        printf '%s\n' "${output}"

        if [ "${status}" -eq 0 ]; then
            return 0
        fi

        if [ "${attempt}" -ge "${max_attempts}" ]; then
            return "${status}"
        fi

        if ! printf '%s\n' "${output}" | grep -Eiq 'unable to contact snap store|cannot communicate with server|temporarily unavailable|timeout|connection'; then
            return "${status}"
        fi

        echo "::warning::Snap store command failed on attempt ${attempt}/${max_attempts}; retrying."
        sleep "$((attempt * 10))"
        attempt="$((attempt + 1))"
    done
}

sudo groupadd --force --system lxd
sudo usermod --append --groups lxd "${ci_user}"

if snap list lxd >/dev/null 2>&1; then
    run_snap_store_command sudo snap refresh lxd
else
    run_snap_store_command sudo snap install lxd
fi

sudo lxd init --auto
if command -v iptables >/dev/null 2>&1; then
    sudo iptables -P FORWARD ACCEPT || true
fi

if snap list snapcraft >/dev/null 2>&1; then
    run_snap_store_command sudo snap refresh --channel "${snapcraft_channel}" snapcraft
else
    run_snap_store_command sudo snap install --channel "${snapcraft_channel}" --classic snapcraft
fi

run_snap_store_command sudo -u "${ci_user}" -E snapcraft --enable-manifest

snap_path="$(find . -maxdepth 1 -type f -name '*.snap' | sort | tail -n 1)"
if [ -z "${snap_path}" ]; then
    echo "::error::Snap build finished without producing a .snap artifact." >&2
    exit 1
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'snap=%s\n' "${snap_path}" >> "${GITHUB_OUTPUT}"
fi

echo "Built snap: ${snap_path}"
