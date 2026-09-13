import { describe, expect, it } from 'bun:test';
import { validateNativeReadiness, summarizeNativeRun } from './native-desktop-report.mjs';

const ready = [
  { name: 'mindwtr.local_data_ready', startTime: 100 },
  { name: 'mindwtr.interactive_ready', startTime: 150 },
];

const expectedCapture = { id: 'captured-0', title: 'Native benchmark capture 0' };
const captureState = (taskCount: number, captures: object[] = []) => ({ taskCount, captures });
const captureRow = (overrides = {}) => ({
  ...expectedCapture,
  status: 'inbox',
  deletedAt: null,
  ...overrides,
});
const validCaptureEvidence = (size: number) => ({
  expected: expectedCapture,
  before: captureState(size),
  after: captureState(size + 1, [captureRow()]),
  reload: captureState(size + 1, [captureRow()]),
  reloadVisible: true,
});
const validSample = (size: number) => ({
  status: 'passed',
  settingsOpenAutomationMs: 15,
  integrationsOpenAutomationMs: 12,
  captureVisibleAutomationMs: 20,
  captureDurableAutomationMs: 25,
  countBefore: size,
  countAfter: size + 1,
  captureEvidence: validCaptureEvidence(size),
  reloadReadiness: { localDataReadyMs: 100, interactiveReadyMs: 150 },
});
const idleObservation = { waitMs: 60, polls: 2, status: {
  core: { queued: 0, immediate: 0, inFlight: false, retrying: false, failed: false, generation: 2 },
  desktop: { pending: 0, generation: 2, failed: false, reconciliationPending: false },
} };
const validInvokeProbe = {
  schemaVersion: 1,
  label: 'native-invoke-completion-v1',
  installedAtMs: 1,
  stoppedAtMs: 12,
  maxRecords: 64,
  overflow: false,
  pendingCount: 0,
  records: [
    { command: 'save_data', sequence: 1, startMs: 2, returnedMs: 5, settledMs: 9, outcome: 'fulfilled' },
    { command: 'get_data', sequence: 2, startMs: 10, returnedMs: 10, settledMs: 11, outcome: 'fulfilled' },
  ],
};
const validIdleSample = (size: number) => ({
  ...validSample(size),
  saveIdle: Object.fromEntries(['initialImport', 'beforeSettings', 'beforeCapture', 'afterCapture']
    .map(boundary => [boundary, structuredClone(idleObservation)])),
});

