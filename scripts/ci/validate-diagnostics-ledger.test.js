import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const skippedDirectories = new Set([
  "node_modules", "dist", "build", ".worktrees", "test", "tests", "__tests__", "__mocks__",
]);
const sourceExtension = /\.(?:[cm]?[jt]sx?|rs|swift|kt|kts|java)$/;

async function collectSources(directory) {
  const sources = [];
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory() && !skippedDirectories.has(entry.name)) {
      sources.push(...await collectSources(filename));
    } else if (entry.isFile() && sourceExtension.test(entry.name)
      && !/\.(?:test|spec)\.[^.]+$/.test(entry.name)) {
      const source = await readFile(filename, "utf8");
      sources.push({ file: path.relative(root, filename), source });
    }
  }
  return sources;
}

function collectCodeSlugs({ file, source }) {
  const constants = new Map([...source.matchAll(
    /\bconst\s+([\w$]+)\s*(?::\s*string\s*)?=\s*(['"])([^'"\r\n]*)\2/g,
  )].map((match) => [match[1], match[3]]));
  const sites = [];
  for (const match of source.matchAll(
    /\breleaseCheck\s*:\s*(?:(['"])([^'"\r\n]*)\1|([\w$]+))/g,
  )) {
    const slug = match[2] ?? constants.get(match[3]);
    if (slug !== undefined) sites.push({ file, slug });
  }
  // A conditional value (`releaseCheck: queued ? 'a' : 'b'`) emits either literal.
  for (const match of source.matchAll(
    /\breleaseCheck\s*:\s*[^,{}?\r\n]+\?\s*(['"])([^'"\r\n]*)\1\s*:\s*(['"])([^'"\r\n]*)\3/g,
  )) {
    sites.push({ file, slug: match[2] }, { file, slug: match[4] });
  }
  // Native Rust diagnostics put the field inside a log message rather than
  // a JavaScript object. Only count log macros, not unused string constants.
  if (file.endsWith(".rs")) {
    const messages = [
      ...Array.from(source.matchAll(/\blog::(?:info|warn)!\(\s*"((?:\\[\s\S]|[^"\\])*)"/g), (match) => match[1]),
      // A formatted message immediately logged, then reused for the Diagnostics file.
      ...Array.from(source.matchAll(/\blet\s+(\w+)\s*=\s*format!\(\s*"((?:\\[\s\S]|[^"\\])*)"\s*\);\s*log::(?:info|warn)!\(\s*"\{\1\}"\s*\)/g), (match) => match[2]),
    ];
    for (const message of messages) {
      for (const match of message.matchAll(/\bextra\.releaseCheck=([\w./-]+)/g)) {
        sites.push({ file, slug: match[1] });
      }
    }
  }
  // Native Android diagnostics likewise put the field in the first string of
  // an android.util.Log info/warn call, or of CoreHost.logLine (core's log, so
  // Settings > Diagnostics); unused string constants do not count.
  if (file.endsWith(".kt")) {
    for (const message of source.matchAll(/(?:\bLog\.(?:i|w)\([^,()]+,|\.logLine\()\s*"((?:\\[\s\S]|[^"\\])*)"/g)) {
      for (const match of message[1].matchAll(/\breleaseCheck=([\w./-]+)/g)) {
        sites.push({ file, slug: match[1] });
      }
    }
  }
  // Native Swift diagnostics use NSLog or forward a literal JSON context to
  // the shared Diagnostics logLine bridge; unused string constants do not count.
  if (file.endsWith(".swift")) {
    for (const message of source.matchAll(/\bNSLog\(\s*"((?:\\[\s\S]|[^"\\])*)"/g)) {
      for (const match of message[1].matchAll(/\breleaseCheck=([\w./-]+)/g)) {
        sites.push({ file, slug: match[1] });
      }
    }
    for (const call of source.matchAll(
      /\bcall\(\s*"logLine"\s*,\s*argumentsJSON:\s*(?:self\.)?json\(\s*\[\s*"(?:\\[\s\S]|[^"\\])*"\s*,\s*(#+)"([\s\S]*?)"\1\s*,?\s*\]\s*\)\s*\)/g,
    )) {
      try {
        const context = JSON.parse(call[2]);
        if (typeof context?.releaseCheck === "string") sites.push({ file, slug: context.releaseCheck });
      } catch { /* Invalid JSON cannot supply a Diagnostics context. */ }
    }
  }
  return sites;
}

function parseLedger(source) {
  const bullets = new Map();
  let version;
  for (const line of source.split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      version = line.match(/^## (v\d+\.\d+\.\d+)\b/)?.[1];
    }
    const slug = line.match(/^- \*\*`([^`]+)`\*\*/)?.[1];
    if (slug) {
      const headings = bullets.get(slug) ?? [];
      headings.push(version);
      bullets.set(slug, headings);
    }
  }
  return bullets;
}

const sources = (await Promise.all([
  collectSources(path.join(root, "packages")),
  collectSources(path.join(root, "apps")),
  collectSources(path.join(root, "scripts")),
])).flat();
const codeSites = sources.flatMap(collectCodeSlugs);
function findUnemittedSlugs(slugs, sites) {
  const emittedSlugs = new Set(sites.map(({ slug }) => slug));
  return slugs.filter((slug) => !emittedSlugs.has(slug));
}
const ledgerSource = await readFile(
  path.join(root, "docs/release-notes/diagnostics-ledger.md"), "utf8",
);
const ledger = parseLedger(ledgerSource);
const topVersion = ledgerSource.match(/^## (v\d+\.\d+\.\d+)\b/m)?.[1];

describe("release diagnostics ledger", () => {
  it("resolves constant-valued releaseCheck sites in the same source file", () => {
    const file = "apps/example.ts";
    expect(collectCodeSlugs({ file, source: `
      const CHECK = 'v1.2.8/constant-check';
      const TYPED_CHECK: string = "v1.2.8/typed-check";
      logInfo('accepted', { releaseCheck: CHECK });
      logInfo('accepted', { releaseCheck: TYPED_CHECK });
      logInfo('accepted', { releaseCheck: 'v1.2.8/literal-check' });
    ` })).toEqual([
      { file, slug: "v1.2.8/constant-check" },
      { file, slug: "v1.2.8/typed-check" },
      { file, slug: "v1.2.8/literal-check" },
    ]);
  });

  it("resolves both literals of a conditional releaseCheck value", () => {
    const file = "apps/example.ts";
    expect(collectCodeSlugs({ file, source: `
      logInfo('accepted', { releaseCheck: queued ? 'v1.3.3/queued-check' : 'v1.3.0/plain-check' });
    ` })).toEqual([
      { file, slug: "v1.3.3/queued-check" },
      { file, slug: "v1.3.0/plain-check" },
    ]);
  });

  it("rejects a ledger slug whose constant has no releaseCheck use", () => {
    const slug = "v1.2.8/unused-check";
    const sources = [{ file: "apps/example.ts", source: `
      const CHECK = 'v1.2.8/unused-check';
      logInfo('accepted', {});
    ` }];
    expect(findUnemittedSlugs([slug], sources.flatMap(collectCodeSlugs))).toEqual([slug]);
    expect(findUnemittedSlugs([slug], [{
      ...sources[0], source: sources[0].source + "logInfo('accepted', { releaseCheck: CHECK });",
    }].flatMap(collectCodeSlugs))).toEqual([]);
  });

  it("resolves native Rust diagnostic fields only inside log macros", () => {
    const file = "apps/desktop/src-tauri/src/example.rs";
    expect(collectCodeSlugs({ file, source: `
      const UNUSED: &str = "extra.releaseCheck=v1.3.0/unused-native";
      log::info!("Capture delivered \\
        extra.releaseCheck=v1.3.0/native-capture");
      log::warn!("Capture retained extra.releaseCheck=v1.3.0/native-retry");
    ` })).toEqual([
      { file, slug: "v1.3.0/native-capture" },
      { file, slug: "v1.3.0/native-retry" },
    ]);
  });

  it("resolves native Android diagnostic fields only inside Log calls", () => {
    const file = "apps/android-native/android/app/src/main/java/Example.kt";
    expect(collectCodeSlugs({ file, source: `
      const val UNUSED = "releaseCheck=v1.3.0/unused-android"
      Log.i(TAG, "Host reused releaseCheck=v1.3.0/android-reuse " +
          "reason=\$reason")
      Log.w(CoreHost.TAG, "Guard blocked releaseCheck=v1.3.0/android-guard outcome=blocked")
      runtime.logLine("Held publication releaseCheck=v1.3.0/android-log-line", JSONObject())
    ` })).toEqual([
      { file, slug: "v1.3.0/android-reuse" },
      { file, slug: "v1.3.0/android-guard" },
      { file, slug: "v1.3.0/android-log-line" },
    ]);
  });

  it("resolves native Swift diagnostic fields only inside NSLog calls", () => {
    const file = "apps/ios-native/Sources/MindwtrNativeCore/Example.swift";
    expect(collectCodeSlugs({ file, source: `
      let unused = "releaseCheck=v1.3.3/unused-swift"
      NSLog("Native save releaseCheck=v1.3.3/native-swift-save outcome=%@", outcome)
      NSLog("Native retry releaseCheck=v1.3.3/native-swift-retry")
    ` })).toEqual([
      { file, slug: "v1.3.3/native-swift-save" },
      { file, slug: "v1.3.3/native-swift-retry" },
    ]);
  });

  it("resolves Swift raw JSON immediately forwarded through the Diagnostics logLine bridge", () => {
    const file = "apps/ios-native/App/CoreModel.swift";
    expect(collectCodeSlugs({ file, source: `
      _ = try? await currentHost.call("logLine", argumentsJSON: self.json([
        "Native iOS foreground activation refreshed",
        #"{"releaseCheck":"v1.3.5/ios-foreground-activation","outcome":"refreshed"}"#,
      ]))
    ` })).toEqual([{ file, slug: "v1.3.5/ios-foreground-activation" }]);
  });

  it("rejects unused Swift JSON, other bridge calls and invalid logLine contexts", () => {
    const file = "apps/ios-native/App/Example.swift";
    expect(collectCodeSlugs({ file, source: `
      let unused = #"{"releaseCheck":"v1.3.5/unused-swift-json"}"#
      currentHost.call("other", argumentsJSON: self.json([
        "Not a diagnostic", #"{"releaseCheck":"v1.3.5/other-swift-call"}"#,
      ]))
      currentHost.call("logLine", argumentsJSON: self.json(["Dynamic context", unused]))
      currentHost.call("logLine", argumentsJSON: self.json([
        "Malformed context", #"{"releaseCheck":"v1.3.5/malformed-swift-json",}"#,
      ]))
      currentHost.call("logLine", argumentsJSON: self.json([
        "Wrong field type", #"{"releaseCheck":123}"#,
      ]))
    ` })).toEqual([]);
  });

  it("resolves a Rust formatted message immediately forwarded to a log macro", () => {
    const file = "apps/desktop/src-tauri/src/example.rs";
    expect(collectCodeSlugs({ file, source: `
      let line = format!("Saved extra.releaseCheck=v1.3.3/formatted count={count}");
      log::info!("{line}");
      let unused = format!("Unused extra.releaseCheck=v1.3.3/unused");
      let other = format!("Different extra.releaseCheck=v1.3.3/different");
      log::warn!("{unrelated}");
    ` })).toEqual([{ file, slug: "v1.3.3/formatted" }]);
  });

  it("uses version-prefixed slugs at every code site", () => {
    expect(codeSites.length).toBeGreaterThan(0);
    expect(codeSites.filter(({ slug }) => !/^v\d+\.\d+\.\d+\/[a-z0-9-]+$/.test(slug)))
      .toEqual([]);
  });

  it("documents every code slug in a ledger bullet", () => {
    expect(codeSites.filter(({ slug }) => !ledger.has(slug))).toEqual([]);
  });

  it("has a resolved releaseCheck site for every slug under the top unreleased version heading", () => {
    expect(topVersion).toBeDefined();
    const topSlugs = [...ledger].filter(([, headings]) => headings.includes(topVersion))
      .map(([slug]) => slug);
    expect(topSlugs.length).toBeGreaterThan(0);
    expect(findUnemittedSlugs(topSlugs, codeSites)).toEqual([]);
  });

  it("keeps each code slug under its matching version heading", () => {
    expect(codeSites.flatMap(({ file, slug }) => {
      const headings = ledger.get(slug) ?? [];
      return headings.filter((heading) => heading !== slug.split("/")[0])
        .map((heading) => ({ file, slug, heading }));
    })).toEqual([]);
  });
});
