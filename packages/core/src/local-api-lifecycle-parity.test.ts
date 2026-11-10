import { describe, expect, it } from 'vitest';
import reopen from './__fixtures__/local-api-reopen.json';
import areas from './__fixtures__/local-api-area-create.json';
import { prepareTaskUpdatesForStore, planTaskUpdateEffects } from './store-tasks';
import { planAreaAddition } from './store-projects/area-actions';
import { normalizeTaskStatus } from './task-status';
import type { AppData, Attachment, Project } from './types';

type FixtureData = typeof reopen.cases[number]['before'] | typeof areas.cases[number]['before'];

const projectStatus = (status: string): Project['status'] => {
    if (status === 'active' || status === 'waiting' || status === 'someday' || status === 'archived') return status;
    throw new Error('Invalid fixture project status');
};

const fixtureData = (data: FixtureData): AppData => ({
    ...data,
    tasks: data.tasks.map((task) => {
        const attachments: Attachment[] | undefined = 'attachments' in task ? task.attachments?.map((attachment) => {
            const kind = attachment.kind;
            if (kind !== 'link') throw new Error('Invalid fixture attachment kind');
            return { ...attachment, kind };
        }) : undefined;
        return { ...task, status: normalizeTaskStatus(task.status), attachments, statusBeforeProjectArchive: 'statusBeforeProjectArchive' in task ? normalizeTaskStatus(task.statusBeforeProjectArchive) : undefined };
    }),
    projects: data.projects.map((project) => ({ ...project, status: projectStatus(project.status) })),
});

const comparable = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('Local API lifecycle golden parity with shared core plans', () => {
    for (const testCase of reopen.cases) {
        it(testCase.label, () => {
            const before = fixtureData(structuredClone(testCase.before));
            const task = before.tasks.find((task) => task.id === 'source');
            if (!task) throw new Error('Missing fixture source');
            const prepared = prepareTaskUpdatesForStore({ task, updates: { status: normalizeTaskStatus(testCase.status) },
                allProjects: before.projects, allSections: before.sections, allAreas: before.areas, settings: before.settings, nowMs: Date.parse(reopen.at) });
            expect(prepared.ok).toBe(!testCase.refused);
            if (!prepared.ok) return;
            const planned = planTaskUpdateEffects({ task, preparedUpdates: prepared.updates,
                allTasks: before.tasks, allProjects: before.projects, allSections: before.sections, now: reopen.at, deviceId: reopen.deviceId });
            expect(planned.recurringFollowUpTask).toBeNull();
            expect(comparable({ ...before, tasks: planned.tasks, projects: planned.projects, sections: planned.sections })).toEqual(testCase.after);
            expect(comparable(before)).toEqual(testCase.before);
        });
    }

    for (const testCase of areas.cases) {
        it(testCase.label, () => {
            const before = fixtureData(structuredClone(testCase.before));
            const planned = planAreaAddition({ areas: before.areas, projects: before.projects, sections: before.sections, tasks: before.tasks },
                testCase.name, testCase.props, areas.newId, areas.deviceId, areas.at, areas.updateAt);
            expect(planned?.kind).toBe(testCase.kind);
            expect(planned?.area.id).toBe(testCase.areaId);
            expect(comparable({ ...before, ...planned?.rows })).toEqual(testCase.after);
            expect(comparable(before)).toEqual(testCase.before);
        });
    }
});