describe('native desktop measurement contract', () => {
  it('does not confuse a visible shell with canonical interactive readiness', () => {
    expect(() => validateNativeReadiness([{ name: 'mindwtr.shell_ready', startTime: 20 }])).toThrow();
    expect(() => validateNativeReadiness(ready.slice(1))).toThrow();
    expect(validateNativeReadiness(ready)).toEqual({ localDataReadyMs: 100, interactiveReadyMs: 150 });
  });

  it('rejects invalid clocks, reversed ordering, and duplicate readiness marks', () => {
    for (const marks of [
      [...ready, ready[1]],
      [ready[0], { ...ready[1], startTime: 99 }],
      [ready[0], { ...ready[1], startTime: NaN }],
      [{ ...ready[0], startTime: -1 }, ready[1]],
    ]) expect(() => validateNativeReadiness(marks)).toThrow();
  });

  it('does not accept missing measurements, build drift, or failed durability checks', () => {
    const sample = validSample(1000);
    expect(summarizeNativeRun([sample], 1, 'a'.repeat(64), 'a'.repeat(64)).status).toBe('passed');
    expect(() => summarizeNativeRun([sample], 1, 'a'.repeat(64), 'a'.repeat(64), 'idle')).toThrow();
    for (const bad of [ { ...sample, status: 'failed' }, { ...sample, countAfter: 1000 },
      { ...sample, captureDurableAutomationMs: 10 }, { ...sample, settingsOpenAutomationMs: NaN } ]) {
      expect(() => summarizeNativeRun([bad], 1, 'a'.repeat(64), 'a'.repeat(64))).toThrow();
    }
    expect(() => summarizeNativeRun([], 1, 'a'.repeat(64), 'a'.repeat(64))).toThrow();
    expect(() => summarizeNativeRun([sample], 1, 'a'.repeat(64), 'b'.repeat(64))).toThrow();
  });

  it('rejects empty runs, invalid identities, and non-integer task counts', () => {
    const sample = validSample(0);
    expect(() => summarizeNativeRun([], 0, 'a'.repeat(64), 'a'.repeat(64))).toThrow();
    expect(() => summarizeNativeRun([sample], 1, '', '')).toThrow();
    for (const countBefore of [NaN, Infinity, -1, 1.5]) {
      expect(() => summarizeNativeRun([{ ...sample, countBefore, countAfter: countBefore + 1 }],
        1, 'a'.repeat(64), 'a'.repeat(64))).toThrow();
    }
  });

  it('requires every queue-idle boundary in idle reports', () => {
    const sample = validIdleSample(0);
    const summary = () => summarizeNativeRun([sample], 1, 'a'.repeat(64), 'a'.repeat(64), 'idle');
    expect(summary().status).toBe('passed');
    sample.saveIdle.initialImport.polls = 1;
    expect(summary).toThrow();
    sample.saveIdle.initialImport.polls = 2;
    sample.saveIdle.initialImport.status.desktop.pending = 1;
    expect(summary).toThrow();
    sample.saveIdle.initialImport.status.desktop.pending = 0;
    delete sample.saveIdle.afterCapture;
    expect(summary).toThrow();
  });

  it('requires and summarizes completion probes only for the explicit idle cohort', () => {
    const sample = { ...validIdleSample(1000), invokeProbe: validInvokeProbe };
    expect(summarizeNativeRun([sample], 1, 'a'.repeat(64), 'a'.repeat(64))).toEqual({
      status: 'passed',
      sampleCount: 1,
      metrics: expect.any(Object),
    });
    expect(() => summarizeNativeRun([sample], 1, 'a'.repeat(64), 'a'.repeat(64), 'early-session', true)).toThrow();
    const summary = summarizeNativeRun([sample], 1, 'a'.repeat(64), 'a'.repeat(64), 'idle', true);
    expect(summary.invokeProbe).toEqual({
      label: 'native-invoke-completion-v1',
      callCount: 2,
      commandCounts: { save_data: 1, save_task: 0, get_data: 1 },
      metrics: {
        syncReturnMs: { count: 2, medianMs: 1.5, p95Ms: null, minMs: 0, maxMs: 3 },
        settlementWaitMs: { count: 2, medianMs: 2.5, p95Ms: null, minMs: 1, maxMs: 4 },
        totalMs: { count: 2, medianMs: 4, p95Ms: null, minMs: 1, maxMs: 7 },
      },
    });

    const { invokeProbe: _probe, ...missing } = sample;
    expect(() => summarizeNativeRun([missing], 1, 'a'.repeat(64), 'a'.repeat(64), 'idle', true)).toThrow();
    expect(() => summarizeNativeRun([{ ...sample, invokeProbe: { ...validInvokeProbe, overflow: true } }],
      1, 'a'.repeat(64), 'a'.repeat(64), 'idle', true)).toThrow();
  });

  it('requires valid independent capture evidence in both save modes', () => {
    const sample = validSample(1000);
    expect(summarizeNativeRun([sample], 1, 'a'.repeat(64), 'a'.repeat(64)).status).toBe('passed');

    const { captureEvidence: _captureEvidence, ...withoutEvidence } = sample;
    expect(() => summarizeNativeRun([withoutEvidence], 1, 'a'.repeat(64), 'a'.repeat(64))).toThrow();

    for (const captureEvidence of [
      { ...sample.captureEvidence, before: captureState(999) },
      { ...sample.captureEvidence, after: captureState(1001) },
      { ...sample.captureEvidence, reload: captureState(1001, [captureRow({ title: 'Wrong title' })]) },
      { ...sample.captureEvidence, reloadVisible: false },
    ]) expect(() => summarizeNativeRun([{ ...sample, captureEvidence }], 1,
      'a'.repeat(64), 'a'.repeat(64))).toThrow();
  });

  it('requires ordered canonical readiness after reload', () => {
    const sample = validSample(1000);
    for (const reloadReadiness of [
      undefined,
      { localDataReadyMs: NaN, interactiveReadyMs: 150 },
      { localDataReadyMs: -1, interactiveReadyMs: 150 },
      { localDataReadyMs: 151, interactiveReadyMs: 150 },
    ]) expect(() => summarizeNativeRun([{ ...sample, reloadReadiness }], 1,
      'a'.repeat(64), 'a'.repeat(64))).toThrow();
  });
});
