import { describe, expect, it, vi } from 'vitest';

import {
  APPLE_IMAGE_LIMITS,
  AppleImageEvaluationController,
  parseAppleImageModelProposal,
  validateAppleImageSelection,
  type AppleImageNativeBridge,
  type AppleImageNativeResult,
  type AppleImageModelAvailability,
} from './apple-image-evaluation';

const selection = {
  uri: 'file:///system-picker/receipt.jpg',
  width: 1_200,
  height: 1_600,
  inputBytes: 420_000,
};

const nativeResult: AppleImageNativeResult = {
  modelOutput: JSON.stringify({ title: 'Send the reimbursement form', description: 'Receipt total: $24' }),
  ocrText: 'Reimbursement form\nReceipt total: $24',
  inputBytes: selection.inputBytes,
  width: selection.width,
  height: selection.height,
  modelDurationMs: 320,
  ocrDurationMs: 40,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function idFactory() {
  let value = 0;
  return () => `00000000-0000-4000-8000-${String(++value).padStart(12, '0')}`;
}

function bridge(overrides: Partial<AppleImageNativeBridge> = {}): AppleImageNativeBridge {
  return {
    getAvailability: vi.fn(async (): Promise<AppleImageModelAvailability> => ({
      bridgeAvailable: true,
      modelAvailable: true,
      reason: 'available',
    })),
    analyzeImage: vi.fn(async () => nativeResult),
    cancelAnalysis: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('Apple image proposal validation', () => {
  it('rejects malformed model output and ignores uncertain or dangerous metadata', () => {
    expect(parseAppleImageModelProposal('title: call Pat')).toBeNull();
    expect(parseAppleImageModelProposal(JSON.stringify({ description: 'missing title' }))).toBeNull();
    expect(parseAppleImageModelProposal(JSON.stringify({
      title: 'Check the conference date',
      description: 'The poster might say May 2',
      dueDate: '2027-05-02',
      startTime: '2027-05-01T09:00:00-04:00',
      reminder: true,
      completed: true,
      projectId: 'injected',
    }))).toEqual({
      title: 'Check the conference date',
      description: 'The poster might say May 2',
    });
  });

  it('rejects known byte, pixel, dimension, and non-local input limits before native analysis', () => {
    expect(validateAppleImageSelection(selection)).toBeNull();
    expect(validateAppleImageSelection({ ...selection, uri: 'https://example.test/a.jpg' })).toMatch(/local/);
    expect(validateAppleImageSelection({ ...selection, inputBytes: APPLE_IMAGE_LIMITS.maxInputBytes + 1 })).toMatch(/file/);
    expect(validateAppleImageSelection({ ...selection, width: APPLE_IMAGE_LIMITS.maxDimension + 1 })).toMatch(/large/);
    expect(validateAppleImageSelection({ ...selection, width: 8_000, height: 8_000 })).toMatch(/large/);
  });
});

describe('AppleImageEvaluationController analysis', () => {
  it('falls back to the local OCR proposal when model output is malformed', async () => {
    const nativeBridge = bridge({
      analyzeImage: vi.fn(async () => ({ ...nativeResult, modelOutput: '{bad json' })),
    });
    const controller = new AppleImageEvaluationController(nativeBridge, idFactory());
    controller.selectImage(selection);

    await controller.analyze();

    expect(controller.getSnapshot().comparison?.model.status).toBe('malformed');
    expect(controller.getSnapshot().proposalSource).toBe('ocr');
    expect(controller.getSnapshot().proposal).toEqual({
      title: 'Reimbursement form',
      description: 'Receipt total: $24',
    });
  });

  it('uses the OCR baseline when the iOS 27 model is unavailable', async () => {
    const nativeBridge = bridge({
      getAvailability: vi.fn(async (): Promise<AppleImageModelAvailability> => ({
        bridgeAvailable: true,
        modelAvailable: false,
        reason: 'deviceNotEligible',
      })),
      analyzeImage: vi.fn(async (): Promise<AppleImageNativeResult> => ({
        ...nativeResult,
        modelOutput: undefined,
        modelError: 'unavailable',
        modelDurationMs: undefined,
      })),
    });
    const controller = new AppleImageEvaluationController(nativeBridge, idFactory());
    controller.selectImage(selection);

    await controller.analyze();

    expect(controller.getSnapshot().availability?.reason).toBe('deviceNotEligible');
    expect(controller.getSnapshot().comparison?.model.status).toBe('unavailable');
    expect(controller.getSnapshot().phase).toBe('ready');
    expect(controller.getSnapshot().proposalSource).toBe('ocr');
  });

  it('fails gracefully when the optional native bridge is absent', async () => {
    const analyzeImage = vi.fn(async () => nativeResult);
    const controller = new AppleImageEvaluationController(bridge({
      getAvailability: vi.fn(async (): Promise<AppleImageModelAvailability> => ({
        bridgeAvailable: false,
        modelAvailable: false,
        reason: 'unsupportedPlatform',
      })),
      analyzeImage,
    }), idFactory());
    controller.selectImage(selection);

    await controller.analyze();

    expect(analyzeImage).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe('error');
    expect(controller.getSnapshot().errorCode).toBe('bridgeUnavailable');
    expect(controller.getSnapshot().selection).toEqual(selection);
  });

  it('cancels without losing the selected image and drops the late native callback', async () => {
    const pending = deferred<AppleImageNativeResult>();
    const cancelAnalysis = vi.fn(async () => undefined);
    const controller = new AppleImageEvaluationController(bridge({
      analyzeImage: vi.fn(() => pending.promise),
      cancelAnalysis,
    }), idFactory());
    controller.selectImage(selection);
    const analysis = controller.analyze();
    await Promise.resolve();
    await Promise.resolve();

    controller.cancelAnalysis('background');
    pending.resolve(nativeResult);
    await analysis;

    expect(cancelAnalysis).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().phase).toBe('selected');
    expect(controller.getSnapshot().selection).toEqual(selection);
    expect(controller.getSnapshot().proposal).toBeNull();
  });

  it('drops a stale callback after a replacement image starts a newer analysis', async () => {
    const first = deferred<AppleImageNativeResult>();
    const second = deferred<AppleImageNativeResult>();
    const analyzeImage = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const controller = new AppleImageEvaluationController(bridge({ analyzeImage }), idFactory());
    controller.selectImage(selection);
    const firstRun = controller.analyze();
    await Promise.resolve();
    await Promise.resolve();

    const replacement = { ...selection, uri: 'file:///system-picker/note.png' };
    controller.selectImage(replacement);
    const secondRun = controller.analyze();
    await Promise.resolve();
    await Promise.resolve();
    second.resolve({ ...nativeResult, modelOutput: JSON.stringify({ title: 'Keep newer', description: '' }) });
    await secondRun;
    first.resolve({ ...nativeResult, modelOutput: JSON.stringify({ title: 'Stale result', description: '' }) });
    await firstRun;

    expect(controller.getSnapshot().selection?.uri).toBe(replacement.uri);
    expect(controller.getSnapshot().proposal?.title).toBe('Keep newer');
  });

  it('discard forgets the image and proposal without creating a task', async () => {
    const controller = new AppleImageEvaluationController(bridge(), idFactory());
    controller.selectImage(selection);
    await controller.analyze();
    const addTask = vi.fn();

    expect(controller.discard()).toBe(true);

    expect(controller.getSnapshot().phase).toBe('idle');
    expect(controller.getSnapshot().selection).toBeNull();
    expect(controller.getSnapshot().proposal).toBeNull();
    expect(addTask).not.toHaveBeenCalled();
  });
});

describe('AppleImageEvaluationController durable save', () => {
  async function readyController() {
    const controller = new AppleImageEvaluationController(bridge(), idFactory());
    controller.selectImage(selection);
    await controller.analyze();
    return controller;
  }

  it('guards repeated Save presses and acknowledges only after pending persistence flushes', async () => {
    const controller = await readyController();
    const created = deferred<{ success: boolean; id?: string }>();
    const addTask = vi.fn(() => created.promise);
    const flushPendingSave = vi.fn(async () => undefined);
    const retryPendingPersistence = vi.fn(async () => undefined);

    const first = controller.save({ addTask, flushPendingSave, retryPendingPersistence });
    const repeated = controller.save({ addTask, flushPendingSave, retryPendingPersistence });
    expect(controller.selectImage({ ...selection, uri: 'file:///late-picker.jpg' })).toMatch(/Finish saving/);
    expect(controller.getSnapshot().selection).toEqual(selection);
    created.resolve({ success: true, id: 'task-1' });

    await expect(first).resolves.toEqual({ success: true, id: 'task-1' });
    await expect(repeated).resolves.toEqual({ success: true, id: 'task-1' });
    await expect(controller.save({ addTask, flushPendingSave, retryPendingPersistence })).resolves.toEqual({ success: true, id: 'task-1' });
    expect(addTask).toHaveBeenCalledOnce();
    expect(flushPendingSave).toHaveBeenCalledOnce();
    expect(retryPendingPersistence).not.toHaveBeenCalled();
    expect(addTask).toHaveBeenCalledWith(
      'Send the reimbursement form',
      { status: 'inbox', description: 'Receipt total: $24' },
      { captureId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    );
    expect(controller.getSnapshot().phase).toBe('saved');
  });

  it('re-enqueues a full snapshot after terminal persistence exhaustion without creating a duplicate', async () => {
    const controller = await readyController();
    const addTask = vi.fn(async () => ({ success: true, id: 'task-1' }));


    const flushPendingSave = vi.fn(async () => { throw new Error('terminal disk failure'); });
    const retryPendingPersistence = vi.fn(async () => undefined);

    await expect(controller.save({ addTask, flushPendingSave, retryPendingPersistence })).resolves.toEqual({ success: false });
    expect(controller.getSnapshot().saveNeedsFlush).toBe(true);
    expect(controller.selectImage({ ...selection, uri: 'file:///replacement.jpg' })).toMatch(/Finish saving/);
    expect(controller.getSnapshot().selection).toEqual(selection);
    expect(controller.updateProposal({ title: 'Would diverge from created task' })).toBe(false);

    await expect(controller.save({ addTask, flushPendingSave, retryPendingPersistence })).resolves.toEqual({ success: true, id: 'task-1' });
    expect(addTask).toHaveBeenCalledOnce();
    expect(flushPendingSave).toHaveBeenCalledOnce();
    expect(retryPendingPersistence).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().phase).toBe('saved');
  });

  it('retains the editable proposal when core rejects creation and allows retry', async () => {
    const controller = await readyController();
    const addTask = vi.fn()
      .mockResolvedValueOnce({ success: false, error: 'storage unavailable' })
      .mockResolvedValueOnce({ success: true, id: 'task-2' });
    const flushPendingSave = vi.fn(async () => undefined);
    const retryPendingPersistence = vi.fn(async () => undefined);

    await expect(controller.save({ addTask, flushPendingSave, retryPendingPersistence })).resolves.toEqual({ success: false });
    expect(controller.getSnapshot().proposal?.title).toBe('Send the reimbursement form');
    expect(controller.updateProposal({ title: 'Edited before retry' })).toBe(true);

    await expect(controller.save({ addTask, flushPendingSave, retryPendingPersistence })).resolves.toEqual({ success: true, id: 'task-2' });
    expect(addTask).toHaveBeenCalledTimes(2);
    expect(addTask.mock.calls[1][0]).toBe('Edited before retry');
  });
});
