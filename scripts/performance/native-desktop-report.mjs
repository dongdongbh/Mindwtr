import assert from 'node:assert/strict';
import { summarize } from './report.mjs';
import { isNativeSaveIdle } from './native-save-idle.mjs';
import { validateNativeCaptureEvidence } from './native-capture-storage.mjs';
import { validateNativeInvokeProbe } from './native-invoke-probe.mjs';

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

export function summarizeNativeRun(samples, runs, initialHash, finalHash, saveQueueMode = 'early-session', invokeProbeEnabled = false) {
  assert(['idle', 'early-session'].includes(saveQueueMode), 'Invalid save-queue mode');
  assert.equal(typeof invokeProbeEnabled, 'boolean', 'Invalid native invoke probe flag');
  if (invokeProbeEnabled) assert.equal(saveQueueMode, 'idle', 'Native invoke probe requires idle save mode');
  assert(Number.isInteger(runs) && runs > 0 && runs <= 100, 'Invalid native run count');
  assert(typeof initialHash === 'string' && /^[a-f0-9]{64}$/.test(initialHash), 'Invalid native binary identity');
  assert.equal(initialHash, finalHash, 'Native binary changed during measurement');
  assert.equal(samples.length, runs, 'Incomplete native samples');
  const names = ['settingsOpenAutomationMs', 'integrationsOpenAutomationMs',
    'captureVisibleAutomationMs', 'captureDurableAutomationMs'];
  const invokeRecords = [];
  const invokeCommandCounts = { save_data: 0, save_task: 0, get_data: 0 };
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
    if (invokeProbeEnabled) {
      const summary = validateNativeInvokeProbe(sample.invokeProbe);
      invokeRecords.push(...sample.invokeProbe.records);
      for (const command of Object.keys(invokeCommandCounts)) {
        invokeCommandCounts[command] += summary.commandCounts[command];
      }
    }
  }
  const result = { status: 'passed', sampleCount: samples.length,
    metrics: Object.fromEntries(names.map(name => [name, summarize(samples.map(sample => sample[name]))])) };
  if (invokeProbeEnabled) result.invokeProbe = {
    label: 'native-invoke-completion-v1',
    callCount: invokeRecords.length,
    commandCounts: invokeCommandCounts,
    metrics: {
      syncReturnMs: summarize(invokeRecords.map(record => record.returnedMs - record.startMs)),
      settlementWaitMs: summarize(invokeRecords.map(record => record.settledMs - record.returnedMs)),
      totalMs: summarize(invokeRecords.map(record => record.settledMs - record.startMs)),
    },
  };
  return result;
}
