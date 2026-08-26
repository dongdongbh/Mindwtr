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
});
