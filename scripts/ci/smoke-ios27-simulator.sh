#!/usr/bin/env bash

set -euo pipefail

SIMULATOR_UDID="${1:?usage: smoke-ios27-simulator.sh <simulator-udid> <app-path> <artifacts-directory>}"
APP_PATH="${2:?usage: smoke-ios27-simulator.sh <simulator-udid> <app-path> <artifacts-directory>}"
ARTIFACTS_DIR="${3:?usage: smoke-ios27-simulator.sh <simulator-udid> <app-path> <artifacts-directory>}"
mkdir -p "$ARTIFACTS_DIR"

if [ ! -d "$APP_PATH" ]; then
  echo "::error::Release simulator app was not found: $APP_PATH"
  exit 1
fi

INFO_PLIST="$APP_PATH/Info.plist"
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$INFO_PLIST")"
EXECUTABLE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$INFO_PLIST")"
JS_BUNDLE="$(find "$APP_PATH" -type f -name 'main.jsbundle' -print -quit)"
URL_SCHEME="mindwtr"
SCHEME_APPROVAL_DOMAIN="com.apple.launchservices.schemeapproval"
SCHEME_APPROVAL_KEY="com.apple.CoreSimulator.CoreSimulatorBridge-->${URL_SCHEME}"
if [ -z "${JS_BUNDLE:-}" ] || [ ! -s "$JS_BUNDLE" ]; then
  echo "::error::Release app does not contain a non-empty main.jsbundle; the smoke test must not depend on Metro."
  exit 1
fi

collect_diagnostics() {
  local status=$?
  trap - EXIT
  xcrun simctl io "$SIMULATOR_UDID" screenshot "$ARTIFACTS_DIR/final-screen.png" >/dev/null 2>&1 || true
  xcrun simctl spawn "$SIMULATOR_UDID" log show \
    --style compact \
    --last 10m \
    --predicate "process == '$EXECUTABLE' OR eventMessage CONTAINS[c] '$BUNDLE_ID'" \
    > "$ARTIFACTS_DIR/simulator-app.log" 2>&1 || true
  xcrun simctl list devices > "$ARTIFACTS_DIR/simulator-devices-final.txt" 2>&1 || true
  xcrun simctl shutdown "$SIMULATOR_UDID" >/dev/null 2>&1 || true
  exit "$status"
}
trap collect_diagnostics EXIT

snapshot_app_log() {
  xcrun simctl spawn "$SIMULATOR_UDID" log show \
    --style compact \
    --last 10m \
    --predicate "process == '$EXECUTABLE' OR eventMessage CONTAINS[c] '$BUNDLE_ID'" \
    > "$ARTIFACTS_DIR/simulator-app.log" 2>&1
}

wait_for_marker() {
  local marker="$1"
  local attempt
  for attempt in $(seq 1 15); do
    snapshot_app_log
    if grep -Fq "$marker" "$ARTIFACTS_DIR/simulator-app.log"; then
      return 0
    fi
    sleep 1
  done
  echo "::error::Simulator log did not contain required marker: $marker"
  return 1
}

wait_for_marker_count() {
  local marker="$1"
  local minimum="$2"
  local attempt
  local count
  for attempt in $(seq 1 15); do
    snapshot_app_log
    count="$(grep -Fc "$marker" "$ARTIFACTS_DIR/simulator-app.log" || true)"
    if [ "$count" -ge "$minimum" ]; then
      return 0
    fi
    sleep 1
  done
  echo "::error::Simulator log contained $count instances of '$marker'; expected at least $minimum."
  return 1
}

approve_url_scheme() {
  local evidence="$ARTIFACTS_DIR/simulator-scheme-approval.txt"
  local approved_bundle_id
  {
    echo "approval_scope=github_actions_simulator"
    echo "approval_action=write_single_scheme_binding"
    echo "approval_domain=$SCHEME_APPROVAL_DOMAIN"
    echo "approval_key=$SCHEME_APPROVAL_KEY"
    echo "expected_bundle_id=$BUNDLE_ID"
  } > "$evidence"

  if [ "${GITHUB_ACTIONS:-}" != "true" ]; then
    echo "approval_status=refused_outside_github_actions" >> "$evidence"
    echo "::error::Automatic URL-scheme approval is restricted to the disposable GitHub Actions simulator."
    return 1
  fi

  if ! xcrun simctl get_app_container "$SIMULATOR_UDID" "$BUNDLE_ID" app >/dev/null 2>&1; then
    echo "approval_status=app_not_installed" >> "$evidence"
    echo "::error::Cannot approve the URL scheme because $BUNDLE_ID is not installed on the selected simulator."
    return 1
  fi


  if ! xcrun simctl spawn "$SIMULATOR_UDID" defaults write \
    "$SCHEME_APPROVAL_DOMAIN" \
    "$SCHEME_APPROVAL_KEY" \
    -string "$BUNDLE_ID"; then
    echo "approval_status=write_failed" >> "$evidence"
    echo "::error::Could not preapprove the $URL_SCHEME URL scheme on the selected simulator."
    return 1
  fi

  if ! approved_bundle_id="$(
    xcrun simctl spawn "$SIMULATOR_UDID" defaults read \
      "$SCHEME_APPROVAL_DOMAIN" \
      "$SCHEME_APPROVAL_KEY" 2>/dev/null
  )"; then
    echo "approval_status=read_failed" >> "$evidence"
    echo "::error::Could not read back the $URL_SCHEME URL-scheme approval."
    return 1
  fi
  if [ "$approved_bundle_id" != "$BUNDLE_ID" ]; then
    echo "approval_status=readback_mismatch" >> "$evidence"
    echo "::error::The $URL_SCHEME URL-scheme approval did not resolve to the installed Mindwtr bundle."
    return 1
  fi

  {
    echo "approved_bundle_id=$approved_bundle_id"
    echo "approval_status=verified"
  } >> "$evidence"
}

