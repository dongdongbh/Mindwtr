import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeSandboxRuntime, useTaskStore, type Task } from '@mindwtr/core';
import { setNativeInvokeTransport } from './tauri-invoke';
import { beginRendererNavigation, commitRendererNavigation } from './renderer-navigation-diagnostics';

const append = vi.fn((_command: string, _args?: Record<string, unknown>) => {});
let frames: FrameRequestCallback[];
const entries = () => append.mock.calls.map(([, args]) => JSON.parse(args!.line as string));
const task = (status: Task['status'], deletedAt?: string): Task => ({
    id: 'private-id', title: 'private task content', status, deletedAt,
    tags: [], contexts: [], createdAt: '1999-01-01', updatedAt: '1999-01-01',
});

beforeEach(() => {
    initializeSandboxRuntime(true);
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    frames = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => frames.push(callback)));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    setNativeInvokeTransport(async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
        append(command, args);
        return undefined as T;
    });
    useTaskStore.setState({
        settings: { diagnostics: { loggingEnabled: true } },
        _allTasks: [task('inbox'), task('done'), task('archived'), task('reference'), task('next', '2026-10-10')],
        _allProjects: [],
    });
    commitRendererNavigation('trash', null);
});

afterEach(() => {
    append.mockClear();
    setNativeInvokeTransport(null);
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: undefined });
    vi.unstubAllGlobals();
});

describe('renderer navigation diagnostics through the sandbox native log boundary', () => {
    it('correlates requested, committed and frame payloads without exposing content', () => {
        const trace = beginRendererNavigation('board');
        expect(entries().map((entry) => entry.context.stage)).toEqual(['requested']);
        const cancel = commitRendererNavigation('board', trace);
        frames[0](10);
        const records = entries();
        expect(append.mock.calls.every(([command]) => command === 'append_log_line')).toBe(true);
        expect(records.map((entry) => entry.context.stage)).toEqual(['requested', 'content-committed', 'animation-frame']);
        for (const { context } of records) {
            expect(context).toMatchObject({
                releaseCheck: 'v1.3.5/renderer-navigation', workspace: 'sandbox',
                rendererRun: records[0].context.rendererRun,
                navigationSequence: String(trace.sequence), previousView: 'trash', nextView: 'board',
                taskCountBucket: '1-10', trashCountBucket: '1-10', historyCountBucket: '1-10',
                referenceCountBucket: '1-10', boardCountBucket: '1-10', projectCountBucket: '0',
            });
        }
        expect(records[1].context.actualView).toBe('board');
        expect(JSON.stringify(records)).not.toMatch(/private|1999-01-01|\[redacted\]/);
        cancel();
    });

    it('allows only fixed route categories and records actual fallback content separately', () => {
        const saved = beginRendererNavigation('savedSearch:private-search-id');
        commitRendererNavigation('savedSearch:private-search-id', saved)();
        const unknown = beginRendererNavigation('private custom route');
        commitRendererNavigation('private custom route', unknown)();
        const records = entries();
        expect(records[0].context.nextView).toBe('saved-search');
        expect(records[2].context.nextView).toBe('other');
        expect(records[3].context.actualView).toBe('inbox');
        expect(JSON.stringify(records)).not.toMatch(/private/);
    });

    it('does not append or scan task state when logging is disabled', () => {
        useTaskStore.setState({ settings: { diagnostics: { loggingEnabled: false } } });
        const state = useTaskStore.getState();
        const read = vi.spyOn(useTaskStore, 'getState').mockReturnValue({
            ...state,
            get _allTasks(): Task[] { throw new Error('disabled diagnostics must not scan'); },
        });
        const trace = beginRendererNavigation('reference');
        commitRendererNavigation('reference', trace)();
        expect(append).not.toHaveBeenCalled();
        expect(frames).toHaveLength(0);
        read.mockRestore();
    });

    it('suppresses cancelled callbacks and superseded frames with distinct sequences', () => {
        const first = beginRendererNavigation('history');
        const cancel = commitRendererNavigation('history', first);
        cancel();
        frames[0](10); // Even a callback already delivered by the scheduler is fenced.
        const second = beginRendererNavigation('board');
        const cancelSecond = commitRendererNavigation('board', second);
        const third = beginRendererNavigation('reference');
        frames[1](20);
        const cancelThird = commitRendererNavigation('reference', third);
        frames[2](30);
        expect(second.sequence).toBe(first.sequence + 1);
        expect(third.sequence).toBe(second.sequence + 1);
        expect(entries().filter((entry) => entry.context.stage === 'animation-frame').map((entry) => entry.context.navigationSequence))
            .toEqual([String(third.sequence)]);
        cancelSecond();
        cancelThird();
    });

    it('does not duplicate commit/frame phases on effect replay or append after opt-out', () => {
        const trace = beginRendererNavigation('reference');
        commitRendererNavigation('reference', trace)();
        const cancel = commitRendererNavigation('reference', trace);
        frames[1](10);
        frames[1](20);
        expect(entries().map((entry) => entry.context.stage)).toEqual(['requested', 'content-committed', 'animation-frame']);
        cancel();
        const next = beginRendererNavigation('trash');
        commitRendererNavigation('trash', next);
        useTaskStore.setState({ settings: { diagnostics: { loggingEnabled: false } } });
        frames[2](30);
        expect(entries().filter((entry) => entry.context.stage === 'animation-frame')).toHaveLength(1);
    });
});
