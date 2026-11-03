import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useTaskStore, type Task } from '@mindwtr/core';
import { useTaskItemProjectContext } from './useTaskItemProjectContext';

const initialState = useTaskStore.getState();
beforeEach(() => act(() => useTaskStore.setState(initialState, true)));

it('keeps quick chips visible-only while typed editor suggestions include retained contexts', async () => {
    const timestamp = '2026-09-27T00:00:00.000Z';
    const task = (id: string, status: Task['status'], deletedAt?: string): Task => ({
        id, title: id, status, contexts: [`@${id}-only`], tags: [], createdAt: timestamp, updatedAt: timestamp, deletedAt,
    });
    const active = task('active', 'next');
    act(() => useTaskStore.setState({ _allTasks: [
        active, task('done', 'done'), task('archived', 'archived'), task('deleted', 'next', timestamp),
        { ...task('bare', 'archived'), contexts: ['Seasonal Planning'] },
    ] }));
    const setField = vi.fn();
    const { result } = renderHook(() => useTaskItemProjectContext({
        task: active, sections: [], isEditing: true, editProjectId: '', setField,
    }));
    await waitFor(() => expect(result.current.allContexts).toEqual(['@active-only', '@archived-only', '@done-only', '@Seasonal Planning']));
    expect(result.current.popularContextOptions).toEqual(['@active-only', '@done-only']);
});


it('offers saved unused contexts and tags and refreshes while the editor remains open', async () => {
    const timestamp = '2026-10-20T00:00:00.000Z';
    const task: Task = { id: 'active', title: 'Active', status: 'next', contexts: [], tags: [], createdAt: timestamp, updatedAt: timestamp };
    act(() => useTaskStore.setState({ _allTasks: [task], settings: {} }));
    const setField = vi.fn();
    const { result } = renderHook(() => useTaskItemProjectContext({ task, sections: [], isEditing: true, editProjectId: '', setField }));
    act(() => useTaskStore.setState({ settings: { taxonomy: {
        contexts: [{ token: '@garden', rev: 1, revBy: 'test', updatedAt: timestamp }],
        tags: [{ token: '#supplies', rev: 1, revBy: 'test', updatedAt: timestamp }],
    } } }));
    await waitFor(() => expect(result.current.allContexts).toEqual(['@garden']));
    expect(result.current.tagOptions).toEqual(['#supplies']);
    expect(result.current.popularContextOptions).toEqual([]);
    expect(result.current.popularTagOptions).toEqual([]);
    expect(task.contexts).toEqual([]);
    expect(task.tags).toEqual([]);
});
