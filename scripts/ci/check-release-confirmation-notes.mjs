import { readFile } from 'node:fs/promises';
import { requireConfirmationIssueList } from './notify-release-confirmations.mjs';

const [path] = process.argv.slice(2);
try {
  if (!path) throw new Error('Usage: node scripts/ci/check-release-confirmation-notes.mjs <release-notes.md>');
  requireConfirmationIssueList(await readFile(path, 'utf8'));
} catch (error) {
  console.error(path ? `${path}: ${error.message}` : error.message);
  process.exitCode = 1;
}
