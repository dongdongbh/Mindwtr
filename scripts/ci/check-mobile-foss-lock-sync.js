#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const mobilePackagePath = path.join(repoRoot, 'apps/mobile/package.json');
const mobileLockPath = path.join(repoRoot, 'apps/mobile/package-lock.json');
const corePackagePath = path.join(repoRoot, 'packages/core/package.json');


const { applyPackageManifestChanges } = require(
  path.join(repoRoot, 'apps/mobile/scripts/fdroid_strip_deps.js')
);

const pkg = JSON.parse(fs.readFileSync(mobilePackagePath, 'utf8'));
applyPackageManifestChanges(pkg, false);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindwtr-mobile-foss-package-'));
const tmpMobileDir = path.join(tmpDir, 'apps/mobile');
const tmpCoreDir = path.join(tmpDir, 'packages/core');
const tmpPackagePath = path.join(tmpMobileDir, 'package.json');
const tmpLockPath = path.join(tmpMobileDir, 'package-lock.json');

fs.mkdirSync(tmpMobileDir, { recursive: true });
fs.mkdirSync(tmpCoreDir, { recursive: true });
fs.writeFileSync(tmpPackagePath, `${JSON.stringify(pkg, null, 2)}\n`);
fs.copyFileSync(mobileLockPath, tmpLockPath);
fs.copyFileSync(corePackagePath, path.join(tmpCoreDir, 'package.json'));

let status = 1;
try {
  const manifestCheck = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts/ci/check-package-lock-sync.js'),
      tmpPackagePath,
      tmpLockPath,
    ],
    { stdio: 'inherit' }
  );

  if ((manifestCheck.status ?? 1) === 0) {
    const npmCheck = spawnSync(
      'npm',
      [
        'ci',
        '--package-lock-only',
        '--workspaces=false',
        '--legacy-peer-deps',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--prefix',
        tmpMobileDir,
      ],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          npm_config_cache: path.join(tmpDir, '.npm-cache'),
        },
      }
    );
    status = npmCheck.status ?? 1;
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

process.exit(status);
