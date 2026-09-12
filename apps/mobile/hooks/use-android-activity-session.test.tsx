import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => ({
  clear: vi.fn(),
  currentActivityId: vi.fn(() => 12),
  retain: vi.fn(),
  recovered: null as null | { value: { text: string } },
  take: vi.fn(() => registry.recovered),
}));

vi.mock('@/lib/android-activity-session', () => ({
  clearAndroidActivitySession: registry.clear,
  getCurrentAndroidActivityId: registry.currentActivityId,
  retainAndroidActivitySession: registry.retain,
  takeAndroidActivitySession: registry.take,
}));

import { useAndroidActivitySession } from './use-android-activity-session';

const isSnapshot = (value: unknown): value is { text: string } => (
  typeof value === 'object'
  && value !== null
  && typeof (value as { text?: unknown }).text === 'string'
);

describe('useAndroidActivitySession', () => {
  beforeEach(() => {
    registry.clear.mockClear();
    registry.retain.mockClear();
    registry.take.mockClear();
    registry.recovered = null;
  });

  it('restores once on mount and retains the latest value on teardown', () => {
    registry.recovered = { value: { text: 'recovered' } };
    const onRestore = vi.fn();
    let tree!: ReactTestRenderer;

    function Probe({ text }: { text: string }) {
      useAndroidActivitySession({
        ownerId: 'capture',
        value: { text },
        validate: isSnapshot,
        onRestore,
      });
      return null;
    }

    act(() => { tree = create(<Probe text="first" />); });
    expect(onRestore).toHaveBeenCalledWith({ text: 'recovered' });
    act(() => { tree.update(<Probe text="latest" />); });
    act(() => { tree.unmount(); });
    expect(registry.retain).toHaveBeenCalledWith('capture', { text: 'latest' }, 12);
  });

  it('explicit clear prevents teardown from retaining a completed session', () => {
    let controls!: { clear: () => void };
    let tree!: ReactTestRenderer;

    function Probe() {
      controls = useAndroidActivitySession({
        ownerId: 'editor',
        value: { text: 'draft' },
        validate: isSnapshot,
        onRestore: vi.fn(),
      });
      return null;
    }

    act(() => { tree = create(<Probe />); });
    act(() => { controls.clear(); });
    act(() => { tree.unmount(); });

    expect(registry.clear).toHaveBeenCalledWith('editor');
    expect(registry.retain).not.toHaveBeenCalled();
  });

  it('can synchronously rearm a still-mounted editable owner after a failed action', () => {
    let controls!: { clear: () => void; rearm: () => void };
    let tree!: ReactTestRenderer;

    function Probe() {
      controls = useAndroidActivitySession({
        ownerId: 'capture',
        value: { text: 'retry draft' },
        validate: isSnapshot,
        onRestore: vi.fn(),
      });
      return null;
    }

    act(() => { tree = create(<Probe />); });
    act(() => {
      controls.clear();
      controls.rearm();
    });
    act(() => { tree.unmount(); });

    expect(registry.clear).toHaveBeenCalledWith('capture');
    expect(registry.retain).toHaveBeenCalledWith('capture', { text: 'retry draft' }, 12);
  });
});
