#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <aab|apk|foss> <output-dir>" >&2
  echo "Env: RELEASE_VERSION, RELEASE_VERSION_CODE, EXPECTED_SIGNER_SHA256, SIGNING_KEYSTORE_BASE64, SIGNING_KEY_ALIAS, SIGNING_STORE_PASSWORD, SIGNING_KEY_PASSWORD" >&2
  exit 2
}

[[ "$#" -eq 2 ]] || usage
artifact_kind="$1"
output_dir="$2"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
gradle_root="${repo_root}/apps/android-native/android"
package_name="tech.dongdongbh.mindwtr"

for required in RELEASE_VERSION RELEASE_VERSION_CODE EXPECTED_SIGNER_SHA256 SIGNING_KEYSTORE_BASE64 SIGNING_KEY_ALIAS SIGNING_STORE_PASSWORD SIGNING_KEY_PASSWORD; do
  if [[ -z "${!required:-}" ]]; then
    echo "::error::Missing ${required}" >&2
    exit 1
  fi
done
if ! [[ "${RELEASE_VERSION_CODE}" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::Invalid RELEASE_VERSION_CODE: ${RELEASE_VERSION_CODE}" >&2
  exit 1
fi

case "${artifact_kind}" in
  aab)
    gradle_task=":app:bundlePlayRelease"
    abis="arm64-v8a,armeabi-v7a"
    built="${gradle_root}/app/build/outputs/bundle/playRelease/app-play-release.aab"
    final_name="mindwtr-${RELEASE_VERSION}.aab"
    ;;
  apk)
    gradle_task=":app:assemblePlayRelease"
    abis="arm64-v8a,armeabi-v7a"
    built="${gradle_root}/app/build/outputs/apk/play/release/app-play-release.apk"
    final_name="mindwtr-${RELEASE_VERSION}.apk"
    ;;
  foss)
    gradle_task=":app:assembleFossRelease"
    abis="arm64-v8a"
    built="${gradle_root}/app/build/outputs/apk/foss/release/app-foss-release.apk"
    final_name="mindwtr-${RELEASE_VERSION}-foss.apk"
    ;;
  *) usage ;;
esac

build_tools="$(ls -d "${ANDROID_HOME:?ANDROID_HOME is not set}"/build-tools/*/ | sort -V | tail -1)"
apksigner_bin="${build_tools}apksigner"
aapt2_bin="${build_tools}aapt2"

secret_dir="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/mindwtr-signing-XXXXXX")"
trap 'rm -rf "${secret_dir}"' EXIT
chmod 700 "${secret_dir}"
keystore="${secret_dir}/release.keystore"
printf '%s' "${SIGNING_KEYSTORE_BASE64}" | base64 --decode > "${keystore}"
chmod 600 "${keystore}"

rm -f "${built}"
(
  cd "${gradle_root}"
  MINDWTR_RELEASE_KEYSTORE="${keystore}" \
  MINDWTR_RELEASE_STORE_PASSWORD="${SIGNING_STORE_PASSWORD}" \
  MINDWTR_RELEASE_KEY_ALIAS="${SIGNING_KEY_ALIAS}" \
  MINDWTR_RELEASE_KEY_PASSWORD="${SIGNING_KEY_PASSWORD}" \
    ./gradlew --no-daemon \
      "-Pmindwtr.versionCode=${RELEASE_VERSION_CODE}" \
      "-Pmindwtr.versionName=${RELEASE_VERSION}" \
      "-Pmindwtr.abis=${abis}" \
      "${gradle_task}"
)
rm -rf "${secret_dir}"

if [[ ! -s "${built}" ]]; then
  echo "Gradle did not produce ${built}" >&2
  exit 1
fi
mkdir -p "${output_dir}"
final_path="${output_dir}/${final_name}"
cp "${built}" "${final_path}"

if [[ "${artifact_kind}" == "aab" ]]; then
  jarsigner -verify "${final_path}" | grep -q "jar verified"
  certificates="$(keytool -printcert -jarfile "${final_path}")"
  signer_digests="$(sed -n 's/^[[:space:]]*SHA256: //p' <<< "${certificates}" | tr -d ':' | tr '[:upper:]' '[:lower:]' | sort -u)"
else
  certificates="$("${apksigner_bin}" verify --print-certs "${final_path}")"
  signer_digests="$(sed -n 's/^.*[Ss]igner.* certificate SHA-256 digest: //p' <<< "${certificates}" | sort -u)"
  badging="$("${aapt2_bin}" dump badging "${final_path}")"
  expected="package: name='${package_name}' versionCode='${RELEASE_VERSION_CODE}' versionName='${RELEASE_VERSION}'"
  if [[ "$(head -1 <<< "${badging}")" != "${expected}"* ]]; then
    echo "Unexpected APK identity:" >&2
    head -1 <<< "${badging}" >&2
    echo "Expected: ${expected}" >&2
    exit 1
  fi
  head -1 <<< "${badging}"
  grep "^native-code:" <<< "${badging}"
fi
echo "${certificates}"
expected_digest="$(tr -d ':' <<< "${EXPECTED_SIGNER_SHA256}" | tr '[:upper:]' '[:lower:]')"
if [[ "${signer_digests}" != "${expected_digest}" ]]; then
  echo "::error::${final_name} is signed by ${signer_digests:-nothing}, expected exactly ${expected_digest}" >&2
  exit 1
fi

bash "${repo_root}/scripts/ci/check-android-16kb-page-size.sh" "${final_path}"
if [[ "${artifact_kind}" == "foss" ]]; then
  python3 "${repo_root}/apps/mobile/scripts/verify_foss_no_google_services.py" "${final_path}"
fi
echo "Built ${final_path}"
