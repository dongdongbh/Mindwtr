import { describe, expect, it } from 'vitest';
import { getTaskMetadataFilterVisibility } from './task-metadata-filter-visibility';
import type { Task } from './types';

const task = (overrides: Partial<Task>): Task => ({
    id: overrides.id ?? 'task',
    title: overrides.title ?? 'Task',
    status: overrides.status ?? 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
});

describe('getTaskMetadataFilterVisibility', () => {
    it('offers estimate filtering before any tasks have estimates', () => {
        expect(getTaskMetadataFilterVisibility([
            task({ id: 'plain' }),
        ], {
            prioritiesEnabled: true,
            timeEstimatesEnabled: true,
        })).toEqual({
            energyLevel: false,
            location: false,
            priority: false,
            timeEstimate: true,
        });
    });

    it('shows optional metadata filters when visible tasks use those fields', () => {
        expect(getTaskMetadataFilterVisibility([
            task({ id: 'priority', priority: 'urgent' }),
            task({ id: 'energy', energyLevel: 'high' }),
            task({ id: 'time', timeEstimate: '30min' }),
            task({ id: 'location', location: 'Office' }),
        ], {
            prioritiesEnabled: true,
            timeEstimatesEnabled: true,
        })).toEqual({
            energyLevel: true,
            location: true,
            priority: true,
            timeEstimate: true,
        });
    });

    it('keeps feature-flagged metadata filters hidden when disabled', () => {
        expect(getTaskMetadataFilterVisibility([
            task({ priority: 'urgent', timeEstimate: '30min' }),
        ], {
            prioritiesEnabled: false,
            timeEstimatesEnabled: false,
        })).toMatchObject({
            priority: false,
            timeEstimate: false,
        });
    });
});
