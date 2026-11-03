#!/usr/bin/env bash

set -euo pipefail

ARTIFACTS_DIR="${1:?usage: select-ios27-simulator.sh <artifacts-directory>}"
mkdir -p "$ARTIFACTS_DIR"

xcrun simctl list devices available -j > "$ARTIFACTS_DIR/simulator-devices.json"
xcrun simctl list runtimes -j > "$ARTIFACTS_DIR/simulator-runtimes.json"

SELECTION="$(python3 - "$ARTIFACTS_DIR/simulator-runtimes.json" "$ARTIFACTS_DIR/simulator-devices.json" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding='utf-8') as stream:
    runtimes = json.load(stream).get('runtimes', [])
with open(sys.argv[2], encoding='utf-8') as stream:
    devices = json.load(stream).get('devices', {})

def version_tuple(value):
    return tuple(int(part) for part in re.findall(r'\d+', value))

ios27 = [
    runtime for runtime in runtimes
    if runtime.get('isAvailable', True)
    and version_tuple(str(runtime.get('version', '0')))[:1] == (27,)
]
ios27.sort(key=lambda runtime: version_tuple(str(runtime.get('version', '0'))), reverse=True)

for runtime in ios27:
    identifier = runtime.get('identifier', '')
    candidates = [
        device for device in devices.get(identifier, [])
        if device.get('isAvailable', True)
        and '.iPhone-' in device.get('deviceTypeIdentifier', '')
        and device.get('udid')
    ]
    candidates.sort(key=lambda device: device.get('name', ''))
    if candidates:
        selected = candidates[0]
        print('\t'.join([
            identifier,
            str(runtime.get('version', 'unknown')),
            selected.get('name', 'unknown'),
            selected['udid'],
            selected['deviceTypeIdentifier'],
        ]))
        raise SystemExit(0)

available = ', '.join(
    f"{runtime.get('name', 'unknown')} ({runtime.get('identifier', 'unknown')})"
    for runtime in runtimes if runtime.get('isAvailable', True)
)
print(f'No available iPhone simulator for an iOS 27 runtime. Available runtimes: {available}', file=sys.stderr)
raise SystemExit(1)
PY
)"

IFS=$'\t' read -r RUNTIME_ID RUNTIME_VERSION SIMULATOR_NAME SIMULATOR_UDID DEVICE_TYPE <<< "$SELECTION"
if [ "${RUNNER_ENVIRONMENT:-}" = self-hosted ]; then

  SIMULATOR_NAME="Mindwtr CI ${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
  SIMULATOR_UDID="$(xcrun simctl create "$SIMULATOR_NAME" "$DEVICE_TYPE" "$RUNTIME_ID")"
fi
{
  echo "runtime_id=$RUNTIME_ID"
  echo "runtime_version=$RUNTIME_VERSION"
  echo "simulator_name=$SIMULATOR_NAME"
  echo "simulator_udid=$SIMULATOR_UDID"
} | tee "$ARTIFACTS_DIR/selected-simulator.txt"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "runtime_id=$RUNTIME_ID" >> "$GITHUB_OUTPUT"
  echo "runtime_version=$RUNTIME_VERSION" >> "$GITHUB_OUTPUT"
  echo "simulator_name=$SIMULATOR_NAME" >> "$GITHUB_OUTPUT"
  echo "simulator_udid=$SIMULATOR_UDID" >> "$GITHUB_OUTPUT"
fi
