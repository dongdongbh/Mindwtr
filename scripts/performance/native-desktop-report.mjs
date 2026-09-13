import assert from 'node:assert/strict';
import { summarize } from './report.mjs';
import { isNativeSaveIdle } from './native-save-idle.mjs';
import { validateNativeCaptureEvidence } from './native-capture-storage.mjs';

export function validateNativeReadiness(marks) {
  const read = name => {
    const matches = marks.filter(mark => mark.name === `mindwtr.${name}`);
    assert.equal(matches.length, 1, `Missing or duplicate ${name}`);
    const value = matches[0].startTime;
    assert(Number.isFinite(value) && value >= 0, `Invalid ${name} clock`);
    return value;
  };
  const localDataReadyMs = read('local_data_ready');
  const interactiveReadyMs = read('interactive_ready');
  assert(interactiveReadyMs >= localDataReadyMs, 'Interactive readiness precedes canonical data');
  return { localDataReadyMs, interactiveReadyMs };
}

export function summarizeNativeRun(samples, runs, initialHash, finalHash, saveQueueMode = 'early-session') {
  assert(['idle', 'early-session'].includes(saveQueueMode), 'Invalid save-queue mode');
  assert(Number.isInteger(runs) && runs > 0 && runs <= 100, 'Invalid native run count');
  assert(typeof initialHash === 'string' && /^[a-f0-9]{64}$/.test(initialHash), 'Invalid native binary identity');
  assert.equal(initialHash, finalHash, 'Native binary changed during measurement');
  assert.equal(samples.length, runs, 'Incomplete native samples');
  const names = ['settingsOpenAutomationMs', 'integrationsOpenAutomationMs',
    'captureVisibleAutomationMs', 'captureDurableAutomationMs'];
  for (const sample of samples) {
    assert.equal(sample.status, 'passed', 'Invalid native sample');
    if (saveQueueMode === 'idle') {
      for (const boundary of ['initialImport', 'beforeSettings', 'beforeCapture', 'afterCapture']) {
        const observation = sample.saveIdle?.[boundary];
        assert(observation && Number.isFinite(observation.waitMs) && observation.waitMs >= 0,
          `Missing save-idle observation: ${boundary}`);
        assert(Number.isSafeInteger(observation.polls) && observation.polls >= 2, 'Incomplete idle observation');
        assert(isNativeSaveIdle(observation.status), 'Save queue was not idle');
      }
    }
    for (const name of names) assert(Number.isFinite(sample[name]) && sample[name] >= 0, `Invalid ${name}`);
    assert(Number.isInteger(sample.countBefore) && sample.countBefore >= 0, 'Invalid native task count');
    assert.equal(sample.countAfter, sample.countBefore + 1, 'Capture not durable');
    validateNativeCaptureEvidence(sample.captureEvidence, sample.countBefore);
    const { localDataReadyMs, interactiveReadyMs } = sample.reloadReadiness ?? {};
    assert(Number.isFinite(localDataReadyMs) && localDataReadyMs >= 0, 'Invalid reload local-data readiness');
    assert(Number.isFinite(interactiveReadyMs) && interactiveReadyMs >= localDataReadyMs,
      'Invalid reload interactive readiness');
    assert(sample.captureDurableAutomationMs >= sample.captureVisibleAutomationMs, 'Invalid capture timing order');
  }
  return { status: 'passed', sampleCount: samples.length,
    metrics: Object.fromEntries(names.map(name => [name, summarize(samples.map(sample => sample[name]))])) };
}
