#!/usr/bin/env bash
# Offline harness regression fixture. Never invokes a real adb binary.
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_ADB_LOG"
case "$*" in
  get-state) echo device ;;
  'shell dumpsys package '*)
    echo 'versionName=1.3.0 versionCode=130'
    if [[ "${FAKE_DEBUGGABLE:-0}" == 1 ]]; then echo DEBUGGABLE; fi ;;
  'shell pm path '*) echo package:/data/app/base.apk ;;
  'shell sha256sum '*) printf '%064d  /data/app/base.apk\n' 1 ;;
  'shell getprop ro.product.model') echo 'Synthetic Phone' ;;
  'shell getprop ro.build.fingerprint') echo synthetic/android/36 ;;
  'shell date '*) echo '09-08 12:00:00.000' ;;
  'shell am start '*) printf 'Status: ok\nLaunchState: %s\nTotalTime: 200\nWaitTime: 205\n' "${FAKE_LAUNCH_STATE:-COLD}" ;;
  'shell pidof '*) echo 1234 ;;
  'logcat -b crash '*) ;;
  'logcat '*)
    if [[ "${FAKE_MISSING_MARKER:-0}" != 1 ]]; then
      echo 'phase=js.interactive_ready sinceJsStartMs=350'
      echo 'phase=js.resume_ready durationMs=20 sinceJsStartMs=4000'
    fi ;;
esac
