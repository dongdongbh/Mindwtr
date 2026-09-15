/* eslint-disable import/first -- AsyncStorage must be mocked before loading the preference module. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({ default: storage }));

import {
  readNanoClarificationBackend,
  writeNanoClarificationBackend,
} from './nano-clarification-preference';

describe('Nano clarification device-local backend preference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.getItem.mockResolvedValue(null);
  });

  it('uses a distinct local key and defaults missing or invalid state to configured', async () => {
    await expect(readNanoClarificationBackend()).resolves.toBe('configured');
    expect(storage.getItem).toHaveBeenCalledWith('mindwtr:nanoClarificationBackend:v1');

    storage.getItem.mockResolvedValue('future-value');
    await expect(readNanoClarificationBackend()).resolves.toBe('configured');
  });

  it('persists only the local on-device override and removes the default', async () => {
    await writeNanoClarificationBackend('on-device');
    expect(storage.setItem).toHaveBeenCalledWith(
      'mindwtr:nanoClarificationBackend:v1',
      'on-device',
    );

    storage.getItem.mockResolvedValue('on-device');
    await expect(readNanoClarificationBackend()).resolves.toBe('on-device');

    await writeNanoClarificationBackend('configured');
    expect(storage.removeItem).toHaveBeenCalledWith('mindwtr:nanoClarificationBackend:v1');
  });

  it('fails closed when local storage is unavailable', async () => {
    storage.getItem.mockRejectedValue(new Error('unavailable'));
    await expect(readNanoClarificationBackend()).resolves.toBe('configured');
    storage.setItem.mockRejectedValue(new Error('unavailable'));
    await expect(writeNanoClarificationBackend('on-device')).resolves.toBeUndefined();
  });
});
