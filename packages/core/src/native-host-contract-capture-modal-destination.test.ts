import { afterEach, describe, expect, it } from 'vitest';
import { openScreenHost, requestId, value } from './screen-parity.replay';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import type { Area, Project } from './types';

const at = '2026-11-14T00:00:00.000Z';
const areas: Area[] = ['a-home', 'a-work'].map((id, order) => ({ id, name: id, order, createdAt: at, updatedAt: at }));
const projects: Project[] = [{ id: 'p-home', title: 'Home', status: 'active', color: '#123456', order: 0,
    tagIds: [], areaId: 'a-home', createdAt: at, updatedAt: at }];
const open = () => openScreenHost({ data: { tasks: [], projects, areas,
    settings: { gtd: { defaultAreaMode: 'fixed', defaultAreaId: 'a-home' } } }, record: {}, log: [] });

afterEach(async () => { await flushPendingSave(); resetForTests(); });

describe('native capture screen destination', () => {
    it('snapshots the initial default and keeps explicit None over conflicting inline creation', async () => {
        const host = await open();
        const params = {};
        const opened = value(host.openCaptureModal({ params }));
        expect(opened.view.destination.value).toEqual({ kind: 'area', id: 'a-home' });
        useTaskStore.setState(state => ({ settings: { ...state.settings, gtd: { defaultAreaMode: 'fixed', defaultAreaId: 'a-work' } } }));
        const captureId = requestId();
        value(await host.submitCaptureModal({ params, draft: { ...opened.draft, text: 'Keep baseline' }, captureId }));
        expect(useTaskStore.getState()._allTasks.find(task => task.id === captureId)?.areaId).toBe('a-home');
        const edited = value(host.editCaptureModal({ params, draft: { ...opened.draft, text: 'Keep title +Unknown' },
            edit: { type: 'selectDestination', destination: { kind: 'none' } } }));
        expect(edited.view.destination.value).toEqual({ kind: 'none' });
        const noneId = requestId();
        value(await host.submitCaptureModal({ params, draft: edited.draft, captureId: noneId }));
        const task = useTaskStore.getState()._allTasks.find(task => task.id === noneId);
        expect(task?.projectId).toBeUndefined();
        expect(task?.areaId).toBeUndefined();
        expect(useTaskStore.getState().projects.some(project => project.title === 'Unknown')).toBe(false);
    });

    it('shows and durably saves a contextual project section, and project changes clear it', async () => {
        const host = await open();
        const section = await useTaskStore.getState().addSection('p-home', 'Planning');
        if (!section) throw new Error('Section missing');
        const params = { initialProps: JSON.stringify({ projectId: 'p-home', sectionId: section.id }) };
        const opened = value(host.openCaptureModal({ params }));
        expect(opened.view.destination.value).toEqual({ kind: 'project', id: 'p-home', sectionId: section.id });
        expect(opened.view.destination.label).toContain('Planning');
        const captureId = requestId();
        value(await host.submitCaptureModal({ params, draft: { ...opened.draft, text: 'Plan' }, captureId }));
        expect(useTaskStore.getState()._allTasks.find(task => task.id === captureId)?.sectionId).toBe(section.id);
        const changed = value(host.editCaptureModal({ params, draft: opened.draft,
            edit: { type: 'selectDestination', destination: { kind: 'project', id: 'p-home' } } }));
        expect(changed.view.destination.value).toEqual({ kind: 'project', id: 'p-home' });
    });

    it('retains missing contextual destinations and refuses text and bulk without writing a replacement', async () => {
        const host = await open();
        const params = { initialProps: JSON.stringify({ projectId: 'missing-project', sectionId: 'missing-section' }) };
        const opened = value(host.openCaptureModal({ params }));
        expect(opened.view.destination.available).toBe(false);
        expect(opened.draft.initialDestination).toEqual({ kind: 'project', id: 'missing-project', sectionId: 'missing-section' });
        expect(await host.submitCaptureModal({ params, draft: { ...opened.draft, text: 'Retain me' }, captureId: requestId() })).toMatchObject({ ok: false });
        expect(await host.submitCaptureModalLines({ params, draft: { ...opened.draft, text: 'One\nTwo' }, captureIds: [requestId(), requestId()] })).toMatchObject({ ok: false });
        expect(useTaskStore.getState()._allTasks).toEqual([]);
        expect(useTaskStore.getState().projects).toHaveLength(1);
    });

    it('replays the original durable receipt after its target area is deleted', async () => {
        const host = await open();
        const params = {}, opened = value(host.openCaptureModal({ params }));
        const input = { params, draft: { ...opened.draft, text: 'Once' }, captureId: requestId() };
        const saved = value(await host.submitCaptureModal(input));
        useTaskStore.setState(state => ({ _allAreas: state._allAreas.map(area => area.id === 'a-home' ? { ...area, deletedAt: at } : area) }));
        expect(value(await host.submitCaptureModal(input))).toEqual(saved);
        expect(useTaskStore.getState()._allTasks.filter(task => task.id === input.captureId)).toHaveLength(1);
    });

    it('refuses pending named-project creation when its frozen area disappeared', async () => {
        const host = await open();
        const params = {}, opened = value(host.openCaptureModal({ params }));
        useTaskStore.setState(state => ({ _allAreas: state._allAreas.map(area => area.id === 'a-home' ? { ...area, deletedAt: at } : area) }));
        const draft = { ...opened.draft, text: 'Keep me +Unknown' };
        expect(value(host.getCaptureModalView({ params, draft })).destination.available).toBe(false);
        expect(await host.submitCaptureModal({ params, draft, captureId: requestId() })).toMatchObject({ ok: false });
        expect(useTaskStore.getState().projects).toHaveLength(1);
        expect(useTaskStore.getState()._allTasks).toEqual([]);
    });
});
