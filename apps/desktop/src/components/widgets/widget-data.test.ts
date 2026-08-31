import { describe, expect, it } from 'vitest';
import type { AppData, Task } from '@mindwtr/core';
import {
    buildWidgetMonthGrid,
    getDesktopWidgetKindFromLocation,
    getTodayKey,
    isDesktopWidgetLocation,
    resolveWeekStart,
    selectWidgetTasksForDay,
} from './widget-data';

const iso = (value: string): string => `${value}T09:00:00`;

function makeTask(overrides: Partial<Task> & { id: string }): Task {
    return {
        title: overrides.id,
        status: 'next',
        tags: [],
        contexts: [],
        ...overrides,
    } as Task;
}

const baseData = (tasks: Task[]): AppData => ({
    tasks,
    projects: [],
    sections: [],
    areas: [],
    settings: {},
}) as AppData;

describe('desktop widget window detection', () => {
    it('detects the widget query param', () => {
        expect(isDesktopWidgetLocation({ search: '?desktopWidget=calendar' })).toBe(true);
        expect(isDesktopWidgetLocation({ search: '?desktopWidget=today' })).toBe(true);
        expect(isDesktopWidgetLocation({ search: '' })).toBe(false);
        expect(isDesktopWidgetLocation({ search: '?desktopWidget=notes' })).toBe(false);
        expect(isDesktopWidgetLocation({ search: '?quickAddWindow=1' })).toBe(false);
    });

    it('returns the widget kind when valid', () => {
        expect(getDesktopWidgetKindFromLocation({ search: '?desktopWidget=today' })).toBe('today');
        expect(getDesktopWidgetKindFromLocation({ search: '?desktopWidget=bogus' })).toBeNull();
    });
});

describe('selectWidgetTasksForDay', () => {
    const now = new Date('2026-03-05T10:00:00');

    it('selects active tasks due or starting on the day', () => {
        const data = baseData([
            makeTask({ id: 'due', dueDate: iso('2026-03-05') }),
            makeTask({ id: 'start', startTime: iso('2026-03-05') }),
            makeTask({ id: 'other', dueDate: iso('2026-03-06') }),
            makeTask({ id: 'done', status: 'done', dueDate: iso('2026-03-05') }),
        ]);
        const result = selectWidgetTasksForDay(data, '2026-03-05', { includeCompleted: false, now });
        expect(result.dueToday.map((task) => task.id)).toEqual(['due', 'start']);
        expect(result.completedToday).toHaveLength(0);
    });

    it('collects tasks completed that day only when enabled', () => {
        const data = baseData([
            makeTask({ id: 'done-early', status: 'done', completedAt: iso('2026-03-04') }),
            makeTask({ id: 'done-today', status: 'done', completedAt: iso('2026-03-05') }),
        ]);
        const withoutCompleted = selectWidgetTasksForDay(data, '2026-03-05', { includeCompleted: false, now });
        expect(withoutCompleted.completedToday).toHaveLength(0);
        const withCompleted = selectWidgetTasksForDay(data, '2026-03-05', { includeCompleted: true, now });
        expect(withCompleted.completedToday.map((task) => task.id)).toEqual(['done-today']);
    });

    it('tolerates missing data', () => {
        expect(selectWidgetTasksForDay(null, '2026-03-05', { includeCompleted: true, now })).toEqual({
            dueToday: [],
            completedToday: [],
        });
    });
});

describe('buildWidgetMonthGrid', () => {
    it('starts weeks on Monday and marks due days', () => {
        const grid = buildWidgetMonthGrid(2026, 2, {
            weekStart: 'monday',
            todayKey: '2026-03-05',
            dueKeys: new Set(['2026-03-05']),
            localeCode: 'en',
        });
        expect(grid.weekdayLabels[0]).toMatch(/M|Mon/i);
        expect(grid.leadingBlanks).toBe(6); // March 2026 starts on a Sunday.
        const todayCell = grid.cells.find((cell) => cell.key === '2026-03-05');
        expect(todayCell?.isToday).toBe(true);
        expect(todayCell?.hasDue).toBe(true);
    });

    it('supports Sunday week starts', () => {
        const grid = buildWidgetMonthGrid(2026, 2, {
            weekStart: 'sunday',
            todayKey: '2026-03-05',
            dueKeys: new Set(),
            localeCode: 'en',
        });
        expect(grid.leadingBlanks).toBe(0);
    });
});

describe('resolveWeekStart', () => {
    it('honors explicit settings', () => {
        expect(resolveWeekStart('saturday', 'en')).toBe('saturday');
    });

    it('falls back by region', () => {
        expect(resolveWeekStart(undefined, 'zh-CN')).toBe('sunday');
        expect(resolveWeekStart(undefined, 'de-DE')).toBe('monday');
        expect(resolveWeekStart(undefined, 'en')).toBe('monday');
    });
});

describe('getTodayKey', () => {
    it('formats local dates as YYYY-MM-DD', () => {
        expect(getTodayKey(new Date(2026, 2, 5))).toBe('2026-03-05');
        expect(getTodayKey(new Date(2026, 11, 31))).toBe('2026-12-31');
    });
});
