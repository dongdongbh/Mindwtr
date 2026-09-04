import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const skippedDirectories = new Set([
  "node_modules", "dist", ".worktrees", "test", "tests", "__tests__", "__mocks__",
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
])).flat();
const codeSites = sources.flatMap(collectCodeSlugs);
// Include quoted slugs anywhere in production source, including const declarations.
const codeLiterals = new Set(sources.flatMap(({ source }) => [...source.matchAll(
  /(['"])(v\d+\.\d+\.\d+\/[^'"\r\n]*)\1/g,
)].map((match) => match[2])));
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

  it("uses version-prefixed slugs at every code site", () => {
    expect(codeSites.length).toBeGreaterThan(0);
    expect(codeSites.filter(({ slug }) => !/^v\d+\.\d+\.\d+\/[a-z0-9-]+$/.test(slug)))
      .toEqual([]);
  });

  it("documents every code slug in a ledger bullet", () => {
    expect(codeSites.filter(({ slug }) => !ledger.has(slug))).toEqual([]);
  });

  it("has a code literal for every slug under the top unreleased version heading", () => {
    expect(topVersion).toBeDefined();
    const topSlugs = [...ledger].filter(([, headings]) => headings.includes(topVersion))
      .map(([slug]) => slug);
    expect(topSlugs.length).toBeGreaterThan(0);
    expect(topSlugs.filter((slug) => !codeLiterals.has(slug))).toEqual([]);
  });

  it("keeps each code slug under its matching version heading", () => {
    expect(codeSites.flatMap(({ file, slug }) => {
      const headings = ledger.get(slug) ?? [];
      return headings.filter((heading) => heading !== slug.split("/")[0])
        .map((heading) => ({ file, slug, heading }));
    })).toEqual([]);
  });
});
