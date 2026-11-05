#!/usr/bin/env bash

set -euo pipefail

install_profile() {
  local prefix="$1" encoded="$2" expected_bundle="$3"
  local profile_path="$RUNNER_TEMP/$prefix.mobileprovision"
  local plist_path="$RUNNER_TEMP/$prefix.plist"
  bash scripts/ci/decode-base64-to-file.sh "$encoded" "$profile_path"
  security cms -D -i "$profile_path" > "$plist_path"
  python3 - "$plist_path" "$expected_bundle" "$prefix" "$profile_path" <<'PY'
import datetime
import hashlib
import os
import pathlib
import plistlib
import re
import shutil
import subprocess
import sys

plist_path, bundle, prefix, profile_path = sys.argv[1:]
with open(plist_path, 'rb') as stream:
    profile = plistlib.load(stream)
identity = os.environ['IOS_SIGNING_IDENTITY']
identities = subprocess.check_output(
    ['security', 'find-identity', '-v', '-p', 'codesigning', os.environ['KEYCHAIN_PATH']], text=True,
)
selected = {
    fingerprint.upper()
    for fingerprint, name in re.findall(r'\d+\)\s+([0-9a-fA-F]{40})\s+"([^"]+)"', identities)
    if name == identity or fingerprint.upper() == identity.upper()
}
assert len(selected) == 1, f'{prefix}: could not uniquely resolve the configured iOS signing certificate'
fingerprint = selected.pop()
certificates = {hashlib.sha1(certificate).hexdigest().upper() for certificate in profile.get('DeveloperCertificates', [])}
assert fingerprint in certificates, (
    f'{prefix}: profile does not include the CI signing certificate (SHA-1 {fingerprint}). '
    'Regenerate this Watch profile using the same Apple Distribution certificate as the iPhone App Store profile.'
)
team = os.environ['EXPECTED_TEAM_ID']
entitlements = profile.get('Entitlements', {})
assert team in profile.get('TeamIdentifier', []), f'{prefix}: wrong signing team'
assert entitlements.get('application-identifier') == f'{team}.{bundle}', f'{prefix}: wrong bundle identifier'
assert os.environ['EXPECTED_WATCH_APP_GROUP'] in entitlements.get('com.apple.security.application-groups', []), f'{prefix}: missing Watch app group'
assert not entitlements.get('get-task-allow', False), f'{prefix}: requires a distribution profile'
assert not profile.get('ProvisionedDevices') and not profile.get('ProvisionsAllDevices'), f'{prefix}: requires an App Store profile'
expiration = profile.get('ExpirationDate')
assert expiration and expiration.replace(tzinfo=datetime.timezone.utc) > datetime.datetime.now(datetime.timezone.utc), f'{prefix}: profile has expired'
uuid, name = profile['UUID'], profile['Name']
assert all('\n' not in value and '\r' not in value for value in (uuid, name)), 'Invalid profile metadata'
destination = pathlib.Path.home() / 'Library/MobileDevice/Provisioning Profiles'
destination.mkdir(parents=True, exist_ok=True)
shutil.copyfile(profile_path, destination / f'{uuid}.mobileprovision')
with open(os.environ['GITHUB_ENV'], 'a') as stream:
    stream.write(f'{prefix}_PROFILE_UUID={uuid}\n{prefix}_PROFILE_NAME={name}\n')
print(f'Installed {prefix} distribution profile for {bundle}')
PY
}

install_profile WATCH "${IOS_WATCH_PROVISIONING_PROFILE:?}" "$EXPECTED_WATCH_BUNDLE_ID"
install_profile WATCH_WIDGET "${IOS_WATCH_WIDGET_PROVISIONING_PROFILE:?}" "$EXPECTED_WATCH_WIDGET_BUNDLE_ID"
