#!/bin/bash
set -euo pipefail
: "${GH_TOKEN:?MACMINI_CI_DISPATCH_TOKEN is required}" "${RUNNER_TEMP:?}"
[[ "${SOURCE_SHA:-}" =~ ^[0-9a-f]{40}$ ]]
private_repo=dongdongbh/Mindwtr-native-ci
request_id="$(uuidgen)"
title="Mindwtr $SOURCE_SHA / $request_id"
run_id=''
finished=false
cleanup() {
  if [ -n "$run_id" ] && [ "$finished" = false ]; then
    gh run cancel "$run_id" --repo "$private_repo" || true
  fi
}
trap cleanup EXIT

gh workflow run native.yml --repo "$private_repo" --ref main \
  -f "source_sha=$SOURCE_SHA" -f "request_id=$request_id"
for attempt in $(seq 1 60); do
  run_id="$(gh run list --repo "$private_repo" --workflow native.yml --event workflow_dispatch \
    --limit 100 --json databaseId,displayTitle \
    | jq -r --arg title "$title" '[.[] | select(.displayTitle == $title)][0].databaseId // empty')"
  [ -z "$run_id" ] || break
  sleep 5
done
if ! [[ "$run_id" =~ ^[0-9]+$ ]]; then
  echo '::error::The private Mac mini workflow did not appear within five minutes.' >&2
  exit 1
fi
echo "Mac mini run: https://github.com/$private_repo/actions/runs/$run_id"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "Mac mini validation: https://github.com/$private_repo/actions/runs/$run_id (source $SOURCE_SHA)" >> "$GITHUB_STEP_SUMMARY"
fi

while true; do
  run="$(gh api "repos/$private_repo/actions/runs/$run_id")"
  status="$(jq -r .status <<< "$run")"
  echo "Mac mini: $status"
  if [ "$status" = completed ]; then
    finished=true
    break
  fi
  sleep 30
done
result=1
[ "$(jq -r .conclusion <<< "$run")" != success ] || result=0
mkdir -p "$RUNNER_TEMP/ios27-artifacts"
gh run download "$run_id" --repo "$private_repo" --pattern 'ios27-native-validation-*' \
  --dir "$RUNNER_TEMP/ios27-artifacts" || echo '::warning::No downloadable Mac mini evidence was available.'
exit "$result"
