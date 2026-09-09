import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { loadTranslations, useTaskStore } from '@mindwtr/core';
import type { Task } from '@mindwtr/core';

import { LanguageProvider } from '../../contexts/language-context';
import { KeybindingProvider } from '../../contexts/keybinding-context';
import { useUiStore } from '../../store/ui-store';
import { AgendaView } from './AgendaView';
import { ListView } from './ListView';

type ShowToast = ReturnType<typeof useUiStore.getState>['showToast'];
type MoveTask = ReturnType<typeof useTaskStore.getState>['moveTask'];

// The desktop LanguageProvider pins tests to English, so the locale under test
// is injected through useLanguage — with the strings actually shipped for
// Simplified Chinese ('zh'), not a stand-in.
const zh = await loadTranslations('zh');
vi.mock('../../contexts/language-context', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../contexts/language-context')>();
    const translations = await (await import('@mindwtr/core')).loadTranslations('zh');
    return {
        ...actual,
        useLanguage: () => ({
            language: 'zh' as const,
            setLanguage: () => undefined,
            t: (key: string) => translations[key] ?? key,
        }),
    };
});

const now = '2026-02-28T12:00:00.000Z';
const task: Task = {
    id: 'task-1',
    title: 'Buy milk',
    status: 'next',
    isFocusedToday: true,
    tags: [],
    contexts: [],
    createdAt: now,
    updatedAt: now,
};

const expectedDoneToast = zh['task.markedDone'].replace('{title}', task.title);

let showToast = vi.fn<ShowToast>();
let moveTask = vi.fn<MoveTask>();

beforeEach(() => {
    showToast = vi.fn<ShowToast>();
    moveTask = vi.fn<MoveTask>(async () => ({ success: true }));
    useUiStore.setState({ showToast, editingTaskId: null });
    useTaskStore.setState((state) => ({
        ...state,
        tasks: [task],
        _allTasks: [task],
        projects: [],
        _allProjects: [],
        areas: [],
        _allAreas: [],
        highlightTaskId: null,
        settings: {
            ...state.settings,
            keybindingStyle: 'vim',
            undoNotificationsEnabled: true,
        },
        moveTask,
    } as never));
});

// The two views used to reach the keyboard "marked Done" toast through
// different code: ListView localized it in one branch and hardcoded English in
// the other, while Focus went through the DOM fallback. Both now register the
// same scope, so both must speak the user's language.
describe.each([
    {
        name: 'Focus (AgendaView)',
        view: <AgendaView />,
        currentView: 'agenda',
    },
    {
        name: 'ListView',
        view: <ListView title="Next" statusFilter="next" />,
        currentView: 'next',
    },
])('$name marks a task Done in the active locale', ({ view, currentView }) => {
    it('shows the translated toast, not an English one', async () => {
        render(
            <LanguageProvider>
                <KeybindingProvider currentView={currentView} onNavigate={() => undefined}>
                    <div data-main-content tabIndex={-1}>{view}</div>
                </KeybindingProvider>
            </LanguageProvider>
        );

        await waitFor(() => expect(document.querySelector('[data-task-id="task-1"]')).not.toBeNull());

        (document.activeElement as HTMLElement | null)?.blur?.();
        fireEvent.keyDown(window, { key: 'x' });

        await waitFor(() => expect(moveTask).toHaveBeenCalledWith('task-1', 'done'));
        await waitFor(() => expect(showToast).toHaveBeenCalledWith(
            expectedDoneToast,
            'info',
            5000,
            expect.objectContaining({ label: zh['common.undo'] }),
        ));
        expect(expectedDoneToast).not.toContain('marked Done');
    });
});
