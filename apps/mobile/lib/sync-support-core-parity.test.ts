import { describe, expect, it, vi } from 'vitest';
import * as core from '@mindwtr/core';

vi.mock('./file-system', () => ({
  __esModule: true,
  documentDirectory: 'file:///documents/',
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  StorageAccessFramework: {},
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

// eslint-disable-next-line import/first
import * as rnKeys from './sync-constants';
// eslint-disable-next-line import/first
import { base64ToBytes, bytesToBase64 } from './attachment-sync-utils';


describe('sync support parity with core', () => {
  it('uses the same device storage keys as core', () => {
    const entries = Object.entries(rnKeys).filter(([name]) => name.endsWith('_KEY'));
    expect(entries.length).toBeGreaterThan(15);
    for (const [name, value] of entries) {
      expect({ name, value }).toEqual({ name, value: (core as Record<string, unknown>)[name] });
    }
  });

  it('encodes and decodes base64 exactly as core does, so a stored key reads the same', () => {
    const samples = [
      new Uint8Array(),
      Uint8Array.from([0]),
      Uint8Array.from([255, 254]),
      Uint8Array.from({ length: 32 }, (_, index) => (index * 37) & 0xff),
      Uint8Array.from({ length: 256 }, (_, index) => index),
    ];
    for (const bytes of samples) {
      expect(bytesToBase64(bytes)).toBe(core.bytesToBase64(bytes));
    }
    for (const text of ['', 'TQ==', 'TWE=', 'TW\nFu', 'garbled*&^%', 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=', 'abc']) {
      expect(Array.from(base64ToBytes(text))).toEqual(Array.from(core.base64ToBytes(text)));
    }
  });
});
