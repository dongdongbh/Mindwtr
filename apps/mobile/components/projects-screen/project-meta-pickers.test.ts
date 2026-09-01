import { AREA_PRESET_COLORS, getEnglishI18nValue, type Project } from '@mindwtr/core';
import { describe, expect, it, vi } from 'vitest';

import { applyLiveProjectUpdate, AREA_COLOR_DISPLAY_BY_HEX } from './project-meta-pickers';

describe('AREA_COLOR_DISPLAY_BY_HEX', () => {
    it('names every preset color for the iOS action sheets', () => {
        // Without a row the sheet falls back to a raw hex like "◯ #F97316".
        for (const color of AREA_PRESET_COLORS) {
            expect(AREA_COLOR_DISPLAY_BY_HEX[color]?.nameKey).toBeTruthy();
            expect(AREA_COLOR_DISPLAY_BY_HEX[color]?.swatch).toBeTruthy();
        }
    });

    it('uses translation keys that exist in English', () => {
        for (const meta of Object.values(AREA_COLOR_DISPLAY_BY_HEX)) {
            expect(getEnglishI18nValue(meta.nameKey)).toBeTruthy();
        }
    });

    it('does not name colors that are not in the palette', () => {
        const palette = new Set<string>(AREA_PRESET_COLORS);
        expect(Object.keys(AREA_COLOR_DISPLAY_BY_HEX).filter((hex) => !palette.has(hex))).toEqual([]);
    });
});

describe('applyLiveProjectUpdate', () => {
    it('drops a delayed picker callback after the project becomes archived', () => {
        const activeProject = {
            id: 'project-1',
            title: 'Project',
            status: 'active' as const,
            color: '#3b82f6',
            order: 0,
            tagIds: [],
            createdAt: '2026-08-31T00:00:00.000Z',
            updatedAt: '2026-08-31T00:00:00.000Z',
        };
        let liveProject: Project = activeProject;
        const updateProject = vi.fn();
        const setSelectedProject = vi.fn();
        const onBlocked = vi.fn();
        const delayedSelect = () => applyLiveProjectUpdate({
            projectId: activeProject.id,
            updates: { areaId: 'area-2' },
            updateProject,
            setSelectedProject,
            onBlocked,
            getProjectById: () => liveProject,
        });

        liveProject = { ...activeProject, status: 'archived' };
        expect(delayedSelect()).toBe(false);
        expect(updateProject).not.toHaveBeenCalled();
        expect(setSelectedProject).not.toHaveBeenCalled();
        expect(onBlocked).toHaveBeenCalledTimes(1);
    });
});
