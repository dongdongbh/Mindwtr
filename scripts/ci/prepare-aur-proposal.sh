#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "Usage: $0 <package-dir> <package-name> <release-tag> <output-dir>" >&2
  exit 2
fi

PACKAGE_DIR="$1"
PACKAGE_NAME="$2"
RELEASE_TAG="$3"
OUTPUT_DIR="$4"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$PACKAGE_NAME" in
  mindwtr|mindwtr-bin|mindwtr-beta-bin) ;;
  *) echo "Unsupported AUR package: $PACKAGE_NAME" >&2; exit 2 ;;
esac

node "$SCRIPT_DIR/validate-aur-package.mjs" \
  --package-dir "$PACKAGE_DIR" \
  --package "$PACKAGE_NAME"

mkdir -p "$OUTPUT_DIR"
node "$SCRIPT_DIR/audit-aur-state.mjs" --output "$OUTPUT_DIR/aur-security-snapshot.json" >/dev/null

git -C "$PACKAGE_DIR" rev-parse HEAD > "$OUTPUT_DIR/base-commit"
printf '%s\n' "$PACKAGE_NAME" > "$OUTPUT_DIR/package-name"
printf '%s\n' "$RELEASE_TAG" > "$OUTPUT_DIR/release-tag"
cp "$PACKAGE_DIR/PKGBUILD" "$OUTPUT_DIR/PKGBUILD"
cp "$PACKAGE_DIR/.SRCINFO" "$OUTPUT_DIR/.SRCINFO"

: > "$OUTPUT_DIR/delete-files.txt"
if [ "$PACKAGE_NAME" = "mindwtr" ]; then
  for package_file in pnpm-lock.yaml pnpm-workspace.yaml; do
    if [ ! -f "$PACKAGE_DIR/$package_file" ]; then
      echo "mindwtr source proposals must include $package_file" >&2
      exit 1
    fi
    cp "$PACKAGE_DIR/$package_file" "$OUTPUT_DIR/$package_file"
  done
  if git -C "$PACKAGE_DIR" ls-files --error-unmatch bun.lock >/dev/null 2>&1 && [ ! -f "$PACKAGE_DIR/bun.lock" ]; then
    printf '%s\n' bun.lock >> "$OUTPUT_DIR/delete-files.txt"
  fi
  if [ -f "$PACKAGE_DIR/tauri-v2-schema.patch" ]; then
    cp "$PACKAGE_DIR/tauri-v2-schema.patch" "$OUTPUT_DIR/tauri-v2-schema.patch"
  elif git -C "$PACKAGE_DIR" ls-files --error-unmatch tauri-v2-schema.patch >/dev/null 2>&1; then
    printf '%s\n' tauri-v2-schema.patch >> "$OUTPUT_DIR/delete-files.txt"
  fi
fi

git -C "$PACKAGE_DIR" diff --binary -- PKGBUILD .SRCINFO pnpm-lock.yaml pnpm-workspace.yaml tauri-v2-schema.patch bun.lock > "$OUTPUT_DIR/review.patch"
(
  cd "$OUTPUT_DIR"
  sha256sum review.patch > review.patch.sha256
  manifest_files=(
    .SRCINFO
    PKGBUILD
    aur-security-snapshot.json
    base-commit
    delete-files.txt
    package-name
    release-tag
    review.patch
    review.patch.sha256
  )
  if [ -f tauri-v2-schema.patch ]; then
    manifest_files+=(tauri-v2-schema.patch)
  fi
  manifest_files+=(pnpm-lock.yaml pnpm-workspace.yaml)
  sha256sum "${manifest_files[@]}" > proposal-manifest.sha256
)

{
  echo "## AUR proposal: $PACKAGE_NAME"
  echo
  echo "- Release: \`$RELEASE_TAG\`"
  echo "- Audited AUR base: \`$(cat "$OUTPUT_DIR/base-commit")\`"
  echo "- Artifact contains exact \`PKGBUILD\`, \`.SRCINFO\`, package-local sources, ownership/history snapshot, and review diff."
  echo
  echo '```diff'
  cat "$OUTPUT_DIR/review.patch"
  echo '```'
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
