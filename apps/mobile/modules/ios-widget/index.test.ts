import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acknowledgePendingCompletion,
  claimPendingCompletions,
  getNextPendingCompletionAt,
} from './index';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  nativeModule: {
    claimPendingCompletions: vi.fn(),
    acknowledgePendingCompletion: vi.fn(),
    getNextPendingCompletionAt: vi.fn(),
  },
  requireOptionalNativeModule: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: mocks.platform }));
vi.mock('expo-modules-core', () => {
  mocks.requireOptionalNativeModule.mockReturnValue(mocks.nativeModule);
  return { requireOptionalNativeModule: mocks.requireOptionalNativeModule };
});

describe('ios-widget wrapper', () => {
  beforeEach(() => {
    mocks.platform.OS = 'ios';
    mocks.nativeModule.claimPendingCompletions.mockReset().mockResolvedValue([]);
    mocks.nativeModule.acknowledgePendingCompletion.mockReset().mockResolvedValue(undefined);
    mocks.nativeModule.getNextPendingCompletionAt.mockReset().mockResolvedValue(null);
  });

  it('returns safe fallbacks away from iOS', async () => {
    mocks.platform.OS = 'android';

    await expect(claimPendingCompletions()).resolves.toEqual([]);
    await expect(acknowledgePendingCompletion('pending-1')).resolves.toBeUndefined();
    await expect(getNextPendingCompletionAt()).resolves.toBeNull();

    expect(mocks.nativeModule.claimPendingCompletions).not.toHaveBeenCalled();
    expect(mocks.nativeModule.acknowledgePendingCompletion).not.toHaveBeenCalled();
    expect(mocks.nativeModule.getNextPendingCompletionAt).not.toHaveBeenCalled();
  });

  it('passes native queue values through without converting epoch milliseconds', async () => {
    const completion = {
      id: 'pending-1',
      taskId: 'task-1',
      token: 'revision-1',
      createdAt: 1_000,
      notBefore: 4_000,
      claimed: true,
    };
    mocks.nativeModule.claimPendingCompletions.mockResolvedValue([completion]);
    mocks.nativeModule.getNextPendingCompletionAt.mockResolvedValue(7_000);

    await expect(claimPendingCompletions()).resolves.toEqual([completion]);
    await acknowledgePendingCompletion(completion.id);
    await expect(getNextPendingCompletionAt()).resolves.toBe(7_000);

    expect(mocks.nativeModule.acknowledgePendingCompletion).toHaveBeenCalledWith('pending-1');
  });

  it('propagates native claim failures instead of reporting an empty queue', async () => {
    mocks.nativeModule.claimPendingCompletions.mockRejectedValue(new Error('corrupt outbox'));

    await expect(claimPendingCompletions()).rejects.toThrow('corrupt outbox');
  });
});
