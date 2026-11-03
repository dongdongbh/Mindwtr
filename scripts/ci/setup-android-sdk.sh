#!/usr/bin/env bash
set -euo pipefail


cmdline_tools_version="${ANDROID_CMDLINE_TOOLS_VERSION:-12266719}"
cmdline_tools_short_version="${ANDROID_CMDLINE_TOOLS_SHORT_VERSION:-16.0}"


sdk_packages="${ANDROID_SDK_PACKAGES:-platform-tools}"
android_sdk_root="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-/usr/local/lib/android/sdk}}"

cmdline_tools_dir="${android_sdk_root}/cmdline-tools/${cmdline_tools_short_version}"
sdkmanager_bin="${cmdline_tools_dir}/bin/sdkmanager"
latest_cmdline_tools_dir="${android_sdk_root}/cmdline-tools/latest"
latest_source_properties="${latest_cmdline_tools_dir}/source.properties"
latest_sdkmanager_bin="${latest_cmdline_tools_dir}/bin/sdkmanager"

mkdir -p "${android_sdk_root}/cmdline-tools"

if [ ! -x "${sdkmanager_bin}" ]; then
    if [ -x "${latest_sdkmanager_bin}" ] && [ -f "${latest_source_properties}" ] && grep -Fq "Pkg.Revision=${cmdline_tools_short_version}" "${latest_source_properties}"; then
        sdkmanager_bin="${latest_sdkmanager_bin}"
    else
        archive_url="https://dl.google.com/android/repository/commandlinetools-linux-${cmdline_tools_version}_latest.zip"
        temp_dir="$(mktemp -d)"
        archive_path="${temp_dir}/commandlinetools.zip"
        trap 'rm -rf "${temp_dir}"' EXIT

        curl --http1.1 -fsSL --retry 3 --retry-all-errors --retry-delay 2 \
            --connect-timeout 30 --max-time 300 "${archive_url}" -o "${archive_path}"
        unzip -q -o "${archive_path}" -d "${temp_dir}"

        rm -rf "${cmdline_tools_dir}"
        mv "${temp_dir}/cmdline-tools" "${cmdline_tools_dir}"
        sdkmanager_bin="${cmdline_tools_dir}/bin/sdkmanager"
    fi
fi

touch "${android_sdk_root}/repositories.cfg"

export ANDROID_HOME="${android_sdk_root}"
export ANDROID_SDK_ROOT="${android_sdk_root}"
export PATH="$(dirname "${sdkmanager_bin}"):${PATH}"

if [ -n "${GITHUB_ENV:-}" ]; then
    echo "ANDROID_HOME=${android_sdk_root}" >> "${GITHUB_ENV}"
    echo "ANDROID_SDK_ROOT=${android_sdk_root}" >> "${GITHUB_ENV}"
fi

if [ -n "${GITHUB_PATH:-}" ]; then
    echo "$(dirname "${sdkmanager_bin}")" >> "${GITHUB_PATH}"
fi

printf 'y\ny\ny\ny\ny\ny\ny\ny\ny\ny\n' | "${sdkmanager_bin}" --licenses >/dev/null

for sdk_package in ${sdk_packages}; do
    "${sdkmanager_bin}" "${sdk_package}"
done

if [ -d "${android_sdk_root}/platform-tools" ]; then
    export PATH="${android_sdk_root}/platform-tools:${PATH}"
    if [ -n "${GITHUB_PATH:-}" ]; then
        echo "${android_sdk_root}/platform-tools" >> "${GITHUB_PATH}"
    fi
fi
