#!/usr/bin/env bash
set -euo pipefail

ARCHS="${ARCHS:-arm64-v8a,armeabi-v7a}"
export FOSS_BUILD="${FOSS_BUILD:-0}"
PREP_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --prep-only)
      PREP_ONLY=1
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${ROOT_DIR}/../.." && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-${ROOT_DIR}/build}"
cd "$ROOT_DIR"


mkdir -p "${REPO_ROOT}/node_modules"

if [[ "${FOSS_BUILD}" == "1" && "${SKIP_FDROID_PREP:-0}" != "1" ]]; then
  ./scripts/fdroid_prep.sh
fi

if [[ "${FOSS_BUILD}" == "1" ]]; then
  export DONATION_PROMPT_ENABLED="${DONATION_PROMPT_ENABLED:-true}"
  export FEEDBACK_ENDPOINT_URL="${FEEDBACK_ENDPOINT_URL:-https://feedback.mindwtr.app}"
  node scripts/fdroid_patch_expo_application.js
fi

if [[ "${FOSS_BUILD}" == "1" && -n "${ANALYTICS_HEARTBEAT_URL:-}" && "${ANALYTICS_HEARTBEAT_DISABLED:-0}" != "1" ]]; then
  export ANALYTICS_HEARTBEAT_CHANNEL="${ANALYTICS_HEARTBEAT_CHANNEL:-fdroid}"
fi

npx expo prebuild --clean --platform android

if [[ "${FOSS_BUILD}" == "1" ]]; then
  node scripts/fdroid_patch_android_jvm_targets.js
fi

python3 - <<'PY'
from pathlib import Path

candidates = [
    Path("node_modules/react-native-alarm-notification/android/build.gradle"),
    Path("../../node_modules/react-native-alarm-notification/android/build.gradle"),
]

patched_any = False
for path in candidates:
    if not path.exists():
        continue

    text = path.read_text()
    original = text

    # Gradle 8/AGP 8 compatibility:
    # - legacy 'maven' plugin was removed
    # - compileSdkVersion should use modern compileSdk DSL
    text = text.replace("apply plugin: 'maven'\n", "")
    text = text.replace(
        "compileSdkVersion safeExtGet('compileSdkVersion', DEFAULT_COMPILE_SDK_VERSION)",
        "compileSdk safeExtGet('compileSdkVersion', DEFAULT_COMPILE_SDK_VERSION)",
    )

    # Remove legacy publishing/javadoc tasks that rely on deprecated Gradle
    # configurations (e.g. 'compile') and are not needed for app builds.
    marker = "afterEvaluate { project ->"
    marker_index = text.find(marker)
    if marker_index != -1:
        text = (
            text[:marker_index].rstrip()
            + "\n\n// Legacy publishing tasks removed for modern Gradle compatibility.\n"
        )

    if text != original:
        path.write_text(text)
        print(f"[android-build] patched {path} for Gradle 8/AGP 8 compatibility")
    else:
        print(f"[android-build] {path} already compatible")
    patched_any = True

if not patched_any:
    print("[android-build] react-native-alarm-notification build.gradle not found; skipping compatibility patch")
PY

if [[ "${FOSS_BUILD}" == "1" ]]; then

  python3 - <<'PY'
from pathlib import Path

candidates = [
    Path("node_modules/@react-native/gradle-plugin/react-native-gradle-plugin/src/main/kotlin/com/facebook/react/utils/AgpConfiguratorUtils.kt"),
    Path("../../node_modules/@react-native/gradle-plugin/react-native-gradle-plugin/src/main/kotlin/com/facebook/react/utils/AgpConfiguratorUtils.kt"),
]

needle = '"string", "react_native_dev_server_ip", getHostIpAddress()'
replacement = '"string", "react_native_dev_server_ip", "localhost"'
patched = False
for path in candidates:
    if not path.exists():
        continue
    text = path.read_text()
    if replacement in text:
        print(f"[foss] react_native_dev_server_ip already pinned to localhost in {path}")
        patched = True
        break
    if needle not in text:
        continue
    path.write_text(text.replace(needle, replacement))
    print(f"[foss] patched {path} to pin react_native_dev_server_ip=localhost")
    patched = True
    break

if not patched:
    print("[foss] warning: react_native_dev_server_ip patch target not found; reproducibility may be affected")
PY
fi

if [[ "${UNSIGNED_APK:-0}" == "1" ]]; then
  python3 - <<'PY'
from pathlib import Path
import re

path = Path("android/app/build.gradle")
text = path.read_text()

