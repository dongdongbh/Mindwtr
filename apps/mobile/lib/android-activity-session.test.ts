import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeState = vi.hoisted(() => ({
  destroyed: new Map<number, { activityId: number; isChangingConfigurations: boolean }>(),
  current: null as null | { activityId: number; isChangingConfigurations: boolean },
}));

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('@/modules/android-window-layout', () => ({
  getAndroidActivitySession: (activityId?: number) => (
    activityId === undefined ? nativeState.current : nativeState.destroyed.get(activityId) ?? null
  ),
}));

import {
  ANDROID_ACTIVITY_SESSION_TTL_MS,
  clearAndroidActivitySession,
  getCurrentAndroidActivityId,
  isAndroidActivityChangingConfigurations,
  retainAndroidActivitySession,
  takeAndroidActivitySession,
} from './android-activity-session';

const isCountSnapshot = (value: unknown): value is { count: number } => (
  typeof value === 'object'
  && value !== null
  && typeof (value as { count?: unknown }).count === 'number'
);

describe('android activity session registry', () => {
  beforeEach(() => {
    vi.useRealTimers();
    nativeState.current = null;
    nativeState.destroyed.clear();
    clearAndroidActivitySession('editor');
  });

  it('retains only during verified configuration teardown and restores in the replacement Activity', () => {
    nativeState.current = { activityId: 41, isChangingConfigurations: true };
    expect(getCurrentAndroidActivityId()).toBe(41);
    nativeState.destroyed.set(41, nativeState.current);
    expect(retainAndroidActivitySession('editor', { count: 3 }, 41)).toBe(true);
    expect(isAndroidActivityChangingConfigurations()).toBe(true);

    nativeState.current = { activityId: 42, isChangingConfigurations: false };
    expect(takeAndroidActivitySession('editor', isCountSnapshot)).toEqual({ value: { count: 3 } });
    expect(takeAndroidActivitySession('editor', isCountSnapshot)).toBeNull();
  });

  it('does not restore into the same Activity', () => {
    nativeState.current = { activityId: 7, isChangingConfigurations: true };
    expect(getCurrentAndroidActivityId()).toBe(7);
    nativeState.destroyed.set(7, nativeState.current);
    retainAndroidActivitySession('editor', { count: 1 }, 7);
    nativeState.current = { activityId: 7, isChangingConfigurations: false };

    expect(takeAndroidActivitySession('editor', isCountSnapshot)).toBeNull();
  });

  it('clears an earlier snapshot on an ordinary unmount', () => {
    nativeState.current = { activityId: 1, isChangingConfigurations: true };
    expect(getCurrentAndroidActivityId()).toBe(1);
    nativeState.destroyed.set(1, nativeState.current);
    retainAndroidActivitySession('editor', { count: 1 }, 1);
    nativeState.current = { activityId: 2, isChangingConfigurations: false };
    nativeState.destroyed.set(2, nativeState.current);
    expect(retainAndroidActivitySession('editor', { count: 2 }, 2)).toBe(false);
    nativeState.current = { activityId: 3, isChangingConfigurations: false };

    expect(takeAndroidActivitySession('editor', isCountSnapshot)).toBeNull();
  });

  it('consumes malformed values without exposing them later', () => {
    nativeState.current = { activityId: 10, isChangingConfigurations: true };
    expect(getCurrentAndroidActivityId()).toBe(10);
    nativeState.destroyed.set(10, nativeState.current);
    retainAndroidActivitySession('editor', { count: 'three' }, 10);
    nativeState.current = { activityId: 11, isChangingConfigurations: false };

    expect(takeAndroidActivitySession('editor', isCountSnapshot)).toBeNull();
    expect(takeAndroidActivitySession('editor', (_value): _value is unknown => true)).toBeNull();
  });

  it('uses the destroyed source Activity when cleanup runs after its replacement is current', () => {
    nativeState.current = { activityId: 20, isChangingConfigurations: false };
    expect(getCurrentAndroidActivityId()).toBe(20);
    nativeState.destroyed.set(20, { activityId: 20, isChangingConfigurations: true });
    nativeState.current = { activityId: 21, isChangingConfigurations: false };

    expect(retainAndroidActivitySession('editor', { count: 9 }, 20)).toBe(true);
    expect(takeAndroidActivitySession('editor', isCountSnapshot)).toEqual({ value: { count: 9 } });
  });

  it('expires an owner after the immediate replacement Activity is skipped', () => {
    nativeState.current = { activityId: 30, isChangingConfigurations: false };
    expect(getCurrentAndroidActivityId()).toBe(30);
    nativeState.destroyed.set(30, { activityId: 30, isChangingConfigurations: true });
    expect(retainAndroidActivitySession('editor', { count: 4 }, 30)).toBe(true);

    // Activity 31 handled an external intent and deliberately did not mount the
    // editor owner. Activity 32 must not see Activity 30's draft.
    nativeState.current = { activityId: 31, isChangingConfigurations: false };
    expect(getCurrentAndroidActivityId()).toBe(31);
    nativeState.current = { activityId: 32, isChangingConfigurations: false };
    expect(takeAndroidActivitySession('editor', isCountSnapshot)).toBeNull();
  });

  it('expires an otherwise eligible snapshot after the bounded in-memory TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T12:00:00.000Z'));
    nativeState.current = { activityId: 40, isChangingConfigurations: false };
    expect(getCurrentAndroidActivityId()).toBe(40);
    nativeState.destroyed.set(40, { activityId: 40, isChangingConfigurations: true });
    expect(retainAndroidActivitySession('editor', { count: 5 }, 40)).toBe(true);

    vi.setSystemTime(new Date(Date.now() + ANDROID_ACTIVITY_SESSION_TTL_MS + 1));
    nativeState.current = { activityId: 41, isChangingConfigurations: false };
    expect(takeAndroidActivitySession('editor', isCountSnapshot)).toBeNull();
  });

  it('cannot replay a snapshot after the immediate replacement consumed but skipped it', () => {
    nativeState.current = { activityId: 50, isChangingConfigurations: false };
    expect(getCurrentAndroidActivityId()).toBe(50);
    nativeState.destroyed.set(50, { activityId: 50, isChangingConfigurations: true });
    expect(retainAndroidActivitySession('editor', { count: 6 }, 50)).toBe(true);
    nativeState.current = { activityId: 51, isChangingConfigurations: false };

    // A caller can reject the value for an external-intent priority decision;
    // take still consumes it before invoking the caller's restore path.
    expect(takeAndroidActivitySession('editor', isCountSnapshot)).toEqual({ value: { count: 6 } });
    nativeState.current = { activityId: 52, isChangingConfigurations: false };
    expect(takeAndroidActivitySession('editor', isCountSnapshot)).toBeNull();
  });
});
