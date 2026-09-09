import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaskDraft } from '@mindwtr/core/task-draft';

import { useTaskEditCopilot } from './use-task-edit-copilot';

const predictMetadata = vi.hoisted(() => vi.fn());

// Explicit export list: the hook only reaches for the provider factory.
vi.mock('@mindwtr/core', () => ({
  createAIProvider: () => ({ predictMetadata }),
}));

vi.mock('../../lib/ai-config', () => ({
  buildCopilotConfig: () => ({}),
  isAIKeyRequired: () => false,
  loadAIKey: async () => 'test-key',
}));

vi.mock('../../lib/app-log', () => ({ logError: vi.fn() }));

const draft = createTaskDraft({
  id: 'task-1',
  title: 'Book the dentist',
  status: 'inbox',
  tags: [],
  contexts: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

/** Bare host so the hook can run without the whole edit modal — this repo has
 *  no renderHook helper for mobile. */
function CopilotHost({
  setDraftField,
  onResult,
  titleDraft = 'Book the dentist',
}: {
  setDraftField: (field: string, value: unknown) => void;
  onResult: (value: ReturnType<typeof useTaskEditCopilot>) => void;
  titleDraft?: string;
}) {
  const copilot = useTaskEditCopilot({
    settings: {} as never,
    aiEnabled: true,
    aiProvider: 'openai',
    timeEstimatesEnabled: true,
    titleDraft,
    descriptionDraft: '',
    contextOptions: ['@phone'],
    tagOptions: ['#health'],
    draft,
    visible: true,
    setDraftField: setDraftField as never,
  });
  onResult(copilot);
  return null;
}

describe('useTaskEditCopilot suggestion parts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    predictMetadata.mockReset();
    predictMetadata.mockResolvedValue({ context: '@phone', timeEstimate: '15min', tags: ['#health', '#errand'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const mountCopilot = async (setDraftField: (field: string, value: unknown) => void) => {
    let copilot!: ReturnType<typeof useTaskEditCopilot>;
    await act(async () => {
      create(<CopilotHost setDraftField={setDraftField} onResult={(value) => { copilot = value; }} />);
    });
    // The debounced request plus the promise it awaits.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    return () => copilot;
  };

  it('applies exactly one part per chip and leaves the others suggestible (#1022)', async () => {
    const setDraftField = vi.fn();
    const current = await mountCopilot(setDraftField);

    expect(current().pendingCopilotParts).toEqual([
      { kind: 'context', value: '@phone' },
      { kind: 'timeEstimate', value: '15min' },
      { kind: 'tag', value: '#health' },
      { kind: 'tag', value: '#errand' },
    ]);

    await act(async () => {
      current().applyCopilotPart({ kind: 'tag', value: '#health' });
    });

    expect(setDraftField.mock.calls).toEqual([['tags', '#health']]);
    expect(current().pendingCopilotParts).toEqual([
      { kind: 'context', value: '@phone' },
      { kind: 'timeEstimate', value: '15min' },
      { kind: 'tag', value: '#errand' },
    ]);
    expect(current().copilotContext).toBeUndefined();
    expect(current().copilotEstimate).toBeUndefined();
  });

  it('applies only the remaining parts on apply-all', async () => {
    const setDraftField = vi.fn();
    const current = await mountCopilot(setDraftField);

    await act(async () => {
      current().applyCopilotPart({ kind: 'context', value: '@phone' });
    });
    setDraftField.mockClear();

    await act(async () => {
      current().applyCopilotSuggestion();
    });

    expect(setDraftField.mock.calls).toEqual([
      ['tags', '#health, #errand'],
      ['timeEstimate', '15min'],
    ]);
    expect(current().pendingCopilotParts).toEqual([]);
  });

  it('offers a refreshed time estimate again after an earlier one was applied', async () => {
    const setDraftField = vi.fn();
    let copilot!: ReturnType<typeof useTaskEditCopilot>;
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<CopilotHost setDraftField={setDraftField} onResult={(value) => { copilot = value; }} />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });

    await act(async () => {
      copilot.applyCopilotPart({ kind: 'timeEstimate', value: '15min' });
    });
    expect(copilot.copilotEstimate).toBe('15min');

    predictMetadata.mockResolvedValue({ timeEstimate: '30min' });
    await act(async () => {
      tree.update(<CopilotHost setDraftField={setDraftField} onResult={(value) => { copilot = value; }} titleDraft="Book the dentist urgently" />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });

    expect(copilot.pendingCopilotParts).toContainEqual({ kind: 'timeEstimate', value: '30min' });
  });
});
