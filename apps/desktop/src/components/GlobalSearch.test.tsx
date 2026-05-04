import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Area, Task } from '@mindwtr/core';
import { useTaskStore } from '@mindwtr/core';
import { LanguageProvider } from '../contexts/language-context';
import { GlobalSearch } from './GlobalSearch';

const initialTaskState = useTaskStore.getState();
const originalScrollIntoView = Element.prototype.scrollIntoView;
const now = '2026-05-03T00:00:00.000Z';

const areas: Area[] = [
    {
        id: 'area-work',
        name: 'Work',
        color: '#2563eb',
        order: 0,
        createdAt: now,
        updatedAt: now,
    },
    {
        id: 'area-home',
        name: 'Home',
        color: '#16a34a',
        order: 1,
        createdAt: now,
        updatedAt: now,
    },
];

const tasks: Task[] = [
    {
        id: 'task-work',
        title: 'Work task',
        status: 'next',
        tags: [],
        contexts: [],
        areaId: 'area-work',
        createdAt: now,
        updatedAt: now,
    },
    {
        id: 'task-home',
        title: 'Home needle task',
        status: 'next',
        tags: [],
        contexts: [],
        areaId: 'area-home',
        createdAt: now,
        updatedAt: now,
    },
];

describe('GlobalSearch', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        Element.prototype.scrollIntoView = vi.fn();
        useTaskStore.setState(initialTaskState, true);
        useTaskStore.setState({
            tasks,
            _allTasks: tasks,
            projects: [],
            areas,
            settings: {
                filters: {
                    areaId: 'area-work',
                },
            },
        });
    });

    afterEach(() => {
        if (originalScrollIntoView) {
            Element.prototype.scrollIntoView = originalScrollIntoView;
        } else {
            delete (Element.prototype as { scrollIntoView?: Element['scrollIntoView'] }).scrollIntoView;
        }
        vi.useRealTimers();
    });

    it('searches all areas when opened from an active area filter', async () => {
        render(
            <LanguageProvider>
                <GlobalSearch onNavigate={vi.fn()} />
            </LanguageProvider>
        );

        await act(async () => {
            window.dispatchEvent(new Event('mindwtr:open-search'));
            await vi.advanceTimersByTimeAsync(50);
        });

        expect(screen.queryByText('Area: Work')).not.toBeInTheDocument();

        fireEvent.change(screen.getByRole('textbox'), {
            target: { value: 'needle' },
        });

        expect(screen.getByText((_, element) => element?.textContent === 'Home needle task')).toBeInTheDocument();
    });
});
