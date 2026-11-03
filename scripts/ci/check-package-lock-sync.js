#!/usr/bin/env node


const fs = require('fs');
const path = require('path');

const ROOT_PACKAGE_JSON = path.resolve(__dirname, '..', '..', 'package.json');
const STRICT_NESTED_DEV = process.env.MINDWTR_LOCK_OVERRIDE_STRICT === '1';
const NODE_MODULES_SEGMENT = 'node_modules/';

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


function collectOverrideDivergences(lockJson) {
  const rootPackageJson = readJson(ROOT_PACKAGE_JSON);
  const pins = Object.entries(rootPackageJson.overrides || {})
    .filter(([, pinnedSpec]) => typeof pinnedSpec === 'string');
  if (pins.length === 0) return { failures: [], warnings: [] };

  const pinnedVersions = new Map(pins);
  const failures = [];
  const warnings = [];

  for (const [lockPath, entry] of Object.entries(lockJson.packages || {})) {
    const segmentIndex = lockPath.lastIndexOf(NODE_MODULES_SEGMENT);
    if (segmentIndex === -1) continue;
    if (!entry || typeof entry.version !== 'string') continue;

    const dependencyName = lockPath.slice(segmentIndex + NODE_MODULES_SEGMENT.length);
    const pinnedSpec = pinnedVersions.get(dependencyName);
    if (!pinnedSpec) continue;

    const pinned = parseVersion(pinnedSpec);
    const resolved = parseVersion(entry.version);
    if (!pinned || !resolved) continue;

    const comparison = compareVersions(resolved, pinned);
    if (comparison === 0) continue;

    const isNested = lockPath.indexOf(NODE_MODULES_SEGMENT) !== segmentIndex;
    const isDevOnly = entry.dev === true;
    const divergence = {
      dependencyName,
      pinnedSpec,
      resolvedVersion: entry.version,
      lockPath,
    };

    if (comparison > 0) {
      warnings.push({ ...divergence, reason: 'newer than the pin' });
    } else if (isNested && isDevOnly && !STRICT_NESTED_DEV) {
      warnings.push({ ...divergence, reason: 'older than the pin, nested dev-only path' });
    } else {
      failures.push(divergence);
    }
  }

  return { failures, warnings };
}

function main() {
  const args = process.argv.slice(2);
  const checkOverrides = args.includes('--check-overrides');
  const [packageJsonPath, lockJsonPath] = args.filter((arg) => !arg.startsWith('--'));
  if (!packageJsonPath || !lockJsonPath) {
    console.error(
      `Usage: ${path.basename(process.argv[1])} <package.json> <package-lock.json> [--check-overrides]`
    );
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

  const { failures: overrideFailures, warnings: overrideWarnings } = checkOverrides
    ? collectOverrideDivergences(lockJson)
    : { failures: [], warnings: [] };

  for (const warning of overrideWarnings) {
    console.warn(
      `warn: ${warning.dependencyName} is pinned to ${warning.pinnedSpec} in the root overrides, `
      + `lock has ${warning.resolvedVersion} at ${warning.lockPath} (${warning.reason})`
    );
  }

  if (missingEntries.length > 0 || mismatches.length > 0 || overrideFailures.length > 0) {
    if (missingEntries.length > 0) {
      console.error('Package-lock is missing entries for package dependencies:');
      for (const item of missingEntries) {
        console.error(`  - ${item}`);
      }
    }
    if (mismatches.length > 0) {
      console.error('Package.json and package-lock.json are out of sync:');
      for (const mismatch of mismatches) {
        console.error(
          `  - ${mismatch.sectionName}:${mismatch.dependencyName} requests ${mismatch.requestedSpec}, lock has ${mismatch.lockedVersion}`
        );
      }
    }
    if (overrideFailures.length > 0) {
      console.error('Package-lock resolves versions below the root overrides pins:');
      for (const failure of overrideFailures) {
        console.error(
          `  - ${failure.dependencyName} pinned to ${failure.pinnedSpec}, `
          + `lock has ${failure.resolvedVersion} at ${failure.lockPath}`
        );
      }
      console.error(
        `Add the missing pins to the "overrides" block of ${packageJsonPath}, then regenerate with:`
      );
      console.error(
        `  npm install --package-lock-only --prefix ${path.dirname(packageJsonPath)} --legacy-peer-deps --workspaces=false`
      );
    }
    process.exit(1);
  }

  console.log(`Package.json specs match locked dependencies: ${packageJsonPath}`);
  if (checkOverrides) {
    console.log(`Locked versions honor the root overrides pins: ${lockJsonPath}`);
  }
}

main();
