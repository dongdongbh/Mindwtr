import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const skippedDirectories = new Set([
  "node_modules", "dist", ".worktrees", "test", "tests", "__tests__", "__mocks__",
]);
const sourceExtension = /\.(?:[cm]?[jt]sx?|rs|swift|kt|kts|java)$/;

async function collectCodeSlugs(directory) {
  const sites = [];
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory() && !skippedDirectories.has(entry.name)) {
      sites.push(...await collectCodeSlugs(filename));
    } else if (entry.isFile() && sourceExtension.test(entry.name)
      && !/\.(?:test|spec)\.[^.]+$/.test(entry.name)) {
      const source = await readFile(filename, "utf8");
      for (const match of source.matchAll(/\breleaseCheck\s*:\s*(['"])([^'"\r\n]*)\1/g)) {
        sites.push({ file: path.relative(root, filename), slug: match[2] });
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

const codeSites = (await Promise.all([
  collectCodeSlugs(path.join(root, "packages")),
  collectCodeSlugs(path.join(root, "apps")),
])).flat();
const ledger = parseLedger(await readFile(
  path.join(root, "docs/release-notes/diagnostics-ledger.md"), "utf8",
));

describe("release diagnostics ledger", () => {
  it("uses version-prefixed slugs at every code site", () => {
    expect(codeSites.length).toBeGreaterThan(0);
    expect(codeSites.filter(({ slug }) => !/^v\d+\.\d+\.\d+\/[a-z0-9-]+$/.test(slug)))
      .toEqual([]);
  });

  it("documents every code slug in a ledger bullet", () => {
    expect(codeSites.filter(({ slug }) => !ledger.has(slug))).toEqual([]);
  });

  it("keeps each code slug under its matching version heading", () => {
    expect(codeSites.flatMap(({ file, slug }) => {
      const headings = ledger.get(slug) ?? [];
      return headings.filter((heading) => heading !== slug.split("/")[0])
        .map((heading) => ({ file, slug, heading }));
    })).toEqual([]);
  });
});
