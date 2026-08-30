import { act, render, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Task, useTaskStore } from '@mindwtr/core';

import { useTaskItemAi } from './useTaskItemAi';
import { TaskItem } from '../TaskItem';
import { LanguageProvider } from '../../contexts/language-context';
import { useUiStore } from '../../store/ui-store';

const predictMetadata = vi.hoisted(() => vi.fn());
const logWarn = vi.hoisted(() => vi.fn());

vi.mock('@mindwtr/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@mindwtr/core')>();
    return { ...actual, createAIProvider: () => ({ predictMetadata }) };
});

// Wraps the real hook (calls through) so TaskItem-level tests can assert on
// the exact `copilotEnabled` argument TaskItem passes, independent of the
// hook's internal debounce timing.
vi.mock('./useTaskItemAi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./useTaskItemAi')>();
    return { ...actual, useTaskItemAi: vi.fn(actual.useTaskItemAi) };
});

vi.mock('../../lib/ai-config', () => ({
    buildAIConfig: vi.fn(async () => ({})),
    buildCopilotConfig: vi.fn(async () => ({})),
    isAIKeyRequired: () => false,
    loadAIKey: vi.fn(async () => 'test-key'),
}));

vi.mock('../../lib/app-log', () => ({ logWarn }));

const settings = { ai: { enabled: true, provider: 'openai' } } as never;

const renderAi = (setField: ReturnType<typeof vi.fn>, overrides: Record<string, unknown> = {}) => renderHook(() => useTaskItemAi({
    taskId: 'task-1',
    settings,
    t: (key: string) => key,
    editTitle: 'Book the dentist',
    editDescription: '',
    editContexts: '',
    editTags: '',
    editStartTime: '',
    editDueDate: '',
    editReviewAt: '',
    contextOptions: ['@phone'],
    tagOptions: ['#health'],
    projectContext: null,
    timeEstimatesEnabled: true,
    setField,
    ...overrides,
}));

/** The debounced copilot request plus the promise it awaits. */
const settleSuggestion = async () => {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(900);
    });
};

describe('useTaskItemAi copilot parts', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        predictMetadata.mockReset();
        logWarn.mockReset();
        predictMetadata.mockResolvedValue({ context: '@phone', timeEstimate: '15min', tags: ['#health', '#errand'] });
    });

    it('logs a sanitized diagnostic when metadata prediction fails', async () => {
        predictMetadata.mockRejectedValueOnce(new Error('model rejected request'));
        const { result } = renderAi(vi.fn());

        await settleSuggestion();

        expect(result.current.copilotSuggestion).toBeNull();
        expect(logWarn).toHaveBeenCalledWith('AI copilot failed', {
            scope: 'ai',
            extra: {
                step: 'copilot',
                provider: 'openai',
                model: '',
                taskId: 'task-1',
                error: 'model rejected request',
            },
        });
    });

    it('applies exactly one part per chip and leaves the others suggestible', async () => {
        const setField = vi.fn();
        const { result } = renderAi(setField);
        await settleSuggestion();

        expect(result.current.pendingCopilotParts).toEqual([
            { kind: 'context', value: '@phone' },
            { kind: 'timeEstimate', value: '15min' },
            { kind: 'tag', value: '#health' },
            { kind: 'tag', value: '#errand' },
        ]);

        act(() => {
            result.current.applyCopilotPart({ kind: 'tag', value: '#health' });
        });

        expect(setField.mock.calls).toEqual([['tags', '#health']]);
        expect(result.current.pendingCopilotParts).toEqual([
            { kind: 'context', value: '@phone' },
            { kind: 'timeEstimate', value: '15min' },
            { kind: 'tag', value: '#errand' },
        ]);
        expect(result.current.copilotTags).toEqual(['#health']);
        expect(result.current.copilotContext).toBeUndefined();
        expect(result.current.copilotEstimate).toBeUndefined();
    });

    it('applies only the remaining parts on apply-all, in one write per field', async () => {
        const setField = vi.fn();
        const { result } = renderAi(setField);
        await settleSuggestion();

        act(() => {
            result.current.applyCopilotPart({ kind: 'context', value: '@phone' });
        });
        setField.mockClear();

        act(() => {
            result.current.applyCopilotSuggestion();
        });

        expect(setField.mock.calls).toEqual([
            ['tags', '#health, #errand'],
            ['timeEstimate', '15min'],
        ]);
        expect(result.current.pendingCopilotParts).toEqual([]);
    });

    it('offers a refreshed time estimate again after an earlier one was applied', async () => {
        const setField = vi.fn();
        const { result, rerender } = renderHook(
            (props: { editTitle: string }) => useTaskItemAi({
                taskId: 'task-1',
                settings,
                t: (key: string) => key,
                editTitle: props.editTitle,
                editDescription: '',
                editContexts: '',
                editTags: '',
                editStartTime: '',
                editDueDate: '',
                editReviewAt: '',
                contextOptions: ['@phone'],
                tagOptions: ['#health'],
                projectContext: null,
                timeEstimatesEnabled: true,
                setField,
            }),
            { initialProps: { editTitle: 'Book the dentist' } },
        );
        await settleSuggestion();

        act(() => {
            result.current.applyCopilotPart({ kind: 'timeEstimate', value: '15min' });
        });
        expect(result.current.copilotEstimate).toBe('15min');

        predictMetadata.mockResolvedValue({ timeEstimate: '30min' });
        rerender({ editTitle: 'Book the dentist urgently' });
        await settleSuggestion();

        expect(result.current.pendingCopilotParts).toContainEqual({ kind: 'timeEstimate', value: '30min' });
    });

    it('never offers a time estimate part when the feature is off', async () => {
        const setField = vi.fn();
        const { result } = renderAi(setField, { timeEstimatesEnabled: false });
        await settleSuggestion();

        expect(result.current.pendingCopilotParts.some((part) => part.kind === 'timeEstimate')).toBe(false);

        act(() => {
            result.current.applyCopilotSuggestion();
        });

        expect(setField.mock.calls.some(([field]) => field === 'timeEstimate')).toBe(false);
    });

    it('makes no copilot request when copilot is switched off for the surface', async () => {
        const setField = vi.fn();
        const { result } = renderAi(setField, { copilotEnabled: false });
        await settleSuggestion();

        expect(predictMetadata).not.toHaveBeenCalled();
        expect(result.current.pendingCopilotParts).toEqual([]);
    });

    it('fires again when the same row reopens with unchanged text after closing (C3)', async () => {
        const setField = vi.fn();
        const { rerender } = renderHook(
            (props: { copilotEnabled: boolean }) => useTaskItemAi({
                taskId: 'task-1',
                settings,
                t: (key: string) => key,
                editTitle: 'Book the dentist',
                editDescription: '',
                editContexts: '',
                editTags: '',
                editStartTime: '',
                editDueDate: '',
                editReviewAt: '',
                contextOptions: ['@phone'],
                tagOptions: ['#health'],
                projectContext: null,
                timeEstimatesEnabled: true,
                setField,
                copilotEnabled: props.copilotEnabled,
            }),
            { initialProps: { copilotEnabled: true } },
        );
        await settleSuggestion();
        expect(predictMetadata).toHaveBeenCalledTimes(1);

        // Row closes (e.g. editor collapses): copilotEnabled goes false.
        rerender({ copilotEnabled: false });

        // Row reopens with the same, unchanged text.
        rerender({ copilotEnabled: true });
        await settleSuggestion();

        expect(predictMetadata).toHaveBeenCalledTimes(2);
    });

    it('fires again when the title is retyped to the same text after dropping below the length floor (N4)', async () => {
        const setField = vi.fn();
        const { rerender } = renderHook(
            (props: { editTitle: string }) => useTaskItemAi({
                taskId: 'task-1',
                settings,
                t: (key: string) => key,
                editTitle: props.editTitle,
                editDescription: '',
                editContexts: '',
                editTags: '',
                editStartTime: '',
                editDueDate: '',
                editReviewAt: '',
                contextOptions: ['@phone'],
                tagOptions: ['#health'],
                projectContext: null,
                timeEstimatesEnabled: true,
                setField,
            }),
            { initialProps: { editTitle: 'Book the dentist' } },
        );
        await settleSuggestion();
        expect(predictMetadata).toHaveBeenCalledTimes(1);

        // Title shrinks below the 4-char floor: no suggestion, but the
        // dispatched signature must not linger.
        rerender({ editTitle: 'Boo' });
        await settleSuggestion();
        expect(predictMetadata).toHaveBeenCalledTimes(1);

        // Retyped back to the exact same text as the original suggestion.
        rerender({ editTitle: 'Book the dentist' });
        await settleSuggestion();

        expect(predictMetadata).toHaveBeenCalledTimes(2);
    });
});