xcrun simctl boot "$SIMULATOR_UDID" 2>/dev/null || true
xcrun simctl bootstatus "$SIMULATOR_UDID" -b
xcrun simctl install "$SIMULATOR_UDID" "$APP_PATH"
approve_url_scheme

running_pid() {


  xcrun simctl spawn "$SIMULATOR_UDID" launchctl list 2>/dev/null \
    | awk -v bundle="$BUNDLE_ID" '!found && index($3, bundle) > 0 && $1 ~ /^[0-9]+$/ { print $1; found = 1 }'
}

wait_for_pid() {
  local attempt
  local pid
  for attempt in $(seq 1 20); do
    pid="$(running_pid)"
    if [[ "$pid" =~ ^[0-9]+$ ]]; then
      echo "$pid"
      return 0
    fi
    sleep 1
  done
  return 1
}

open_url() {
  local status=0
  xcrun simctl openurl "$SIMULATOR_UDID" "$1" || status=$?
  if [ "$status" -ne 0 ] && [ "$status" -ne 60 ]; then
    echo "::error::simctl openurl failed with exit status $status."
    return "$status"
  fi
  return 0
}

REQUEST_ID="ios27-ci-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}"
COLD_URL="mindwtr://capture?title=CI%20iOS%2027%20Smoke&requestId=$REQUEST_ID"
WARM_URL='mindwtr://open-feature?feature=waiting'
{
  echo "bundle_id=$BUNDLE_ID"
  echo "executable=$EXECUTABLE"
  echo "app_path=$APP_PATH"
  echo "js_bundle=$JS_BUNDLE"
  echo "cold_url=$COLD_URL"
  echo "warm_url=$WARM_URL"
} > "$ARTIFACTS_DIR/simulator-smoke.txt"

xcrun simctl terminate "$SIMULATOR_UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
open_url "$COLD_URL"
COLD_PID="$(wait_for_pid)" || {
  echo "::error::Mindwtr did not remain running after the cold deep-link launch."
  exit 1
}
echo "cold_pid=$COLD_PID" | tee -a "$ARTIFACTS_DIR/simulator-smoke.txt"

sleep 8
STABLE_COLD_PID="$(running_pid)"
if [ "$STABLE_COLD_PID" != "$COLD_PID" ]; then
  echo "::error::Mindwtr exited or restarted shortly after cold launch (initial PID $COLD_PID, current PID ${STABLE_COLD_PID:-none})."
  exit 1
fi
wait_for_marker '[MindwtrScene] stage=sceneConnected deliveryKind=url count='
wait_for_marker '[MindwtrScene] stage=rootStarted deliveryKind=url count='
wait_for_marker '[MindwtrScene] stage=coldDelivery deliveryKind=url count='
wait_for_marker '[MindwtrScene] stage=bridgeReady deliveryKind=none count='
xcrun simctl io "$SIMULATOR_UDID" screenshot "$ARTIFACTS_DIR/cold-link-screen.png"

open_url "$WARM_URL"
sleep 5
WARM_PID="$(running_pid)"
if [ "$WARM_PID" != "$COLD_PID" ]; then
  echo "::error::Mindwtr exited or restarted during the warm-link check (cold PID $COLD_PID, warm PID ${WARM_PID:-none})."
  exit 1
fi
wait_for_marker '[MindwtrScene] stage=warmDelivery deliveryKind=url count='
wait_for_marker_count '[MindwtrScene] stage=bridgeReady deliveryKind=none count=' 2
echo "warm_pid=$WARM_PID" | tee -a "$ARTIFACTS_DIR/simulator-smoke.txt"

xcrun simctl io "$SIMULATOR_UDID" screenshot "$ARTIFACTS_DIR/warm-link-screen.png"
echo "Release simulator cold/warm deep-link smoke passed without an early process exit."
