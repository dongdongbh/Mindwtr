import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CalendarPlanningPanel } from './CalendarPlanningPanel';

const controller = {
    locale: 'en-US',
    planningTasks: [],
    resolveText: (_key: string, fallback: string) => fallback,
    scheduleError: null,
    schedulePlanningTask: vi.fn(),
    selectedDate: null,
};

describe('CalendarPlanningPanel', () => {
    it('keeps the collapsed panel expandable at every width', () => {


        const onCollapsedChange = vi.fn();
        const { container } = render(
            <CalendarPlanningPanel
                controller={controller}
                isCollapsed
                onCollapsedChange={onCollapsedChange}
            />
        );

        const aside = container.querySelector('aside');
        expect(aside).not.toBeNull();
        expect(aside!.className.split(' ')).not.toContain('hidden');

        fireEvent.click(screen.getByRole('button', { name: 'Expand planning panel' }));
        expect(onCollapsedChange).toHaveBeenCalledWith(false);
    });

    it('collapses from the expanded header button', () => {
        const onCollapsedChange = vi.fn();
        render(
            <CalendarPlanningPanel
                controller={controller}
                isCollapsed={false}
                onCollapsedChange={onCollapsedChange}
            />
        );

        fireEvent.click(screen.getByRole('button', { name: 'Collapse planning panel' }));
        expect(onCollapsedChange).toHaveBeenCalledWith(true);
    });
});
