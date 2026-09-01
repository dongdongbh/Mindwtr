import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const releaseNotesDir = path.join(root, "docs/release-notes");

describe("release notes index", () => {
  it("links every versioned release note exactly once", async () => {
    const filenames = (await readdir(releaseNotesDir))
      .filter((name) => /^\d+\.\d+\.\d+(?:-rc\.\d+)?\.md$/.test(name))
      .sort();
    const index = await readFile(path.join(releaseNotesDir, "README.md"), "utf8");
    const indexed = Array.from(index.matchAll(/\]\(\.\/([^/)]+\.md)\)/g), (match) => match[1])
      .filter((name) => name !== "unreleased.md")
      .sort();

    expect(indexed).toEqual(filenames);
  });

  it("starts unreleased notes after the latest indexed stable release", async () => {
    const index = await readFile(path.join(releaseNotesDir, "README.md"), "utf8");
    const stableVersions = Array.from(
      index.matchAll(/\]\(\.\/(\d+)\.(\d+)\.(\d+)\.md\)/g),
      (match) => match.slice(1, 4).map(Number),
    ).sort((left, right) => {
      for (let index = 0; index < 3; index += 1) {
        if (left[index] !== right[index]) return right[index] - left[index];
      }
      return 0;
    });
    const latest = stableVersions[0];
    expect(latest).toBeDefined();

    const unreleased = await readFile(
      path.join(releaseNotesDir, "unreleased.md"),
      "utf8",
    );
    expect(unreleased).toContain(
      `Changes collected after \`v${latest.join(".")}\` and before the next version tag.`,
    );
  });
});
