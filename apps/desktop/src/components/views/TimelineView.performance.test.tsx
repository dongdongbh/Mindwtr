import { performance } from 'node:perf_hooks';
import { render } from '@testing-library/react';
import { useTaskStore, type Project, type Task } from '@mindwtr/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { LanguageProvider } from '../../contexts/language-context';
import { TimelineView } from './TimelineView';

const LARGE_TASK_COUNT = 5_000;
const PROJECT_COUNT = 50;
const TIMELINE_RENDER_BUDGET_MS = 500;
const ROW_HEIGHT_PX = 30;
const DATASET_ANCHOR = new Date();
DATASET_ANCHOR.setHours(12, 0, 0, 0);

const initialTaskState = useTaskStore.getState();

const isoAtDayOffset = (offsetDays: number): string => {
    const date = new Date(DATASET_ANCHOR);
    date.setDate(date.getDate() + offsetDays);
    return date.toISOString();
};

const projects: Project[] = Array.from({ length: PROJECT_COUNT }, (_, index) => ({
    id: `timeline-perf-project-${index}`,
    title: `Timeline performance project ${index}`,
    status: 'active',
    order: index,
    createdAt: isoAtDayOffset(-365),
    updatedAt: isoAtDayOffset(-365),
} as Project));

const tasks: Task[] = Array.from({ length: LARGE_TASK_COUNT }, (_, index) => {
    const startOffset = (index % 360) - 180;
    return {
        id: `timeline-perf-task-${index}`,
        title: `Timeline performance task ${index}`,
        status: 'next',
        tags: [],
        contexts: [],
        projectId: projects[index % PROJECT_COUNT].id,
        startTime: isoAtDayOffset(startOffset),
        dueDate: isoAtDayOffset(startOffset + 1 + (index % 7)),
        createdAt: isoAtDayOffset(-365 + (index % 30)),
        updatedAt: isoAtDayOffset(-30),
        order: index,
    };
});

const renderTimeline = () => render(
    <LanguageProvider>
        <TimelineView />
    </LanguageProvider>,
);

describe('TimelineView large-store performance budget', () => {
    beforeEach(() => {
        window.localStorage.clear();
        useTaskStore.setState(initialTaskState, true);
        useTaskStore.setState({
            _allAreas: [],
            _allProjects: projects,
            _allTasks: tasks,
            areas: [],
            lastDataChangeAt: 1,
            projects,
            settings: {},
            tasks,
        });
    });

    it('computes and virtualizes 5,000 dated tasks within budget', () => {
        let bestMs = Number.POSITIVE_INFINITY;

        for (let attempt = 0; attempt < 3; attempt += 1) {
            const startedAt = performance.now();
            const view = renderTimeline();
            bestMs = Math.min(bestMs, performance.now() - startedAt);

            const expectedVirtualHeight = (LARGE_TASK_COUNT + PROJECT_COUNT) * ROW_HEIGHT_PX;
            const virtualRows = Array.from(view.container.querySelectorAll<HTMLElement>('div'))
                .find((element) => element.style.minHeight === `${expectedVirtualHeight}px`);
            expect(virtualRows).toBeDefined();
            expect(view.queryAllByTestId('timeline-bar').length).toBeLessThan(LARGE_TASK_COUNT);
            view.unmount();
        }

        expect(
            bestMs,
            `Desktop TimelineView computation/render took ${bestMs.toFixed(1)}ms with ${LARGE_TASK_COUNT} dated tasks; budget is ${TIMELINE_RENDER_BUDGET_MS}ms`,
        ).toBeLessThanOrEqual(TIMELINE_RENDER_BUDGET_MS);
    }, 15_000);
});
