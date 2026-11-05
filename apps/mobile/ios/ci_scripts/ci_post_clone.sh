#!/bin/sh
set -eu


cd "${CI_PRIMARY_REPOSITORY_PATH:?Xcode Cloud must provide the repository path}"
exec bash scripts/ci/xcode-cloud-post-clone.sh
