import { describe, expect, it } from 'bun:test';
import { compareReports, summarize } from './report.mjs';

const metadata = { platform: 'android', runtime: 'native', device: 'test-phone', os: '16', buildType: 'release', dataset: 'typical-v1', network: 'offline', scenario: 'cold' };
const report = (values: number[]) => ({ schemaVersion: 1, metadata, invalidSamples: 0, metrics: { startup: summarize(values) } });
describe('performance reports', () => {
  it('rejects malformed or unqualified reports', () => {
    expect(compareReports(null, {}).comparable).toBe(false);
    const valid = report(Array(30).fill(100));
    expect(compareReports(valid, { ...valid, invalidSamples: undefined }).comparable).toBe(false);
    expect(compareReports(valid, { ...valid, metrics: { startup: null } }).comparable).toBe(false);
  });
  it('uses the median, excludes invalid values, and does not invent a small-sample p95', () => {
    expect(summarize([30, 10, 20, 40, NaN, -1])).toEqual({ count: 4, medianMs: 25, p95Ms: null, minMs: 10, maxMs: 40 });
    expect(summarize([]).medianMs).toBeNull();
  });
  it('compares like-for-like runs using both an absolute and relative noise floor', () => {
    const baseline = report(Array(30).fill(100));
    expect(compareReports(baseline, report(Array(30).fill(110))).regressions).toEqual([]);
    expect(compareReports(baseline, report(Array(30).fill(150))).regressions).toHaveLength(1);
    expect(compareReports(baseline, { ...baseline, metadata: { ...metadata, scenario: 'hot' } }).comparable).toBe(false);
    expect(compareReports(baseline, { ...baseline, invalidSamples: 1 }).comparable).toBe(false);
    expect(compareReports(baseline, report([100])).comparable).toBe(false);
    const hosted = { ...baseline, metadata: { ...metadata, device: 'github-hosted-variable-hardware' } };
    expect(compareReports(hosted, hosted).comparable).toBe(false);
  });
  it('only gates tails with enough observations', () => {
    const baseline = report(Array(100).fill(100));
    const candidate = report([...Array(90).fill(100), ...Array(10).fill(200)]);
    expect(compareReports(baseline, candidate).regressions.map((r) => r.statistic)).toEqual(['p95Ms']);
  });
});
