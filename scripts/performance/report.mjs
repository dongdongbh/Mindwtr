import { readFileSync } from 'node:fs';

export function summarize(values) {
  const sorted = values.filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return { count: 0, medianMs: null, p95Ms: null, minMs: null, maxMs: null };
  const middle = Math.floor(n / 2);
  return {
    count: n,
    medianMs: n % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95Ms: n >= 20 ? sorted[Math.ceil(n * 0.95) - 1] : null,
    minMs: sorted[0], maxMs: sorted[n - 1],
  };
}

// These identities must match. Revisions and APK hashes deliberately differ in A/B runs.
export const COMPARISON_FIELDS = ['platform', 'runtime', 'device', 'os', 'buildType', 'dataset', 'network', 'scenario'];
export function compareReports(baseline, candidate, { relative = 0.15, absoluteMs = 20, minSamples = 30 } = {}) {
  if (!baseline || !candidate || typeof baseline !== 'object' || typeof candidate !== 'object') {
    return { comparable: false, errors: ['Expected two report objects'], regressions: [] };
  }
  const errors = [];
  for (const report of [baseline, candidate]) {
    if (report.metadata?.profiling && report.metadata.profiling !== 'none') {
      errors.push('Profiled runs are diagnostic only, not timing comparisons');
      break;
    }
  }
  for (const field of COMPARISON_FIELDS) {
    const left = baseline.metadata?.[field];
    const right = candidate.metadata?.[field];
    if (typeof left !== 'string' || typeof right !== 'string' || !left || !right || left === 'unknown' || right === 'unknown' || left !== right) errors.push(`Incompatible ${field}`);
  }
  if (baseline.schemaVersion !== 1 || candidate.schemaVersion !== 1) errors.push('Unsupported report version');
  if (String(baseline.metadata?.device).includes('variable-hardware') || String(candidate.metadata?.device).includes('variable-hardware')) errors.push('Hosted variable hardware is reporting-only');
  if (baseline.invalidSamples !== 0 || candidate.invalidSamples !== 0) errors.push('Invalid samples must be investigated before comparison');
  const regressions = [];
  for (const [name, before] of Object.entries(baseline.metrics ?? {})) {
    const after = candidate.metrics?.[name];
    if (!before || !after || !Number.isInteger(before.count) || !Number.isInteger(after.count) || before.count < minSamples || after.count < minSamples) { errors.push(`Insufficient samples: ${name}`); continue; }
    for (const statistic of ['medianMs', 'p95Ms']) {
      // Tail gates need enough observations; never sell a ten-launch p95 as reliable.
      if (statistic === 'p95Ms' && Math.min(before.count, after.count) < 100) continue;
      const a = before[statistic]; const b = after[statistic];
      if (!Number.isFinite(a) || !Number.isFinite(b)) { errors.push(`Invalid metric: ${name}.${statistic}`); continue; }
      if (b - a > Math.max(absoluteMs, a * relative)) regressions.push({ name, statistic, baselineMs: a, candidateMs: b });
    }
  }
  if (!Object.keys(baseline.metrics ?? {}).length) errors.push('No baseline metrics');
  return { comparable: errors.length === 0, errors, regressions };
}

export function readReport(path) { return JSON.parse(readFileSync(path, 'utf8')); }