# Remove signingConfig assignments (release must remain unsigned).
text = re.sub(r"^\s*signingConfig\s+signingConfigs\.\w+\s*$\n?", "", text, flags=re.M)

path.write_text(text)
PY
fi

if grep -q "^reactNativeArchitectures=" android/gradle.properties; then
  sed -i "s/^reactNativeArchitectures=.*/reactNativeArchitectures=${ARCHS}/" android/gradle.properties
else
  echo "reactNativeArchitectures=${ARCHS}" >> android/gradle.properties
fi


if grep -q "^org\\.gradle\\.jvmargs=" android/gradle.properties; then
  sed -i "s#^org\\.gradle\\.jvmargs=.*#org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8#" android/gradle.properties
else
  echo "org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8" >> android/gradle.properties
fi

if ! grep -q "splits {\\s*abi" android/app/build.gradle; then
  python3 - <<'PY'
from pathlib import Path

path = Path("android/app/build.gradle")
text = path.read_text()
marker = "defaultConfig {"
if marker in text:
    start = text.find(marker)
    end = text.find("\n    }\n", start)
    if end != -1:
        insert = """
    def reactNativeArchitectures = (findProperty('reactNativeArchitectures') ?: 'arm64-v8a')
        .split(',')
        .collect { it.trim() }
        .findAll { it }
    splits {
        abi {
            enable true
            reset()
            include(*reactNativeArchitectures)
            universalApk false
        }
    }
"""
        text = text[: end + 6] + insert + text[end + 6 :]
        path.write_text(text)
PY
fi

if [[ "${FOSS_BUILD}" == "1" ]]; then
  python3 - <<'PY'
from pathlib import Path

path = Path("android/app/build.gradle")
text = path.read_text()

excludes_block = """

configurations.all {
    exclude group: 'com.android.billingclient'
    exclude group: 'com.android.installreferrer'
    exclude group: 'com.google.android.ads'
    exclude group: 'com.google.android.gms'
    exclude group: 'com.google.android.play'
    exclude group: 'com.google.android.play.core'
    exclude group: 'com.google.android.ump'
    exclude group: 'com.google.firebase'
    exclude group: 'com.google.android.datatransport'
    exclude group: 'com.google.mlkit'
}
"""

dependencies_info_block = """

android {
    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }
}
"""

if "exclude group: 'com.google.firebase'" not in text:
    text = text.rstrip() + excludes_block

if "dependenciesInfo {" not in text:
    text = text.rstrip() + dependencies_info_block

path.write_text(text)
PY
fi

if [[ "${PREP_ONLY}" == "1" ]]; then
  echo "Preparation complete. Skipping Gradle build (--prep-only)."
  exit 0
fi

cd android

export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=6144}"
./gradlew assembleRelease -PreactNativeArchitectures="${ARCHS}"

APK_DIR="${ROOT_DIR}/android/app/build/outputs/apk/release"
if [[ ! -d "$APK_DIR" ]]; then
  echo "APK output directory not found: $APK_DIR" >&2
  exit 1
fi

IFS=',' read -ra ARCH_LIST <<< "${ARCHS}"
mkdir -p "${OUTPUT_DIR}"
VERSION="$(node -e "console.log(require('../app.json').expo.version)")"
SUFFIX=""
if [[ "${FOSS_BUILD:-0}" == "1" ]]; then
  SUFFIX="-foss"
fi

found=0
for arch in "${ARCH_LIST[@]}"; do
  arch_trimmed="$(echo "$arch" | xargs)"
  if [[ -z "$arch_trimmed" ]]; then
    continue
  fi
  apk_path="$(ls "$APK_DIR"/app-*${arch_trimmed}*-release*.apk 2>/dev/null | head -1 || true)"
  if [[ -n "$apk_path" ]]; then
    out_name="mindwtr-${VERSION}-${arch_trimmed}${SUFFIX}.apk"
    cp "$apk_path" "${OUTPUT_DIR}/${out_name}"
    echo "APK: ${OUTPUT_DIR}/${out_name}"
    found=1
  fi
done

if [[ "$found" -eq 0 ]]; then
  apk_path="$(ls "$APK_DIR"/app-release*.apk 2>/dev/null | head -1 || true)"
  if [[ -z "$apk_path" ]]; then
    echo "No release APKs found in ${APK_DIR}" >&2
    exit 1
  fi
  out_name="mindwtr-${VERSION}-universal${SUFFIX}.apk"
  cp "$apk_path" "${OUTPUT_DIR}/${out_name}"
  echo "APK: ${OUTPUT_DIR}/${out_name}"
fi
