#!/usr/bin/env sh
set -eu

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
image="mindwtr-cloud-secret-runtime-test:$$"
fixture="$(mktemp -d)"
secret_file="$fixture/cloud-tokens.txt"

cleanup() {
  docker image rm "$image" >/dev/null 2>&1 || true
  if [ -n "$fixture" ] && [ -d "$fixture" ]; then
    rm -rf -- "$fixture"
  fi
}
trap cleanup EXIT INT TERM

cd "$repo_root"
docker build \
  --target cloud-runtime \
  --file docker/cloud/Dockerfile \
  --tag "$image" \
  .

# Create the owner-only host secret as a UID that is deliberately neither root
# nor the container's bun UID. No host chmod or ownership weakening is allowed.
docker run --rm \
  --user 0:0 \
  --entrypoint sh \
  --mount "type=bind,src=$fixture,dst=/fixture" \
  "$image" \
  -ceu 'printf "%s\n" "uid-mismatch-token-1234567890" > /fixture/cloud-tokens.txt
    chown 23456:23456 /fixture/cloud-tokens.txt
    chmod 0600 /fixture/cloud-tokens.txt'

# The overlay starts only the handoff as root. The image entrypoint must make a
# private bun-owned copy, then exec the requested process as UID/GID 1000.
docker run --rm \
  --user 0:0 \
  --env MINDWTR_CLOUD_AUTH_TOKENS_FILE=/run/secrets/mindwtr_cloud_tokens \
  --mount "type=bind,src=$secret_file,dst=/run/secrets/mindwtr_cloud_tokens,readonly" \
  "$image" \
  sh -ceu '
    test "$(id -u):$(id -g)" = "1000:1000"
    test ! -r /run/secrets/mindwtr_cloud_tokens
    test "$(stat -c "%u:%g:%a" /run/mindwtr-cloud)" = "0:1000:750"
    test "$(stat -c "%u:%g:%a" /run/mindwtr-cloud/auth-tokens)" = "1000:1000:400"
    test "$(cat /run/mindwtr-cloud/auth-tokens)" = "uid-mismatch-token-1234567890"
  '

host_metadata="$(
  docker run --rm \
    --user 0:0 \
    --entrypoint stat \
    --mount "type=bind,src=$fixture,dst=/fixture,readonly" \
    "$image" \
    -c '%u:%g:%a' /fixture/cloud-tokens.txt
)"
test "$host_metadata" = "23456:23456:600"

echo "Cloud secret handoff preserved host mode and dropped to UID/GID 1000."
