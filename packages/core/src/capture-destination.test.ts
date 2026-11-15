import { describe, expect, it } from 'vitest';
import { readCaptureDestination, resolveCaptureDestination } from './capture-destination';
import { planCaptureTask } from './capture';
import { buildQuickCaptureView, createQuickCaptureOptions, planQuickCaptureTask } from './quick-capture-model';
import { safeFormatDate } from './date';
import { buildAndroidCaptureDestinationCatalog } from './widget-payload';
import type { AppData, Area, Project, Section } from './types';

const stamp = '2026-11-14T12:00:00.000Z';
const area: Area = { id: 'area', name: 'Area', order: 0, createdAt: stamp, updatedAt: stamp };
const project: Project = { id: 'project', title: 'Launch', status: 'active', color: '#000000', createdAt: stamp, updatedAt: stamp };
const section: Section = { id: 'section', projectId: project.id, title: 'Plan', order: 0, createdAt: stamp, updatedAt: stamp };
const data = { projects: [project], areas: [area], sections: [section] };
const parsed = { title: 'Capture', props: {}, projectTitle: undefined };

describe('capture destination snapshot', () => {
    it('validates exact destination shapes without converting unspecified to None', () => {
        for (const value of [null, {}, { kind: 'area' }, { kind: 'none', id: 'area' }, { kind: 'project', id: ' ' },
            { kind: 'area', id: 'area', sectionId: 'section' }, { kind: 'project', id: 'project', sectionId: 5 }]) {
            expect(readCaptureDestination(value)).toBeNull();
        }
        expect(readCaptureDestination({ kind: 'project', id: 'project', sectionId: 'section' })).toEqual({ kind: 'project', id: 'project', sectionId: 'section' });
    });

    it('uses explicit choice, inline destination, contextual section, then frozen default', () => {
        const input = { ...data, parsed: { ...parsed, props: { projectId: project.id } },
            initialProps: { projectId: project.id, sectionId: section.id }, selectedAreaId: area.id };
        expect(resolveCaptureDestination({ ...input, destination: { kind: 'none' } }).destination).toEqual({ kind: 'none' });
        expect(resolveCaptureDestination(input).destination).toEqual({ kind: 'project', id: project.id });
        expect(resolveCaptureDestination({ ...input, parsed }).destination).toEqual({ kind: 'project', id: project.id, sectionId: section.id });
        expect(resolveCaptureDestination({ ...data, parsed, selectedAreaId: area.id }).destination).toEqual({ kind: 'area', id: area.id });
    });

    it('shows unresolved creation without creating it, and an explicit choice suppresses creation', () => {
        const input = { ...data, parsed: { ...parsed, projectTitle: 'New project' }, selectedAreaId: area.id };
        expect(resolveCaptureDestination(input)).toMatchObject({ destination: { kind: 'area', id: area.id }, projectToCreate: { title: 'New project' } });
        expect(resolveCaptureDestination({ ...input, destination: { kind: 'none' } }).projectToCreate).toBeUndefined();
        expect(planCaptureTask({ ...input, rawInput: 'Capture +New project', destination: { kind: 'none' } }))
            .toMatchObject({ success: true, props: { status: 'inbox', areaId: undefined } });
        expect(planCaptureTask({ ...input, rawInput: 'Capture +New project', destination: { kind: 'none' } })).not.toHaveProperty('projectToCreate');
    });

    it('refuses stale IDs and mismatched sections rather than resolving a replacement by name', () => {
        expect(planCaptureTask({ ...data, parsed, rawInput: 'Capture', destination: { kind: 'project', id: 'gone' } }))
            .toEqual({ success: false, reason: 'destination-unavailable' });
        expect(planCaptureTask({ ...data, parsed, rawInput: 'Capture', sections: [{ ...section, projectId: 'other' }],
            destination: { kind: 'project', id: project.id, sectionId: section.id } }))
            .toEqual({ success: false, reason: 'destination-unavailable' });
    });

    it('uses the same effective destination for view and save', () => {
        const options = { ...createQuickCaptureOptions({ projects: data.projects, defaultAreaId: area.id }), destination: { kind: 'none' as const } };
        const context = { ...data, settings: {}, focusedCount: 0, defaultAreaId: area.id, parseOptions: {},
            now: new Date(stamp), t: (key: string) => key, formatDate: safeFormatDate };
        expect(buildQuickCaptureView('Capture +Launch', options, context).destination.value).toEqual({ kind: 'none' });
        const planned = planQuickCaptureTask({ text: 'Capture +Launch', options }, context);
        expect(planned).toMatchObject({ success: true });
        if (planned.success) expect(planned.props.projectId).toBeUndefined();
    });

    it('refuses new project creation when its frozen area disappeared', () => {
        const options = createQuickCaptureOptions({ projects: data.projects, defaultAreaId: area.id });
        const context = { ...data, areas: [], settings: {}, focusedCount: 0, defaultAreaId: null, parseOptions: {},
            now: new Date(stamp), t: (key: string) => key, formatDate: safeFormatDate };
        expect(buildQuickCaptureView('Capture +New Project', options, context).canSave).toBe(false);
        expect(planQuickCaptureTask({ text: 'Capture +New Project', options }, context))
            .toMatchObject({ success: false, reason: 'destination-unavailable' });
    });

    it('publishes live choices and the resolved default independently of widget task lists', () => {
        const source: AppData = { ...data, tasks: [], people: [], settings: { gtd: { defaultAreaMode: 'fixed', defaultAreaId: area.id } } };
        const catalog = buildAndroidCaptureDestinationCatalog({ ...source, projects: [...data.projects, { ...project, id: 'deleted', deletedAt: stamp }],
            areas: [...data.areas, { ...area, id: 'deleted', deletedAt: stamp }] }, 'en');
        expect(catalog.defaultDestination).toEqual({ kind: 'area', id: area.id });
        expect(catalog.projects.map(row => row.id)).toEqual([project.id]);
        expect(catalog.areas.map(row => row.id)).toEqual([area.id]);
        expect(catalog.sections).toEqual([{ id: section.id, title: section.title, projectId: project.id }]);
    });
});
