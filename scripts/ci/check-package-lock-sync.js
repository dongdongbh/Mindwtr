#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const SKIP_SPEC_PREFIXES = [
  'file:',
  'workspace:',
  'git+',
  'github:',
  'http:',
  'https:',
  'link:',
  'npm:',
];

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function parseVersion(value) {
  const match = VERSION_PATTERN.exec(String(value).trim());
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

function compareVersions(left, right) {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function satisfiesComparator(version, comparator) {
  const trimmed = comparator.trim();
  if (!trimmed || trimmed === '*' || trimmed.toLowerCase() === 'latest') return true;

  if (trimmed.startsWith('^')) {
    const base = parseVersion(trimmed.slice(1));
    if (!base) return false;
    const current = parseVersion(version);
    if (!current) return false;
    if (compareVersions(current, base) < 0) return false;
    if (base.major > 0) return current.major === base.major;
    if (base.minor > 0) return current.major === 0 && current.minor === base.minor;
    return current.major === 0 && current.minor === 0 && current.patch === base.patch;
  }

  if (trimmed.startsWith('~')) {
    const base = parseVersion(trimmed.slice(1));
    if (!base) return false;
    const current = parseVersion(version);
    if (!current) return false;
    return compareVersions(current, base) >= 0
      && current.major === base.major
      && current.minor === base.minor;
  }

  for (const operator of ['>=', '<=', '>', '<', '=']) {
    if (!trimmed.startsWith(operator)) continue;
    const base = parseVersion(trimmed.slice(operator.length));
    if (!base) return false;
    const current = parseVersion(version);
    if (!current) return false;
    const cmp = compareVersions(current, base);
    if (operator === '>=') return cmp >= 0;
    if (operator === '<=') return cmp <= 0;
    if (operator === '>') return cmp > 0;
    if (operator === '<') return cmp < 0;
    return cmp === 0;
  }

  const exact = parseVersion(trimmed);
  const current = parseVersion(version);
  if (!exact || !current) return false;
  return compareVersions(current, exact) === 0;
}

function satisfiesRange(version, spec) {
  const trimmed = String(spec).trim();
  if (!trimmed) return false;
  const alternatives = trimmed.split('||').map((item) => item.trim()).filter(Boolean);
  return alternatives.some((alternative) => (
    alternative
      .split(/\s+/)
      .filter(Boolean)
      .every((comparator) => satisfiesComparator(version, comparator))
  ));
}

function shouldSkipSpec(spec) {
  return SKIP_SPEC_PREFIXES.some((prefix) => spec.startsWith(prefix));
}

function main() {
  const [packageJsonPath, lockJsonPath] = process.argv.slice(2);
  if (!packageJsonPath || !lockJsonPath) {
    console.error(`Usage: ${path.basename(process.argv[1])} <package.json> <package-lock.json>`);
    process.exit(1);
  }

  const packageJson = readJson(packageJsonPath);
  const lockJson = readJson(lockJsonPath);
  const packages = lockJson.packages || {};

  const missingEntries = [];
  const mismatches = [];

  for (const sectionName of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const section = packageJson[sectionName];
    if (!section || typeof section !== 'object') continue;

    for (const [dependencyName, requestedSpec] of Object.entries(section)) {
      if (typeof requestedSpec !== 'string' || shouldSkipSpec(requestedSpec)) continue;

      const lockedEntry = packages[`node_modules/${dependencyName}`];
      const lockedVersion = lockedEntry && typeof lockedEntry === 'object'
        ? lockedEntry.version
        : undefined;

      if (typeof lockedVersion !== 'string' || !lockedVersion) {
        missingEntries.push(`${sectionName}:${dependencyName}:${requestedSpec}`);
        continue;
      }

      if (!satisfiesRange(lockedVersion, requestedSpec)) {
        mismatches.push({
          sectionName,
          dependencyName,
          requestedSpec,
          lockedVersion,
        });
      }
    }
  }

  if (missingEntries.length > 0 || mismatches.length > 0) {
    if (missingEntries.length > 0) {
      console.error('Package-lock is missing entries for desktop dependencies:');
      for (const item of missingEntries) {
        console.error(`  - ${item}`);
      }
    }
    if (mismatches.length > 0) {
      console.error('Desktop package.json and package-lock.json are out of sync:');
      for (const mismatch of mismatches) {
        console.error(
          `  - ${mismatch.sectionName}:${mismatch.dependencyName} requests ${mismatch.requestedSpec}, lock has ${mismatch.lockedVersion}`
        );
      }
    }
    process.exit(1);
  }

  console.log(`Package.json specs match locked desktop dependencies: ${packageJsonPath}`);
}

main();
