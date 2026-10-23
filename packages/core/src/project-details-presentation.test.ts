import { describe, expect, it } from 'vitest';
import { getProjectDetailsPresentation, formatProjectDate } from './project-details-presentation';
import type { Project } from './types';

const t = (key: string) => ({
    'status.active': 'Active',
    'status.waiting': 'Waiting',
    'status.someday': 'Someday',
    'status.archived': 'Archived',
    'projects.cancelled': 'Cancelled',
    'projects.parallel': 'Parallel',
    'projects.sequential': 'Sequential',
    'projects.sequentialAcrossSections': 'Across sections',
    'projects.sequentialWithinSections': 'Within sections',
    'projects.noArea': 'No Area',
    'projects.sectionsLabel': 'Sections',
    'common.none': 'None',
    'common.notSet': 'Not set',
} as Record<string, string>)[key] ?? key;

const project = (patch: Partial<Project> = {}): Project => ({
    id: 'p', title: 'Plan', status: 'active', color: '#123456', order: 0, tagIds: [],
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    ...patch,
});

const render = (item: Project, patch: Partial<Parameters<typeof getProjectDetailsPresentation>[1]> = {}) =>
    getProjectDetailsPresentation(item, {
        isArchivedProject: false, areaName: 'No Area', sections: [], t, ...patch,
    });

describe('Project Details presentation shared with RN', () => {
    it('names the Per section Flow mode and keeps project-wide Sequential first (#1429)', () => {
        expect(render(project({ perSectionFlow: true })).typeLabel).toBe('Per section');
        expect(render(project({ perSectionFlow: true })).sequentialScopeLabel).toBeNull();
        expect(render(project({ isSequential: true, perSectionFlow: true })).typeLabel).toBe('Sequential');
    });

    it('shows Clear only for RN truthy raw dates, even if raw text equals the missing label', () => {
        for (const value of [undefined, null, '', 'Not set', 'invalid', '2026-03-08', '2026-03-08T04:30:00.000Z']) {
            const item = project({ startDate: value, dueDate: value, reviewAt: value } as Partial<Project>);
            const before = structuredClone(item);
            expect(render(item)).toMatchObject({ hasStartDate: Boolean(value), hasDueDate: Boolean(value),
                hasReviewDate: Boolean(value) });
            expect(item).toEqual(before);
        }
    });

    it('keeps RN status, type, area and section summary policy, including live archived override', () => {
        expect(render(project()).summary).toBe('Active · Parallel');
        expect(render(project({ status: 'waiting' })).statusLabel).toBe('Waiting');
        expect(render(project({ status: 'someday' })).statusLabel).toBe('Someday');
        expect(render(project({ status: 'archived' })).statusLabel).toBe('Archived');
        expect(render(project({ cancelledAt: '2026-09-04T00:00:00.000Z' }), { isArchivedProject: true }).statusLabel)
            .toBe('Cancelled');
        expect(render(project({ status: 'active' }), { isArchivedProject: true }).statusLabel).toBe('Archived');
        const details = render(project({ isSequential: true, sequentialScope: 'section' }), {
            areaName: 'Work', sections: [{ id: 'one', title: 'First' }, { id: 'two', title: 'Second' }],
        });
        expect(details).toMatchObject({
            summary: 'Active · Sequential · Work · 2 Sections', typeLabel: 'Sequential',
            sequentialScopeLabel: 'Within sections', areaLabel: 'Work',
            sections: [{ id: 'one', title: 'First' }, { id: 'two', title: 'Second' }],
        });
        expect(render(project({ isSequential: true })).sequentialScopeLabel).toBe('Across sections');
        expect(render(project()).sequentialScopeLabel).toBeNull();
    });

    it('keeps RN missing-area, tags, and raw-invalid date display without modifying the Project', () => {
        const item = project({
            areaId: 'missing', tagIds: ['#one', '#two'],
            startDate: 'not-a-date', dueDate: '2026-09-15', reviewAt: '2026-09-15T15:30:00.000Z',
        });
        const before = structuredClone(item);
        const details = render(item);
        expect(details.areaLabel).toBe('No Area');
        expect(details.tagsLabel).toBe('#one, #two');
        expect(details.startDateLabel).toBe('not-a-date');
        expect(details.dueDateLabel).toBe(formatProjectDate(item.dueDate, 'Not set'));
        expect(details.reviewDateLabel).toBe(formatProjectDate(item.reviewAt, 'Not set'));
        expect(details.dueDateLabel).toBe(new Date(2026, 8, 15).toLocaleDateString());
        expect(item).toEqual(before);
        expect(render(project()).tagsLabel).toBe('None');
        expect(render(project()).startDateLabel).toBe('Not set');
    });
});
