import { describe, expect, it } from 'bun:test';
import { runInNewContext } from 'node:vm';
import {
  installNativeInvokeProbe,
  stopNativeInvokeProbe,
  validateNativeInvokeProbe,
} from './native-invoke-probe.mjs';

const createHarness = (invoke: (...args: any[]) => any) => {
  const clock = { now: 1 };
  const tauriInternals = {} as any;
  Object.defineProperty(tauriInternals, 'invoke', { value: () => 'immutable-tauri', writable: false, configurable: false });
  const transport = { schemaVersion: 1, label: 'mindwtr-native-invoke-transport-v1', invoke };
  const browser = { __TAURI_INTERNALS__: tauriInternals, __mindwtrNativeInvokeTransport: transport } as any;
  const context = { window: browser, performance: { now: () => clock.now } };
  const install = () => runInNewContext(`(${installNativeInvokeProbe.toString()})()`, context);
  const stop = () => runInNewContext(`(${stopNativeInvokeProbe.toString()})()`, context);
  return { browser, clock, install, stop, tauriInternals, transport };
};

describe('native invoke completion probe', () => {
  it('preserves the receiver, arguments, promise, and fulfilled result across delayed boundaries', async () => {
    let resolve!: (value: object) => void;
    const result = { durable: true };
    const promise = new Promise<object>(done => { resolve = done; });
    let received: { receiver: unknown; args: unknown[] } | undefined;
    const harness = createHarness(function (...args) {
      received = { receiver: this, args };
      harness.clock.now = 12;
      return promise;
    });

    harness.install();
    harness.clock.now = 10;
    const payload = { title: 'private capture' };
    const returned = harness.transport.invoke('save_data', payload);
    expect(returned).toBe(promise);
    expect(received).toEqual({ receiver: harness.transport, args: ['save_data', payload] });

    harness.clock.now = 40;
    resolve(result);
    expect(await returned).toBe(result);
    harness.clock.now = 50;
    const evidence = harness.stop();

    expect(validateNativeInvokeProbe(evidence)).toEqual({
      label: 'native-invoke-completion-v1',
      callCount: 1,
      commandCounts: { save_data: 1, save_task: 0, get_data: 0 },
    });
    expect(evidence.records).toEqual([{
      command: 'save_data', sequence: 1, startMs: 10, returnedMs: 12, settledMs: 40, outcome: 'fulfilled',
    }]);
  });

  it('preserves rejected promises and synchronous results and exceptions', async () => {
    const rejection = new Error('private rejection');
    const thrown = new Error('private throw');
    const synchronous = { same: true };
    let rejectedPromise!: Promise<never>;
    const harness = createHarness((command) => {
      harness.clock.now += 1;
      if (command === 'save_data') return synchronous;
      if (command === 'save_task') return rejectedPromise;
      throw thrown;
    });
    rejectedPromise = Promise.reject(rejection);
    harness.install();

    harness.clock.now = 10;
    expect(harness.transport.invoke('save_data')).toBe(synchronous);
    harness.clock.now = 20;
    const returned = harness.transport.invoke('save_task');
    expect(returned).toBe(rejectedPromise);
    expect(await returned.catch((error: unknown) => error)).toBe(rejection);
    harness.clock.now = 30;
    expect(() => harness.transport.invoke('get_data')).toThrow(thrown);
    harness.clock.now = 40;

    const evidence = harness.stop();
    expect(evidence.records.map((record: any) => record.outcome)).toEqual(['fulfilled', 'rejected', 'threw']);
    expect(JSON.stringify(evidence)).not.toContain('private');
    expect(validateNativeInvokeProbe(evidence).callCount).toBe(3);
  });

  it('observes only the allowlist without retaining arguments, values, or errors', () => {
    const secret = 'never-retain-this-title';
    const calls: unknown[][] = [];
    const harness = createHarness(function (...args) {
      calls.push(args);
      return { secret, receiver: this };
    });
    harness.install();
    const payload = { title: secret };
    const ignored = harness.transport.invoke('get_sync_backend', payload);
    const observed = harness.transport.invoke('save_task', payload);
    harness.clock.now = 5;
    const evidence = harness.stop();

    expect(ignored.secret).toBe(secret);
    expect(observed.secret).toBe(secret);
    expect(calls).toEqual([['get_sync_backend', payload], ['save_task', payload]]);
    expect(evidence.records.map((record: any) => record.command)).toEqual(['save_task']);
    expect(JSON.stringify(evidence)).not.toContain(secret);
  });

  it('rejects duplicate installation and an unavailable invoke callable', () => {
    const harness = createHarness(() => undefined);
    harness.install();
    expect(harness.install).toThrow('already installed');
    harness.stop();
    expect(() => runInNewContext(`(${installNativeInvokeProbe.toString()})()`, {
      window: { __mindwtrNativeInvokeTransport: { schemaVersion: 1, label: 'mindwtr-native-invoke-transport-v1', invoke: null } },
      performance: { now: () => 1 },
    })).toThrow('callable unavailable');
  });

  it('restores its original method, leaves immutable Tauri internals untouched, and invalidates member ownership loss', () => {
    const original = () => 'original';
    const harness = createHarness(original);
    const internalDescriptor = Object.getOwnPropertyDescriptor(harness.tauriInternals, 'invoke');
    harness.install();
    expect(harness.transport.invoke).not.toBe(original);
    expect(Object.getOwnPropertyDescriptor(harness.tauriInternals, 'invoke')).toEqual(internalDescriptor);
    harness.stop();
    expect(harness.transport.invoke).toBe(original);

    harness.install();
    harness.transport.invoke('save_data');
    const laterOwner = () => 'later';
    harness.transport.invoke = laterOwner;
    const evidence = harness.stop();
    expect(harness.transport.invoke).toBe(laterOwner);
    expect(harness.browser.__mindwtrNativeInvokeCompletionProbeV1).toBeUndefined();
    expect(() => validateNativeInvokeProbe(evidence)).toThrow();
  });

  it('invalidates global transport ownership loss while restoring only its still-owned member', () => {
    const original = () => 'original';
    const harness = createHarness(original);
    harness.install();
    harness.transport.invoke('save_data');
    const laterTarget = {
      schemaVersion: 1,
      label: 'mindwtr-native-invoke-transport-v1',
      invoke: () => 'later',
    };
    harness.browser.__mindwtrNativeInvokeTransport = laterTarget;

    const evidence = harness.stop();

    expect(harness.transport.invoke).toBe(original);
    expect(harness.browser.__mindwtrNativeInvokeTransport).toBe(laterTarget);
    expect(harness.browser.__mindwtrNativeInvokeCompletionProbeV1).toBeUndefined();
    expect(() => validateNativeInvokeProbe(evidence)).toThrow();
  });

  it('returns a result unchanged but invalidates evidence when its then getter or attachment throws', () => {
    const getterResult = Object.defineProperty({}, 'then', {
      get() { throw new Error('private getter failure'); },
    });
    const getterHarness = createHarness(() => getterResult);
    getterHarness.install();
    expect(getterHarness.transport.invoke('save_data')).toBe(getterResult);
    getterHarness.clock.now = 5;
    const getterEvidence = getterHarness.stop();
    expect(JSON.stringify(getterEvidence)).not.toContain('private');
    expect(() => validateNativeInvokeProbe(getterEvidence)).toThrow();

    const attachmentResult = {
      then() { throw new Error('private attachment failure'); },
    };
    const attachmentHarness = createHarness(() => attachmentResult);
    attachmentHarness.install();
    expect(attachmentHarness.transport.invoke('save_task')).toBe(attachmentResult);
    attachmentHarness.clock.now = 5;
    const attachmentEvidence = attachmentHarness.stop();
    expect(JSON.stringify(attachmentEvidence)).not.toContain('private');
    expect(() => validateNativeInvokeProbe(attachmentEvidence)).toThrow();
  });

  it('returns detached pending evidence and rejects pending or overflowed samples', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>(done => { resolve = done; });
    const pendingHarness = createHarness(() => pending);
    pendingHarness.install();
    pendingHarness.transport.invoke('save_data');
    pendingHarness.clock.now = 5;
    const pendingEvidence = pendingHarness.stop();
    expect(pendingEvidence.pendingCount).toBe(1);
    expect(() => validateNativeInvokeProbe(pendingEvidence)).toThrow('pending calls');
    resolve();
    await pending;
    expect(pendingEvidence).toEqual({ ...pendingEvidence, records: [] });

    const overflowHarness = createHarness(() => undefined);
    overflowHarness.install();
    for (let index = 0; index < 65; index += 1) {
      overflowHarness.transport.invoke('save_task');
    }
    overflowHarness.clock.now = 5;
    const overflowEvidence = overflowHarness.stop();
    expect(overflowEvidence.records).toHaveLength(64);
    expect(overflowEvidence.overflow).toBe(true);
    expect(() => validateNativeInvokeProbe(overflowEvidence)).toThrow('overflowed');
  });

  it('rejects malformed shapes, clock reversals, invalid enums, and sequence gaps', () => {
    const valid = {
      schemaVersion: 1,
      label: 'native-invoke-completion-v1',
      installedAtMs: 1,
      stoppedAtMs: 5,
      maxRecords: 64,
      overflow: false,
      pendingCount: 0,
      records: [{
        command: 'save_data', sequence: 1, startMs: 2, returnedMs: 3, settledMs: 4, outcome: 'fulfilled',
      }],
    };
    expect(validateNativeInvokeProbe(valid).callCount).toBe(1);

    const invalid = [
      { ...valid, payload: { title: 'private' } },
      { ...valid, schemaVersion: 2 },
      { ...valid, label: 'other' },
      { ...valid, installedAtMs: NaN },
      { ...valid, stoppedAtMs: 0 },
      { ...valid, maxRecords: 63 },
      { ...valid, overflow: true },
      { ...valid, pendingCount: 1 },
      { ...valid, records: [{ ...valid.records[0], command: 'other' }] },
      { ...valid, records: [{ ...valid.records[0], outcome: 'pending' }] },
      { ...valid, records: [{ ...valid.records[0], sequence: 2 }] },
      { ...valid, records: [{ ...valid.records[0], startMs: 0 }] },
      { ...valid, records: [{ ...valid.records[0], returnedMs: 1 }] },
      { ...valid, records: [{ ...valid.records[0], settledMs: 2 }] },
      { ...valid, stoppedAtMs: 3 },
      { ...valid, records: [{ ...valid.records[0], result: 'private' }] },
      { ...valid, records: [{ ...valid.records[0], settledMs: Infinity }] },
      { ...valid, records: [] },
    ];
    for (const probe of invalid) expect(() => validateNativeInvokeProbe(probe)).toThrow();
  });
});
