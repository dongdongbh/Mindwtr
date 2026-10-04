import { afterEach, describe, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { base64ToBytes } from './base64-bytes';
import { serializeMindwtrCsv } from './mindwtr-csv-export';
import { createBackupFileName, serializeBackupData } from './backup-transfer';
import { buildDataSettingsModel } from './data-settings-model';
import { createNativeHostContract } from './native-host-contract';
import { acquireWorkspaceTransitionLock } from './sandbox';
import * as sandbox from './sandbox';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import * as store from './store';
import { getInMemoryAppDataSnapshot } from './sync-client-helpers';
import * as snapshots from './sync-client-helpers';
import { buildTaskNotesExportZip } from './tasknotes-export';
import type { AppData } from './types';

const now = '2026-10-04T12:34:56.789Z';
const fixture = (): AppData => ({
    tasks: [{ id: 'export-task', title: '日本語 🦉', status: 'reference', tags: ['kept'], contexts: [],
        createdAt: now, updatedAt: now, notes: 'Multiline\nnotes', dueDate: '2026-10-05',
        checklist: [{ id: 'check', title: 'Keep me', isCompleted: false }] }],
    projects: [], sections: [], areas: [], people: [],
    settings: { language: 'ar', diagnostics: { loggingEnabled: false } },
});

async function openHost() {
    await flushPendingSave();
    resetForTests();
    const saveData = vi.fn(async () => {});
    setStorageAdapter({ getData: async () => fixture(), saveData });
    useTaskStore.setState({ tasks: [], projects: [], sections: [], areas: [], people: [],
        _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        error: null, persistenceFailure: null, isLoading: false, editLockCount: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const host = createNativeHostContract();
    expect((await host.activate({ writeSafetyReady: true })).ok).toBe(true);
    await flushPendingSave();
    saveData.mockClear();
    return { host, saveData };
}

const formats = ['json', 'csv', 'tasknotes'] as const;

describe('native JSON, CSV and TaskNotes export', () => {
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it('uses the actual RN snapshot and serializer without changing the store or saving', async () => {
        const { host, saveData } = await openHost();
        vi.useFakeTimers();
        vi.setSystemTime(new Date(now));
        const snapshot = getInMemoryAppDataSnapshot();
        const before = JSON.stringify(snapshot);
        const result = host.getDataBackup();
        expect(result).toEqual({ ok: true, value: {
            fileName: createBackupFileName(new Date(now)), content: serializeBackupData(snapshot),
            encoding: 'utf8',
        } });
        expect(JSON.stringify(getInMemoryAppDataSnapshot())).toBe(before);
        expect(saveData).not.toHaveBeenCalled();
        // A later edit cannot change a prepared file's bytes.
        useTaskStore.setState({ settings: { language: 'en' } });
        expect(result.ok && JSON.parse(result.value.content).settings.language).toBe('ar');
    });

    it('exports all live CSV records with RN quoting, history and container lookup without saving', async () => {
        const { host, saveData } = await openHost();
        const task = fixture().tasks[0];
        useTaskStore.setState({ tasks: [], _allTasks: [
            { ...task, title: '日本語, "quoted"\nnext line', description: 'two\nlines', projectId: 'project', sectionId: 'section' },
            { ...task, id: 'done', status: 'done', completedAt: now },
            { ...task, id: 'deleted', deletedAt: now },
            { ...task, id: 'purged', purgedAt: now },
        ], projects: [], _allProjects: [{ id: 'project', title: 'Project', status: 'active', areaId: 'area', createdAt: now, updatedAt: now }],
        sections: [], _allSections: [{ id: 'section', projectId: 'project', title: 'Section', order: 1, createdAt: now, updatedAt: now }],
        areas: [], _allAreas: [{ id: 'area', name: 'Area', createdAt: now, updatedAt: now }] } as never);
        const before = JSON.stringify(getInMemoryAppDataSnapshot());
        const result = host.getDataBackup('csv');
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('CSV refused');
        expect(result.value.fileName).toMatch(/^mindwtr-backup-.*\.csv$/);
        expect(result.value.encoding).toBe('utf8');
        expect(result.value.content).toBe(serializeMindwtrCsv(getInMemoryAppDataSnapshot()));
        expect(result.value.content).toContain('"日本語, ""quoted""\nnext line"');
        expect(result.value.content).toContain('Project,Section,Area');
        expect(result.value.content).toContain(',done,');
        expect(result.value.content).not.toContain(',deleted,');
        expect(result.value.content).not.toContain(',purged,');
        expect(JSON.stringify(getInMemoryAppDataSnapshot())).toBe(before);
        expect(saveData).not.toHaveBeenCalled();
        expect(host.getDataBackup('zip' as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('exports RN TaskNotes ZIP bytes and entries from hidden live records without writes', async () => {
        const { host, saveData } = await openHost();
        const task = fixture().tasks[0];
        useTaskStore.setState({ tasks: [], _allTasks: [
            { ...task, id: 'hidden00-task', status: 'waiting', title: '日本語 / 🦉',
                description: 'Body 🦉\nnext line', projectId: 'project', priority: 'medium',
                contexts: ['@phone'], tags: ['#family'], startTime: '2026-10-04', timeEstimate: '30min' },
            { ...task, id: 'done0000-task', status: 'done', title: '2026', completedAt: now },
            { ...task, id: 'archived-task', status: 'archived' },
            { ...task, id: 'reference-task', title: 'Reference excluded' },
            { ...task, id: 'deleted-task', status: 'next', title: 'Deleted excluded', deletedAt: now },
            { ...task, id: 'purged-task', status: 'next', title: 'Purged excluded', purgedAt: now },
        ], projects: [], _allProjects: [
            { id: 'project', title: 'Family 日本語', status: 'active', createdAt: now, updatedAt: now },
        ] } as never);
        vi.useFakeTimers();
        vi.setSystemTime(new Date(now));
        const snapshot = getInMemoryAppDataSnapshot();
        const before = JSON.stringify(useTaskStore.getState());
        const expected = buildTaskNotesExportZip(snapshot);
        const result = host.getDataBackup('tasknotes');
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('TaskNotes refused');
        expect(result.value.fileName).toBe(createBackupFileName(new Date(now)).replace(/\.json$/u, '-tasknotes.zip'));
        expect(result.value.encoding).toBe('base64');
        const decoded = base64ToBytes(result.value.content);
        expect(decoded).toEqual(expected.zip);
        const entries = unzipSync(decoded);
        expect(entries).toEqual(unzipSync(expected.zip));
        expect(Object.keys(entries)).toEqual([
            'TaskNotes/日本語-hidden00.md', 'TaskNotes/2026-done0000.md', 'TaskNotes/日本語-archived.md',
        ]);
        const hidden = strFromU8(entries['TaskNotes/日本語-hidden00.md']);
        expect(hidden).toContain('title: 日本語 / 🦉\nstatus: waiting\npriority: normal\ndue: 2026-10-05\nscheduled: 2026-10-04');
        expect(hidden).toContain('contexts:\n  - phone\nprojects:\n  - "[[Family 日本語]]"\ntags:\n  - task\n  - family\ntimeEstimate: 30');
        expect(hidden).toContain('Body 🦉\nnext line');
        expect(strFromU8(entries['TaskNotes/2026-done0000.md'])).toContain('title: "2026"\nstatus: done');
        expect(strFromU8(entries['TaskNotes/2026-done0000.md'])).toContain(`completedDate: ${now}`);
        expect(strFromU8(entries['TaskNotes/日本語-archived.md'])).toContain('status: cancelled');
        expect(Object.values(entries).map((entry) => strFromU8(entry)).join('\n')).not.toMatch(/Reference excluded|Deleted excluded|Purged excluded/);
        expect(JSON.stringify(useTaskStore.getState())).toBe(before);
        expect(saveData).not.toHaveBeenCalled();
        useTaskStore.setState({ tasks: [], _allTasks: [] });
        expect(base64ToBytes(result.value.content)).toEqual(expected.zip);
    });

    it('projects TaskNotes labels and failure copy from RN translation keys', () => {
        expect(buildDataSettingsModel({}, (key) => key).backup).toMatchObject({
            tasknotesLabel: 'settings.exportTaskNotes',
            tasknotesDescription: 'settings.exportTaskNotesDesc',
            tasknotesFailed: 'settings.exportTaskNotesFailed',
        });
    });

    it('refuses before activation and during workspace handoff without writes', async () => {
        const { saveData } = await openHost();
        const host = createNativeHostContract();
        for (const format of formats) {
            expect(host.getDataBackup(format)).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        }
        expect((await host.activate({ writeSafetyReady: true })).ok).toBe(true);
        await flushPendingSave();
        saveData.mockClear();
        const release = acquireWorkspaceTransitionLock();
        expect(release).not.toBeNull();
        try {
            for (const format of formats) {
                expect(host.getDataBackup(format)).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
            }
            expect(saveData).not.toHaveBeenCalled();
        } finally { release?.(); }
    });

    it('does not retry or clear a persistence failure to export', async () => {
        const { host, saveData } = await openHost();
        const failure = { message: 'save owed', retrying: false };
        useTaskStore.setState({ persistenceFailure: failure } as never);
        for (const format of formats) {
            expect(host.getDataBackup(format)).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        }
        expect(useTaskStore.getState().persistenceFailure).toBe(failure);
        expect(saveData).not.toHaveBeenCalled();
        useTaskStore.setState({ persistenceFailure: null });
    });

    it.each(['queued', 'inFlight', 'immediate', 'retrying'] as const)('refuses all formats while persistence is %s without preparing or saving', async (field) => {
        const { host, saveData } = await openHost();
        const status = { queued: 0, inFlight: false, immediate: 0, retrying: false, generation: 0, failed: false };
        vi.spyOn(store, 'getPersistenceStatus').mockReturnValue({
            ...status, [field]: field === 'queued' || field === 'immediate' ? 1 : true,
        });
        const snapshot = vi.spyOn(snapshots, 'getInMemoryAppDataSnapshot');
        for (const format of formats) {
            expect(host.getDataBackup(format)).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        }
        expect(snapshot).not.toHaveBeenCalled();
        expect(saveData).not.toHaveBeenCalled();
    });

    it('returns fixed safe errors for all formats when preparing a snapshot fails', async () => {
        const { host, saveData } = await openHost();
        vi.spyOn(snapshots, 'getInMemoryAppDataSnapshot').mockImplementation(() => {
            throw new Error('private task content');
        });
        for (const format of formats) {
            expect(host.getDataBackup(format)).toEqual({ ok: false, error: {
                code: 'ACTION_FAILED', message: 'Could not prepare the backup',
            } });
        }
        expect(saveData).not.toHaveBeenCalled();
    });

    it('exports hidden records and attachment metadata while compacting purged content exactly as RN does', async () => {
        const { host, saveData } = await openHost();
        const task = fixture().tasks[0];
        const allTasks = [
            { ...task, attachments: [{ id: 'attachment', kind: 'file' as const, title: 'Photo', uri: 'file:///private/photo.jpg', createdAt: now, updatedAt: now }] },
            { ...task, id: 'purged', title: 'removed private text', deletedAt: now, purgedAt: now },
        ];
        useTaskStore.setState({ tasks: [], _allTasks: allTasks });
        const expected = serializeBackupData(getInMemoryAppDataSnapshot());
        const before = JSON.stringify(useTaskStore.getState());
        const result = host.getDataBackup();
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('Export refused');
        expect(result.value.content).toBe(expected);
        const parsed = JSON.parse(result.value.content);
        expect(parsed.tasks).toHaveLength(2);
        expect(parsed.tasks[0].attachments).toEqual(allTasks[0].attachments);
        expect(result.value.content).not.toContain('removed private text');
        expect(JSON.stringify(useTaskStore.getState())).toBe(before);
        expect(saveData).not.toHaveBeenCalled();
    });

    it('refuses sandbox transfers without preparing personal data', async () => {
        const { host, saveData } = await openHost();
        vi.spyOn(sandbox, 'isSandboxMode').mockReturnValue(true);
        for (const format of formats) {
            expect(host.getDataBackup(format)).toMatchObject({ ok: false, error: { code: 'NOT_READY' } });
        }
        expect(saveData).not.toHaveBeenCalled();
    });
});
