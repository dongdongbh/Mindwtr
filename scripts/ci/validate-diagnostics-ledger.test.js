import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const skippedDirectories = new Set([
  "node_modules", "dist", "build", ".worktrees", "test", "tests", "__tests__", "__mocks__",
]);
const sourceExtension = /\.(?:[cm]?[jt]sx?|rs|swift|kt|kts|java)$/;

async function collectSources(directory) {
  const sources = [];

  const filenames = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
    { cwd: directory, encoding: "utf8" }).split("\0").filter(Boolean).sort();
  for (const filename of filenames) {
    if (filename.split("/").some((part) => skippedDirectories.has(part))) continue;
    if (sourceExtension.test(filename) && !/\.(?:test|spec)\.[^.]+$/.test(filename)) {
      const absolute = path.join(directory, filename);
      try {
        const source = await readFile(absolute, "utf8");
        sources.push({ file: path.relative(root, absolute), source });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  return sources;
}

function collectCodeSlugs({ file, source, formatterSources = [] }) {
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

  for (const match of source.matchAll(
    /\breleaseCheck\s*:\s*([^,{};]+\?[^,{};]+)/g,
  )) {
    for (const arm of match[1].matchAll(/[?:]\s*(['"])([^'"\r\n]*)\1/g)) {
      sites.push({ file, slug: arm[2] });
    }
  }


  if (file.endsWith(".rs")) {
    const messages = [
      ...Array.from(source.matchAll(/\blog::(?:info|warn)!\(\s*"((?:\\[\s\S]|[^"\\])*)"/g), (match) => match[1]),

      ...Array.from(source.matchAll(/\blet\s+(\w+)\s*=\s*format!\(\s*"((?:\\[\s\S]|[^"\\])*)"\s*\);\s*log::(?:info|warn)!\(\s*"\{\1\}"\s*\)/g), (match) => match[2]),
    ];
    for (const message of messages) {
      for (const match of message.matchAll(/\bextra\.releaseCheck=([\w./-]+)/g)) {
        sites.push({ file, slug: match[1] });
      }
    }
  }


  if (file.endsWith(".kt")) {
    for (const message of source.matchAll(/(?:\bLog\.(?:i|w)\([^,()]+,|\.logLine\()\s*"((?:\\[\s\S]|[^"\\])*)"/g)) {
      for (const match of message[1].matchAll(/\breleaseCheck=([\w./-]+)/g)) {
        sites.push({ file, slug: match[1] });
      }
    }
  }


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
      } catch {                                                         }
    }
    // Engine-local calls pass the literal context directly, as raw or escaped JSON.
    for (const call of source.matchAll(
      /\binvoke\(\s*"logLine"\s*,\s*arguments:\s*\[\s*"(?:\\[\s\S]|[^"\\])*"\s*,\s*(?:(#+)"([\s\S]*?)"\1|("(?:\\[\s\S]|[^"\\])*"))\s*,?\s*\]\s*\)/g,
    )) {
      try {
        const context = JSON.parse(call[2] ?? JSON.parse(call[3]));
        if (typeof context?.releaseCheck === "string") sites.push({ file, slug: context.releaseCheck });
      } catch { /* Interpolation, invalid JSON and unsupported escapes are not literal contexts. */ }
    }
    // Shared Swift formatters: count only a guard-bound payload actually forwarded
    // with that formatter's message to logLine, not an unused static tag literal.
    for (const call of source.matchAll(
      /\bguard\s+let\s+(\w+)\s*=\s*(\w+)\.payload\([^{}]*\)\s*else\s*\{\s*return\s*\}\s*let\s+(\w+)\s*=\s*host\s+Task\s*\{\s*_\s*=\s*try\?\s*await\s+\3\?\.call\(\s*"logLine"\s*,\s*argumentsJSON:\s*json\(\s*\[\s*\2\.message\s*,\s*json\(\s*\1\s*\)\s*\]\s*\)\s*\)/g,
    )) {
      const type = call[2];
      const definitions = formatterSources.filter((entry) => entry.file.endsWith(".swift")
        && new RegExp(`\\bpublic\\s+enum\\s+${type}\\s*\\{`).test(entry.source));
      if (definitions.length !== 1) continue;
      const definition = definitions[0].source;
      const tag = definition.match(/\bpublic\s+static\s+let\s+releaseCheck\s*=\s*"([^"\\\r\n]*)"/)?.[1];
      const message = /\bpublic\s+static\s+let\s+message\s*=\s*"[^"\\\r\n]*"/.test(definition);
      const payload = definition.match(/\bpublic\s+static\s+func\s+payload\b[\s\S]*?(?=\n    public static func|$)/)?.[0] ?? "";
      const returned = /\bvar\s+(\w+)\s*:\s*\[String:\s*Any\]\s*=\s*\[\s*"releaseCheck"\s*:\s*releaseCheck\s*,[^\]]*\][\s\S]*?\breturn\s+\1\b/.test(payload);
      if (tag !== undefined && message && returned) sites.push({ file, slug: tag });
    }
    // Paired inline branches use the same simple condition for message and raw context.
    for (const call of source.matchAll(
      /\bcall\(\s*"logLine"\s*,\s*argumentsJSON:\s*(?:self\.)?json\(\s*\[\s*([A-Za-z_]\w*)\s*\?\s*"(?:\\[\s\S]|[^"\\])*"\s*:\s*"(?:\\[\s\S]|[^"\\])*"\s*,\s*\1\s*\?\s*(#+)"([\s\S]*?)"\2\s*:\s*(#+)"([\s\S]*?)"\4\s*,?\s*\]\s*\)\s*\)/g,
    )) {
      for (const raw of [call[3], call[5]]) {
        try {
          const context = JSON.parse(raw);
          if (typeof context?.releaseCheck === "string") sites.push({ file, slug: context.releaseCheck });
        } catch {                                                         }
      }
    }

    for (const call of source.matchAll(
      /\bcall\(\s*"logLine"\s*,\s*argumentsJSON:\s*(?:self\.)?json\(\s*\[\s*"(?:\\[\s\S]|[^"\\])*"\s*,\s*try\s+(?:self\.)?json\(\s*\[((?:"(?:\\[\s\S]|[^"\\])*"|[^"[\]])*)\]\s*\)\s*,?\s*\]\s*\)\s*\)/g,
    )) {
      for (const field of call[1].matchAll(/"releaseCheck"\s*:\s*("(?:\\[\s\S]|[^"\\])*")/g)) {
        try { sites.push({ file, slug: JSON.parse(field[1]) }); }
        catch {                                                                            }
      }
    }
    for (const call of source.matchAll(
      /\bvar\s+(\w+)\s*:\s*\[String:\s*Any\]\s*=\s*\[((?:"(?:\\[\s\S]|[^"\\])*"|[^"[\]])*)\][\s\S]{0,400}?\bif\s+let\s+(\w+)\s*=\s*try\?\s*(?:Self|self)\.ownedJSON\(\s*\1\s*\)\s*\{[^{}]*?\binvoke\(\s*"logLine"\s*,\s*arguments:\s*\[[^[\]]*,\s*\3\s*\]\s*\)/g,
    )) {
      for (const field of call[2].matchAll(/"releaseCheck"\s*:\s*("(?:\\[\s\S]|[^"\\])*")/g)) {
        try { sites.push({ file, slug: JSON.parse(field[1]) }); }
        catch { /* Interpolated or unsupported Swift strings are not resolved literals. */ }
      }
    }
    // An if-let binds an ownedJSON dictionary that its body forwards to logLine.
    for (const call of source.matchAll(
      /\blet\s+(\w+)\s*=\s*try\?\s*(?:Self|self)\.ownedJSON\(\s*\[((?:"(?:\\[\s\S]|[^"\\])*"|[^"[\]])*)\]\s*\)\s*\{[^{}]*?\binvoke\(\s*"logLine"\s*,\s*arguments:\s*\[[^[\]]*,\s*\1\s*\]\s*\)/g,
    )) {
      for (const field of call[2].matchAll(/"releaseCheck"\s*:\s*("(?:\\[\s\S]|[^"\\])*")/g)) {
        try { sites.push({ file, slug: JSON.parse(field[1]) }); }
        catch {                                                                            }
      }
    }
    for (const call of source.matchAll(
      /\blet\s+(\w+)\s*=\s*try\?\s*(?:self\.)?json\(\s*\[\s*"(?:\\[\s\S]|[^"\\])*"\s*,\s*try\s+(?:self\.)?json\(\s*\[((?:"(?:\\[\s\S]|[^"\\])*"|[^"[\]])*)\]\s*\)\s*,?\s*\]\s*\)\s*else\s*\{\s*return\s*\}\s*Task\s*\{\s*_\s*=\s*try\?\s*await\s+\w+\.call\(\s*"logLine"\s*,\s*argumentsJSON:\s*\1\s*\)/g,
    )) {
      for (const field of call[2].matchAll(/"releaseCheck"\s*:\s*("(?:\\[\s\S]|[^"\\])*")/g)) {
        try { sites.push({ file, slug: JSON.parse(field[1]) }); }
        catch {}
      }
    }
  }

  if (/\.[cm]?[jt]sx?$/.test(file)) {
    for (const table of source.matchAll(
      /\bconst\s+(\w+)\s*(?::[^=;]+)?=\s*\{([^{}]*)\};\s*const\s+(\w+)\s*=\s*\1\[event\.message\];[^;]*?\bevent\.context\.releaseCheck\s*!==\s*\3\[0\][^;]*;\s*log\.info\(\s*event\.message\b/g,
    )) {
      for (const entry of table[2].matchAll(/(['"])[^'"\r\n]*\1\s*:\s*\[\s*(['"])([^'"\r\n]*)\2/g)) {
        sites.push({ file, slug: entry[3] });
      }
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
const codeSites = sources.flatMap((entry) => collectCodeSlugs({ ...entry, formatterSources: sources }));
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
  it("ignores generated assets while scanning tracked and new source files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "diagnostics-sources-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: directory });
      await writeFile(path.join(directory, ".gitignore"), "assets/\n");
      await mkdir(path.join(directory, "assets"));
      await writeFile(path.join(directory, "assets/core-host.js"), "releaseCheck: 'v1.3.7/stale'");
      await writeFile(path.join(directory, "tracked.ts"), "releaseCheck: 'v1.3.7/tracked'");
      await writeFile(path.join(directory, "deleted.ts"), "releaseCheck: 'v1.3.7/deleted'");
      execFileSync("git", ["add", "tracked.ts", "deleted.ts"], { cwd: directory });
      await rm(path.join(directory, "deleted.ts"));
      await writeFile(path.join(directory, "new.ts"), "releaseCheck: 'v1.3.7/new'");
      expect((await collectSources(directory)).flatMap(collectCodeSlugs).map(({ slug }) => slug))
        .toEqual(["v1.3.7/new", "v1.3.7/tracked"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resolves conditional releaseCheck values across line breaks", () => {
    const file = "packages/core/src/store-projects/project-to-section-actions.ts";
    expect(collectCodeSlugs({ file, source: `
      logInfo('converted', { context: { releaseCheck: command.source.before.isSequential
        ? 'v1.3.7/sequential-project-to-section' : 'v1.3.4/project-to-section' } });
    ` })).toEqual([
      { file, slug: "v1.3.7/sequential-project-to-section" },
      { file, slug: "v1.3.4/project-to-section" },
    ]);
  });

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

  it("resolves nested releaseCheck arms without conditions or adjacent fields", () => {
    const file = "apps/Example.ts";
    expect(collectCodeSlugs({ file, source: `
      logInfo('confirmed', { context: {
        releaseCheck: source === 'project' ? 'v1.3.8/project' : source === 'inbox' ? 'v1.3.8/inbox' : 'v1.3.8/reference',
        outcome: changed ? 'unrelated-success' : 'unrelated-noop'
      } });
    ` })).toEqual([
      { file, slug: "v1.3.8/project" },
      { file, slug: "v1.3.8/inbox" },
      { file, slug: "v1.3.8/reference" },
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

  it("resolves only literal Swift Engine logLine contexts", () => {
    const file = "apps/ios-native/Sources/MindwtrNativeCore/Example.swift";
    const source = String.raw`
      _ = try? invoke("logLine", arguments: ["Raw diagnostic", #"{"releaseCheck":"v1.3.8/raw-engine","outcome":"confirmed"}"#])
      _ = try? invoke("logLine", arguments: ["Escaped diagnostic", "{\"releaseCheck\":\"v1.3.8/escaped-engine\"}"])
      let unused = #"{"releaseCheck":"v1.3.8/unused-engine"}"#
      _ = try? invoke("other", arguments: ["Other call", #"{"releaseCheck":"v1.3.8/other-engine"}"#])
      _ = try? invoke("logLine", arguments: ["Variable context", unused])
      _ = try? invoke("logLine", arguments: ["Malformed context", #"{"releaseCheck":"v1.3.8/malformed-engine",}"#])
      _ = try? invoke("logLine", arguments: ["Numeric field", "{\"releaseCheck\":123}"])
      _ = try? invoke("logLine", arguments: ["Interpolated context", "{\"releaseCheck\":\"\(slug)\"}"])
      _ = try? invoke("logLine", arguments: ["Concatenated context", "{\"releaseCheck\":\"v1.3.8/partial-engine\"}" + suffix])
    `;
    expect(collectCodeSlugs({ file, source })).toEqual([
      { file, slug: "v1.3.8/raw-engine" },
      { file, slug: "v1.3.8/escaped-engine" },
    ]);
    expect(collectCodeSlugs({ file: "apps/Example.ts", source })).toEqual([]);
  });

  it("resolves the actual shared Board geometry formatter only through its logLine emission", () => {
    const file = "apps/ios-native/App/CoreModel.swift";
    const source = sources.find((entry) => entry.file === file).source;
    const start = source.indexOf("    func logBoardDragGeometry(");
    const end = source.indexOf("    /// Final claim consumption", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const emission = source.slice(start, end);
    const formatter = sources.find((entry) => entry.file.endsWith("/NativeBoardDragGeometry.swift"));
    const resolve = (text, formatterSources = [formatter]) => collectCodeSlugs({ file, source: text, formatterSources });
    expect(resolve(emission)).toEqual([{ file, slug: "v1.3.9/ios-board-drag-geometry" }]);
    for (const text of [
      emission.replace('call("logLine"', 'call("other"'),
      emission.replace("NativeBoardDragGeometry.message", "Other.message"),
      emission.replace("json(value)", "json(otherValue)"),
      emission.slice(0, emission.indexOf("        let diagnosticHost")),
    ]) expect(resolve(text)).toEqual([]);
    expect(resolve(formatter.source)).toEqual([]);
    expect(resolve(emission, [])).toEqual([]);
    expect(resolve(emission, [formatter, formatter])).toEqual([]);
    expect(resolve(emission, [{ ...formatter, source: formatter.source.replace(
      '"releaseCheck": releaseCheck', '"unrelated": releaseCheck',
    ) }])).toEqual([]);
  });

  it("resolves both actual Board inline Swift message/context branches", () => {
    const file = "apps/ios-native/App/CoreModel.swift";
    const source = sources.find((entry) => entry.file === file).source;
    const start = source.indexOf('let fromDone = capture.status == "done"');
    const end = source.indexOf("await runBoardAction(request)", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    expect(collectCodeSlugs({ file, source: source.slice(start, end) })).toEqual([
      { file, slug: "v1.3.7/ios-board-done-cross-drop" },
      { file, slug: "v1.3.7/ios-board-cross-column-drag" },
    ]);
  });

  it("rejects unused, non-logLine, mismatched and malformed conditional Swift contexts", () => {
    const file = "apps/ios-native/App/Example.swift";
    const branches = `fromDone ? "Done" : "Move",
      fromDone ? #"{"releaseCheck":"v1.3.7/conditional-done"}"# : #"{"releaseCheck":"v1.3.7/conditional-move"}"#`;
    for (const source of [
      `let unused = json([${branches}])`,
      `host.call("other", argumentsJSON: json([${branches}]))`,
      `host.call("logLine", argumentsJSON: json([${branches.replace('fromDone ? #', 'other ? #')}]))`,
      `host.call("logLine", argumentsJSON: json([${branches.replaceAll('"}', '",}')}]))`,
      'host.call("logLine", argumentsJSON: json([fromDone ? "Done" : "Move", fromDone ? #"{"releaseCheck":1}"# : #"{"releaseCheck":null}"#]))',
    ]) expect(collectCodeSlugs({ file, source })).toEqual([]);
    expect(collectCodeSlugs({ file: "apps/Example.ts",
      source: `host.call("logLine", argumentsJSON: json([${branches}]))` })).toEqual([]);
  });

  it("resolves Swift dictionary contexts only when immediately encoded into logLine", () => {
    const file = "apps/ios-native/App/CoreModel.swift";
    expect(collectCodeSlugs({ file, source: `
      let unused = ["releaseCheck": "v1.3.5/unused-dictionary"]
      currentHost.call("other", argumentsJSON: json([
        "Not a diagnostic", try json(["releaseCheck": "v1.3.5/other-dictionary"]),
      ]))
      currentHost.call("logLine", argumentsJSON: json([
        "Dynamic context", try json(unused),
      ]))
      currentHost.call("logLine", argumentsJSON: json([
        "Wrong field type", try json(["releaseCheck": 123]),
      ]))
      owner.host.call("logLine", argumentsJSON: json([
        "Native response", try json(["releaseCheck": "v1.3.5/native-response", "action": action, "outcome": outcome]),
      ]))
      currentHost.call("logLine", argumentsJSON: self.json([
        "Native presentation", try self.json(["releaseCheck": "v1.3.5/native-presentation", "outcome": sound ? "sound" : "silent"]),
      ]))
    ` })).toEqual([
      { file, slug: "v1.3.5/native-response" },
      { file, slug: "v1.3.5/native-presentation" },
    ]);
  });

  it("resolves Swift ownedJSON contexts only when their if-let body forwards them to logLine", () => {
    const file = "apps/ios-native/Sources/MindwtrNativeCore/CoreHost.swift";
    expect(collectCodeSlugs({ file, source: `
      let unused = try? Self.ownedJSON(["releaseCheck": "v1.3.7/unused-owned"])
      if let context = try? Self.ownedJSON(["releaseCheck": "v1.3.7/other-bridge"]) {
          _ = try? invoke("other", arguments: ["Not a diagnostic", context])
      }
      if let context = try? Self.ownedJSON(["releaseCheck": "v1.3.7/other-name"]) {
          _ = try? invoke("logLine", arguments: ["Wrong context", diagnostic])
      }
      if let context = try? Self.ownedJSON(["releaseCheck": "v1.3.7/outside-block"]) {
          record(context)
      }
      _ = try? invoke("logLine", arguments: ["After the block", context])
      if let raw = args.first as? String,
         let context = try? Self.ownedJSON(["releaseCheck": "v1.3.7/owned-undo", "kind": kind, "outcome": "persisted"]) {
          _ = try? invoke("logLine", arguments: ["Native undo persisted", context])
      }
      if let context = try? Self.ownedJSON(["releaseCheck": "v1.3.7/owned-message", "outcome": "confirmed"]) {
          let message = ready ? "Ready" : "Pending"
          _ = try? invoke("logLine", arguments: [message, context])
      }
    ` })).toEqual([
      { file, slug: "v1.3.7/owned-undo" },
      { file, slug: "v1.3.7/owned-message" },
    ]);
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

  it("resolves a Swift guard-bound logLine context only when its Task forwards that line", () => {
    const file = "apps/ios-native/App/CoreModel.swift";
    const source = sources.find((entry) => entry.file === file).source;
    const start = source.indexOf("badge.report = { [weak self] publication in");
    const end = source.indexOf("appIconBadgeStore = badge", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const emission = source.slice(start, end);
    expect(collectCodeSlugs({ file, source: emission })).toEqual([{ file, slug: "v1.3.9/ios-due-badge" }]);
    for (const text of [
      emission.replace('call("logLine"', 'call("other"'),
      emission.replace("argumentsJSON: line)", "argumentsJSON: other)"),
    ]) expect(collectCodeSlugs({ file, source: text })).toEqual([]);
  });

  it("resolves a message-keyed TypeScript table only when its checked entry is logged", () => {
    const file = "apps/android-native/bundle/host-file-sync.ts";
    const source = sources.find((entry) => entry.file === file).source;
    expect(collectCodeSlugs({ file, source }).map(({ slug }) => slug)).toEqual([
      "v1.3.9/ios-file-sync-read-owner",
      "v1.3.9/ios-file-sync-created-write",
      "v1.3.9/ios-file-sync-publication-primitives",
      "v1.3.9/ios-file-sync-publication-primitives",
    ]);
    for (const text of [
      source.replace("event.context.releaseCheck !== fields[0]", "event.context.kind !== fields[0]"),
      source.replace("log.info(event.message", "log.warn(event.message"),
    ]) expect(collectCodeSlugs({ file, source: text })).toEqual([]);
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
