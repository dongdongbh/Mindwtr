import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPlatform } = vi.hoisted(() => ({
  mockPlatform: { OS: 'android' },
}));

vi.mock('react-native', () => ({
  Platform: mockPlatform,
}));

const { shouldRemoveClippedSubviews } = await import('./task-list-windowing');

describe('shouldRemoveClippedSubviews', () => {
  beforeEach(() => {
    mockPlatform.OS = 'android';
  });

  it('clips a long list on Android', () => {
    expect(shouldRemoveClippedSubviews(15)).toBe(true);
    expect(shouldRemoveClippedSubviews(14)).toBe(false);
  });


  it('never clips on iOS, at any length', () => {
    mockPlatform.OS = 'ios';
    for (const count of [0, 1, 14, 15, 200]) {
      expect(shouldRemoveClippedSubviews(count)).toBe(false);
    }
  });
});
