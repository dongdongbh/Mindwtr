/* eslint-disable import/first -- Vitest native-module mocks must be registered before loading the adapter. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ enabled: true, foss: false }));
const native = vi.hoisted(() => ({
  capability: vi.fn(),
  download: vi.fn(),
  clarify: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('expo-constants', () => ({
  default: {
    get expoConfig() {
      return {
        extra: {
          isFossBuild: config.foss,
          nanoClarificationPrototypeEnabled: config.enabled,
        },
      };
    },
  },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('../modules/nano-clarification', () => ({
  getNativeNanoClarificationCapability: native.capability,
  downloadNativeNanoClarificationModel: native.download,
  requestNativeNanoInboxClarification: native.clarify,
  cancelNativeNanoClarificationRequest: native.cancel,
}));

import {
  NanoClarificationCancelledError,
  NanoClarificationError,
  downloadNanoClarificationModel,
  getNanoClarificationCapability,
  isNanoClarificationPrototypeEnabled,
  requestNanoInboxClarification,
} from './nano-clarification';
import {
  OnDeviceClarificationInputError,
  OnDeviceClarificationOutputError,
  type OnDeviceClarificationInput,
} from './on-device-clarification';

const input: OnDeviceClarificationInput = {
  requestId: 'request-1',
  locale: 'en-US',
  title: 'Call dentist by September 18, 2026',
  description: '',
  candidates: [
    { kind: 'project', id: 'project-health', label: 'Health' },
    { kind: 'context', id: '@phone', label: '@phone' },
  ],
};

describe('Nano clarification adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.enabled = true;
    config.foss = false;
    native.capability.mockResolvedValue({
      available: true,
      reason: 'available',
      supportedOperations: ['inbox_clarification'],
    });
  });

  it('fails closed for build-disabled and FOSS configurations without touching native code', async () => {
    config.enabled = false;
    expect(isNanoClarificationPrototypeEnabled()).toBe(false);
    await expect(getNanoClarificationCapability('en-US')).resolves.toMatchObject({
      available: false,
      reason: 'build_disabled',
    });
    expect(native.capability).not.toHaveBeenCalled();

    config.enabled = true;
    config.foss = true;
    expect(isNanoClarificationPrototypeEnabled()).toBe(false);
  });

  it('preserves an unavailable native capability without starting inference or download', async () => {
    native.capability.mockResolvedValue({
      available: false,
      reason: 'native_module_missing',
      supportedOperations: [],
    });

    await expect(getNanoClarificationCapability('en-US')).resolves.toMatchObject({
      available: false,
      reason: 'native_module_missing',
    });
    expect(native.clarify).not.toHaveBeenCalled();
    expect(native.download).not.toHaveBeenCalled();
  });

  it('parses raw JSON and applies the shared date and ID validation', async () => {
    native.clarify.mockResolvedValue(JSON.stringify({
      cleanedTitle: 'Call the dentist',
      projectIds: ['project-health'],
      contextIds: ['@phone'],
      dueDate: '2026-09-18',
      dueDateEvidence: 'September 18, 2026',
    }));

    await expect(requestNanoInboxClarification(input)).resolves.toEqual({
      cleanedTitle: 'Call the dentist',
      projectId: 'project-health',
      contextIds: ['@phone'],
      tagIds: [],
      dueDate: '2026-09-18',
    });
  });

  it('accepts Nano JSON wrapped in a single code fence', async () => {
    native.clarify.mockResolvedValue('```json\n{"cleanedTitle":"Email the dentist"}\n```');
    await expect(requestNanoInboxClarification(input)).resolves.toMatchObject({ cleanedTitle: 'Email the dentist' });
  });

  it.each([
    'Here is the result: ```json\n{"cleanedTitle":"Email the dentist"}\n```',
    '```json\n{"cleanedTitle":"Email the dentist"}\n```\nExtra commentary',
    '```json\n{"cleanedTitle":"Email the dentist"}\n```\n```json\n{}\n```',
    '```json\n{"cleanedTitle":"Email the dentist","projectIds":["invented"]}\n```',
  ])('rejects surrounding prose, multiple objects, and invented IDs in fenced output', async (output) => {
    native.clarify.mockResolvedValue(output);
    await expect(requestNanoInboxClarification(input)).rejects.toBeInstanceOf(OnDeviceClarificationOutputError);
  });

  it('rejects malformed JSON and invented IDs with shared safe errors', async () => {
    native.clarify.mockResolvedValue('{bad json');
    await expect(requestNanoInboxClarification(input)).rejects.toBeInstanceOf(
      OnDeviceClarificationOutputError,
    );

    native.clarify.mockResolvedValue(JSON.stringify({
      cleanedTitle: 'Call the dentist',
      projectIds: ['invented'],
    }));
    await expect(requestNanoInboxClarification(input)).rejects.toMatchObject({ code: 'invented_id' });
  });

  it('rejects oversized input before invoking the native module', async () => {
    await expect(requestNanoInboxClarification({ ...input, title: 'x'.repeat(513) }))
      .rejects.toBeInstanceOf(OnDeviceClarificationInputError);
    expect(native.clarify).not.toHaveBeenCalled();
  });

  it.each([
    ['ERR_NANO_BUSY', 'busy'],
    ['ERR_NANO_QUOTA_EXCEEDED', 'quota_exceeded'],
    ['ERR_NANO_BACKGROUND_BLOCKED', 'background_blocked'],
  ])('maps sanitized native %s failures to %s without exposing an error body', async (nativeCode, code) => {
    native.clarify.mockRejectedValue(new Error(nativeCode));

    await expect(requestNanoInboxClarification(input)).rejects.toMatchObject({
      name: 'NanoClarificationError',
      code,
    });
  });

  it('cancels exact inference and download request IDs and discards late results', async () => {
    let resolveClarify!: (value: string) => void;
    native.clarify.mockReturnValue(new Promise((resolve) => { resolveClarify = resolve; }));
    const inferenceController = new AbortController();
    const inference = requestNanoInboxClarification(input, { signal: inferenceController.signal });
    inferenceController.abort();
    resolveClarify(JSON.stringify({ cleanedTitle: 'Late title' }));
    await expect(inference).rejects.toBeInstanceOf(NanoClarificationCancelledError);
    expect(native.cancel).toHaveBeenCalledWith('request-1');

    let resolveDownload!: (value: any) => void;
    native.download.mockReturnValue(new Promise((resolve) => { resolveDownload = resolve; }));
    const downloadController = new AbortController();
    const download = downloadNanoClarificationModel(
      'download-1',
      'en-US',
      { signal: downloadController.signal },
    );
    downloadController.abort();
    resolveDownload({ available: true, reason: 'available', supportedOperations: ['inbox_clarification'] });
    await expect(download).rejects.toBeInstanceOf(NanoClarificationCancelledError);
    expect(native.cancel).toHaveBeenCalledWith('download-1');
  });

  it('normalizes unknown native failures instead of returning exception text', async () => {
    native.clarify.mockRejectedValue(new Error('prompt fragment that must not escape'));
    const error = await requestNanoInboxClarification(input).catch((caught) => caught);
    expect(error).toBeInstanceOf(NanoClarificationError);
    expect(error).toMatchObject({ code: 'unknown' });
    expect(error.message).not.toContain('prompt fragment');
  });
});
