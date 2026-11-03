import { test } from 'bun:test';


const hasPwsh = Bun.which('pwsh') !== null;

if (!hasPwsh && process.env.CI) {
  throw new Error('PowerShell (pwsh) is required in CI for the Windows workflow tests.');
}
if (!hasPwsh) {
  console.warn(
    '[scripts/ci] PowerShell (pwsh) not found: skipping tests that run Windows workflow scripts. Install PowerShell 7 to run them.',
  );
}

export const pwshTest = test.skipIf(!hasPwsh);
