import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const allTasks = [{ id: 'deleted-capture', deletedAt: '2026-09-08T00:00:00.000Z' }];
  const state = {
    addTask: vi.fn(),
    updateTask: vi.fn(),
    addProject: vi.fn(),
    projects: [],
    areas: [],
    tasks: [],
    _allTasks: allTasks,
    people: [],
    settings: {},
  };
  return {
    allTasks,
    state,
    flushPendingSave: vi.fn(async () => undefined),
    ingestPendingCaptures: vi.fn<typeof import('@/lib/pending-captures').ingestPendingCaptures>(async () => 0),
    transcribePendingAudio: vi.fn(),
    applyWatchCommand: vi.fn(),
  };
});

vi.mock('@mindwtr/core', () => ({
  flushPendingSave: mocks.flushPendingSave,
  useTaskStore: { getState: () => mocks.state },
}));
vi.mock('@/lib/pending-captures', () => ({
  ingestPendingCaptures: mocks.ingestPendingCaptures,
}));
vi.mock('@/lib/watch-audio', () => ({
  transcribePendingAudio: mocks.transcribePendingAudio,
}));
vi.mock('@/lib/pomodoro-controller', () => ({
  mobilePomodoroController: { applyWatchCommand: mocks.applyWatchCommand },
}));
vi.mock('@/lib/app-log', () => ({ logError: vi.fn(async () => undefined) }));

// eslint-disable-next-line import/first
import { useRootLayoutPendingCaptures } from './use-root-layout-pending-captures';

function Harness({ dataReady = true, disabled = false }: { dataReady?: boolean; disabled?: boolean }) {
  useRootLayoutPendingCaptures({ dataReady, disabled });
  return null;
}

describe('useRootLayoutPendingCaptures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('drains with the neutral audio transcriber and fresh tasks including tombstones', async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<Harness />);
      await Promise.resolve();
    });

    expect(mocks.ingestPendingCaptures).toHaveBeenCalledOnce();
    const deps = mocks.ingestPendingCaptures.mock.calls[0][0];
    expect(deps.transcribeAudio).toBe(mocks.transcribePendingAudio);
    expect(deps.getTasks?.()).toBe(mocks.allTasks);
    expect(deps.flushPendingSave).toBe(mocks.flushPendingSave);

    act(() => tree.unmount());
  });

  it('does not drain before store data is ready', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<Harness dataReady={false} />);
    });

    expect(mocks.ingestPendingCaptures).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('leaves the personal pending-capture queue untouched when disabled', () => {
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<Harness disabled />);
    });

    expect(mocks.ingestPendingCaptures).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });
});
