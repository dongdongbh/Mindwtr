import { act, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Task, type TaskDraftSetter, useTaskStore } from '@mindwtr/core';

import { useTaskItemAi } from './useTaskItemAi';
import { buildCopilotConfig } from '../../lib/ai-config';
import { TaskItem } from '../TaskItem';
import { LanguageProvider } from '../../contexts/language-context';
import { useUiStore } from '../../store/ui-store';
import { holdSyncSave } from '../../test/hold-sync-save';

const predictMetadata = vi.hoisted(() => vi.fn());
const breakDownTask = vi.hoisted(() => vi.fn());
const logWarn = vi.hoisted(() => vi.fn());

vi.mock('@mindwtr/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@mindwtr/core')>();
    return { ...actual, createAIProvider: () => ({ predictMetadata, breakDownTask }) };
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

const renderAi = (setField: TaskDraftSetter, overrides: Record<string, unknown> = {}) => renderHook(() => useTaskItemAi({
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
        vi.mocked(buildCopilotConfig).mockClear();
        logWarn.mockReset();
        predictMetadata.mockResolvedValue({ context: '@phone', timeEstimate: '15min', tags: ['#health', '#errand'] });
    });

    it('invalidates the dispatched copilot signature when the app language changes', async () => {
        const contextOptions = ['@phone'];
        const tagOptions = ['#health'];
        const t = (key: string) => key;
        const setField = vi.fn();
        const { rerender } = renderHook(({ language }: { language: 'en' | 'de' }) => useTaskItemAi({
            taskId: 'task-1', settings, t, language,
            editTitle: 'Book the dentist', editDescription: '', editContexts: '', editTags: '',
            editStartTime: '', editDueDate: '', editReviewAt: '',
            contextOptions, tagOptions, projectContext: null,
            timeEstimatesEnabled: true, setField,
        }), { initialProps: { language: 'en' as 'en' | 'de' } });
        await settleSuggestion();
        expect(buildCopilotConfig).toHaveBeenLastCalledWith(settings, expect.any(String), 'en');

        rerender({ language: 'de' });
        await settleSuggestion();
        expect(buildCopilotConfig).toHaveBeenLastCalledWith(settings, expect.any(String), 'de');
        expect(predictMetadata).toHaveBeenCalledTimes(2);
    });

    it('hides an old-language suggestion while the replacement request is pending', async () => {
        const contextOptions = ['@phone'];
        const tagOptions = ['#health'];
        const t = (key: string) => key;
        const setField = vi.fn();
        let resolveGerman!: (value: { tags: string[] }) => void;
        predictMetadata.mockResolvedValueOnce({ tags: ['#health'] }).mockImplementationOnce(
            () => new Promise<{ tags: string[] }>((resolve) => { resolveGerman = resolve; }),
        );
        const { result, rerender } = renderHook(({ language }: { language: 'en' | 'de' }) => useTaskItemAi({
            taskId: 'task-1', settings, t, language,
            editTitle: 'Book the dentist', editDescription: '', editContexts: '', editTags: '',
            editStartTime: '', editDueDate: '', editReviewAt: '',
            contextOptions, tagOptions, projectContext: null,
            timeEstimatesEnabled: true, setField,
        }), { initialProps: { language: 'en' as 'en' | 'de' } });
        await settleSuggestion();
        expect(result.current.pendingCopilotParts).toEqual([{ kind: 'tag', value: '#health' }]);

        rerender({ language: 'de' });
        expect(result.current.copilotSuggestion).toBeNull();
        expect(result.current.pendingCopilotParts).toEqual([]);
        await settleSuggestion();
        expect(result.current.pendingCopilotParts).toEqual([]);

        await act(async () => { resolveGerman({ tags: ['#gesundheit'] }); });
        expect(result.current.pendingCopilotParts).toEqual([{ kind: 'tag', value: '#gesundheit' }]);
    });

    it('retries English after an in-flight English request is aborted by en → de → en', async () => {
        const contextOptions = ['@phone'];
        const tagOptions = ['#health'];
        const t = (key: string) => key;
        const setField = vi.fn();
        let resolveOldEnglish!: (value: { tags: string[] }) => void;
        predictMetadata.mockImplementationOnce(() => new Promise<{ tags: string[] }>((resolve) => { resolveOldEnglish = resolve; }))
            .mockResolvedValueOnce({ tags: ['#health'] });
        const { result, rerender } = renderHook(({ language }: { language: 'en' | 'de' }) => useTaskItemAi({
            taskId: 'task-1', settings, t, language,
            editTitle: 'Book the dentist', editDescription: '', editContexts: '', editTags: '',
            editStartTime: '', editDueDate: '', editReviewAt: '',
            contextOptions, tagOptions, projectContext: null,
            timeEstimatesEnabled: true, setField,
        }), { initialProps: { language: 'en' as 'en' | 'de' } });
        await settleSuggestion();
        expect(predictMetadata).toHaveBeenCalledTimes(1);

        rerender({ language: 'de' });
        rerender({ language: 'en' });
        await settleSuggestion();
        expect(predictMetadata).toHaveBeenCalledTimes(2);
        expect(result.current.pendingCopilotParts).toEqual([{ kind: 'tag', value: '#health' }]);
        await act(async () => { resolveOldEnglish({ tags: ['#stale'] }); });
        expect(result.current.pendingCopilotParts).toEqual([{ kind: 'tag', value: '#health' }]);
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

describe('useTaskItemAi breakdown steps', () => {
    const initialTaskState = useTaskStore.getState();
    // The copilot tests above leave fake timers on.
    beforeEach(() => { vi.useRealTimers(); });
    afterEach(() => {
        act(() => useTaskStore.setState(initialTaskState, true));
    });

    it('appends breakdown steps to the checklist a sync save published while the write waited', async () => {
        const at = new Date().toISOString();
        const base = {
            id: 'task-1', title: 'Book the dentist', status: 'next', tags: [], contexts: [], rev: 1,
            checklist: [{ id: 'c1', title: 'One', isCompleted: false }], createdAt: at, updatedAt: at,
        } as Task;
        act(() => useTaskStore.setState({ _allTasks: [base], tasks: [base] }));
        predictMetadata.mockResolvedValue({});
        breakDownTask.mockResolvedValue({ steps: ['Call'] });
        const { result } = renderAi(vi.fn());
        await act(() => result.current.handleAIBreakdown());
        expect(result.current.aiBreakdownSteps).toEqual(['Call']);

        const finish = holdSyncSave(() => useTaskStore.setState({ _allTasks: [{
            ...base,
            rev: 3,
            checklist: [...(base.checklist ?? []), { id: 'c2', title: 'Two', isCompleted: false }],
        }] }));
        act(() => result.current.addBreakdownStepsToChecklist());
        await act(finish);

        await waitFor(() => expect(useTaskStore.getState()._tasksById.get('task-1')?.checklist?.map((item) => item.title))
            .toEqual(['One', 'Two', 'Call']));
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
