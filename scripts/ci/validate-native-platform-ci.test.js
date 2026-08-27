import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("native CI generates clean projects and compiles Android and iOS sources", () => {
  const workflow = readFileSync(".github/workflows/native-platform-ci.yml", "utf8");

  expect(workflow).toContain('apps/mobile/modules/**/android/**');
  expect(workflow).toContain('apps/mobile/modules/**/ios/**');
  // The maintained iOS sources live outside the gitignored generated ios/
  // project, so the triggers must name them directly or edits skip CI.
  expect(workflow.match(/- "apps\/mobile\/ios-app-intents\/\*\*"/g)).toHaveLength(2);
  expect(workflow.match(/- "apps\/mobile\/widgets-ios\/\*\*"/g)).toHaveLength(2);
  expect(workflow.match(/- "scripts\/ci\/setup-ruby\.sh"/g)).toHaveLength(2);
  expect(workflow).toContain("ios: ${{ steps.filter.outputs.ios }}");
  expect(workflow).toMatch(/apps\/mobile\/ios-app-intents\/\*\|apps\/mobile\/widgets-ios\/\*\|[^\n]*scripts\/ci\/setup-ruby\.sh\|/);
  // The generated projects are gitignored; filters on them never match a
  // committed diff and only feign coverage.
  expect(workflow).not.toContain("apps/mobile/ios/**");
  expect(workflow).not.toContain("apps/mobile/android/**");

  expect(workflow).toContain("Generate Android native project");
  expect(workflow).toMatch(/prebuild \\\n\s+--clean \\\n\s+--platform android/);
  expect(workflow).toContain(":app:compileDebugKotlin");

  expect(workflow).toContain("name: iOS Swift compile");
  expect(workflow).toContain("gem install cocoapods --version 1.16.2 --no-document");
  expect(workflow).toMatch(/prebuild \\\n\s+--clean \\\n\s+--platform ios/);
  expect(workflow).toContain("-sdk iphonesimulator");
  expect(workflow).toContain("CODE_SIGNING_ALLOWED=NO");
});

test("desktop Rust pull requests check and test the native library on Windows", () => {
  const workflow = readFileSync(".github/workflows/native-platform-ci.yml", "utf8");
  const windowsJob = workflow.match(
    /\n  windows-rust:\n([\s\S]*?)(?=\n  [a-z][a-z-]+:\n|$)/,
  )?.[1];

  expect(workflow.match(/- "apps\/desktop\/src-tauri\/\*\*"/g)).toHaveLength(2);
  expect(workflow).toContain("windows: ${{ steps.filter.outputs.windows }}");
  expect(workflow).toContain('echo "windows=true" >> "$GITHUB_OUTPUT"');
  expect(workflow).toMatch(
    /apps\/desktop\/src-tauri\/\*\|\.github\/workflows\/native-platform-ci\.yml\)\n\s+windows=true/,
  );
  expect(workflow).toContain('echo "windows=$windows" >> "$GITHUB_OUTPUT"');

  expect(windowsJob).toBeDefined();
  expect(windowsJob).toContain("if: needs.changes.outputs.windows == 'true'");
  expect(windowsJob).toContain("needs: changes");
  expect(windowsJob).toContain("runs-on: windows-latest");
  expect(windowsJob).toContain(
    "uses: dtolnay/rust-toolchain@631a55b12751854ce901bb631d5902ceb48146f7 # stable",
  );
  expect(windowsJob).toContain(
    "run: cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml",
  );
  expect(windowsJob).toContain("name: Run Windows native library tests");
  expect(windowsJob).toContain(
    "run: cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib",
  );
});

test("macOS native CI links the release Rust and Swift bridges", () => {
  const workflow = readFileSync(".github/workflows/native-platform-ci.yml", "utf8");
  const macosJob = workflow.match(
    /\n  macos-rust:\n([\s\S]*?)(?=\n  [a-z][a-z-]+:\n|$)/,
  )?.[1];

  expect(macosJob).toBeDefined();
  expect(macosJob).toContain("name: Link release macOS Rust and Swift bridges");
  expect(macosJob).toContain(
    "run: cargo build --release --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib",
  );
  expect(macosJob).toContain('MACOSX_DEPLOYMENT_TARGET: "10.15"');
  expect(workflow.match(/- "scripts\/ci\/test-build-macos-widget\.sh"/g)).toHaveLength(2);
  expect(macosJob).toContain("name: Exercise macOS widget packaging and signing order");
  expect(macosJob).toContain("run: bash scripts/ci/test-build-macos-widget.sh");
});
