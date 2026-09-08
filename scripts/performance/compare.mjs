import { compareReports, readReport } from './report.mjs';

const [baseline, candidate] = process.argv.slice(2);
if (!baseline || !candidate) {
  console.error('Usage: node scripts/performance/compare.mjs baseline.json candidate.json');
  process.exitCode = 2;
} else {
  try {
    const result = compareReports(readReport(baseline), readReport(candidate));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = !result.comparable ? 2 : result.regressions.length ? 1 : 0;
  } catch (error) {
    console.error(`Unable to compare reports: ${error.message}`);
    process.exitCode = 2;
  }
}
