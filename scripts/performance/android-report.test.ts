import { describe, expect, it } from 'bun:test';
import { parseAndroidReport } from './android-report.mjs';

describe('Android reports', () => {
  it('fails samples with missing or malformed metrics instead of silently dropping them', () => {
    const report = parseAndroidReport('run,total_time_ms,sample_quality\n1,200,ok\n2,NaN,ok\n3,300,ok',
      'run\tphase\tduration_ms\n1\tjs.interactive_ready\t400\n2\tjs.interactive_ready\t500', { scenario: 'cold' });
    expect(report.invalidSamples).toBe(2);
    expect(report.metrics.initialDisplay.count).toBe(1);
    expect(report.metrics.jsInteractive.count).toBe(1);
  });
  it('excludes invalid runs from native and JS timings', () => {
    const csv = 'run,total_time_ms,sample_quality\n1,200,ok\n2,10,crash_detected\n3,,missing_total_time';
    const phases = 'run\tphase\tsince_js_start_ms\n1\tjs.interactive_ready\t350\n2\tjs.interactive_ready\t20';
    const report = parseAndroidReport(csv, phases, { scenario: 'cold' });
    expect(report.invalidSamples).toBe(2);
    expect(report.metrics.initialDisplay.medianMs).toBe(200);
    expect(report.metrics.jsInteractive.medianMs).toBe(350);
  });
  it('keeps resume durations separate from the process-long JS clock', () => {
    const report = parseAndroidReport('run,total_time_ms,sample_quality\n1,40,ok',
      'run\tphase\tduration_ms\n1\tjs.resume_ready\t12\n1\tjs.splash_hidden\t9999', { scenario: 'hot' });
    expect(report.metrics.jsResume.medianMs).toBe(12);
    expect(report.metrics.jsInteractive).toBeUndefined();
  });
});