describe('TaskItem copilot wiring', () => {
    const initialTaskState = useTaskStore.getState();
    const initialUiState = useUiStore.getState();

    const rowTask: Task = {
        id: 'wiring-task-1',
        title: 'Book the dentist',
        status: 'inbox',
        tags: [],
        contexts: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };

    beforeEach(() => {
        vi.useFakeTimers();
        predictMetadata.mockReset();
        predictMetadata.mockResolvedValue({ context: '@phone', timeEstimate: '15min', tags: ['#health'] });
        vi.mocked(useTaskItemAi).mockClear();
        act(() => {
            useTaskStore.setState(initialTaskState, true);
            useUiStore.setState(initialUiState, true);
        });
        useTaskStore.setState({ settings: { ai: { enabled: true, provider: 'openai' } } });
        useUiStore.setState({
            ...useUiStore.getState(),
            editingTaskId: null,
            expandedTaskIds: {},
        });
    });

    it('makes no background copilot call for a mounted row that is not being edited', async () => {
        render(
            <LanguageProvider>
                <TaskItem task={rowTask} />
            </LanguageProvider>
        );

        await settleSuggestion();

        expect(predictMetadata).not.toHaveBeenCalled();
        const calls = vi.mocked(useTaskItemAi).mock.calls;
        const lastCall = calls[calls.length - 1]?.[0];
        expect(lastCall?.copilotEnabled).toBe(false);
    });

    it('enables copilot for a row mounted already in edit mode, and the debounced call still fires', async () => {
        useUiStore.setState({ editingTaskId: rowTask.id });

        render(
            <LanguageProvider>
                <TaskItem task={rowTask} />
            </LanguageProvider>
        );

        // Entering edit mode on mount re-renders TaskItem (loadTokenOptions
        // flips on) before the 800ms debounce fires; predictMetadata must
        // still land once things settle (N1).
        await settleSuggestion();
        expect(predictMetadata).toHaveBeenCalledTimes(1);

        const calls = vi.mocked(useTaskItemAi).mock.calls;
        const lastCall = calls[calls.length - 1]?.[0];
        expect(lastCall?.copilotEnabled).toBe(true);
    });
});
