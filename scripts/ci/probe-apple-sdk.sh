#!/usr/bin/env bash
set -euo pipefail
PROBE_DIR="${RUNNER_TEMP:?}/mindwtr-apple-api"
mkdir -p "$PROBE_DIR"
python3 - "$PROBE_DIR" <<'PYTHON'
from pathlib import Path
import sys
source = Path('apps/mobile/modules/apple-task-search/ios/MindwtrAppleTaskSearchModule.swift').read_text()
# Compile the real engine independently of Expo/CocoaPods so SDK errors surface
# before a full React Native build. The full native job still validates the bridge.
source = source.split('public final class MindwtrAppleTaskSearchModule: Module {')[0]
source = source.replace('import ExpoModulesCore\n', '')
Path(sys.argv[1], 'SearchEngine.swift').write_text(source)
PYTHON
status=0
for target in arm64-apple-ios16.4-simulator x86_64-apple-ios16.4-simulator arm64-apple-ios16.4; do
  sdk=iphoneos
  if [[ "$target" == *-simulator ]]; then sdk=iphonesimulator; fi
  sdk_path="$(xcrun --sdk "$sdk" --show-sdk-path)"
  echo "SDK API preflight: $sdk ($target)"

  xcrun swiftc -typecheck -parse-as-library -swift-version 5 \
    -Xfrontend -enable-cross-import-overlays \
    -sdk "$sdk_path" -target "$target" \
    "$PROBE_DIR/SearchEngine.swift" \
    apps/mobile/modules/apple-task-search/ios/MindwtrAppleTaskSearchCollector.swift || status=1
  xcrun swiftc -typecheck -parse-as-library -swift-version 5 \
    -Xfrontend -enable-cross-import-overlays \
    -sdk "$sdk_path" -target "$target" \
    apps/mobile/modules/apple-image-capture/ios/AppleImageCaptureModule.swift \
    apps/mobile/modules/apple-image-capture/ios/AppleImageCaptureBounds.swift \
    apps/mobile/modules/apple-image-capture/ios/AppleImageAnalysisCoordinator.swift || status=1


  xcrun swiftc -typecheck -parse-as-library -swift-version 5 \
    -sdk "$sdk_path" -target "$target" \
    apps/mobile/modules/apple-foundation-models/ios/ApplePccEvaluationEngine.swift || status=1
done
exit "$status"
