#!/usr/bin/env node

const fs = require('fs');

const [measurementsPath] = process.argv.slice(2);

if (!measurementsPath) {
  console.error('Usage: write-perf-summary.js <measurements.json>');
  process.exit(2);
}

if (!fs.existsSync(measurementsPath)) {
  console.error(`Perf measurements missing at ${measurementsPath}`);
  process.exit(1);
}

const measurements = JSON.parse(fs.readFileSync(measurementsPath, 'utf8'));

const rows = measurements.map(({ label, size, actualMs, budgetMs }) => (
  `| ${label} | ${size.toLocaleString()} | ${actualMs.toFixed(2)}ms | ${budgetMs}ms |`
));

const lines = [
  '### Large-store performance budgets',
  '',
  '| Operation | Size | Actual | Budget |',
  '| --- | ---: | ---: | ---: |',
  ...rows,
  '',
];

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
} else {
  console.log(lines.join('\n'));
}
