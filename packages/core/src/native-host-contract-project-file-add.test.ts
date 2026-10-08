import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { addPickedAttachment } from './attachment-editor-model';
import * as uploadPolicy from './attachment-validation';
import { DEFAULT_MAX_FILE_SIZE_BYTES } from './attachment-validation';
import { getManagedAttachmentFileName } from './mobile-attachment-files';
import { readNativeAttachmentDraftFrozen } from './native-attachment-draft';
import { createProjectAttachmentWriteMethods, createProjectFileRemoveWriteMethods } from './native-host-contract-project-attachments';
import { createProjectFileAddWriteMethods, type NativeProjectFileAddWriteRequest } from './native-host-contract-project-file-add';
import { readAreaDurableData } from './native-host-contract-area-durable';
import { openSqliteHost } from './screen-parity.replay';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppData, Attachment, Project, Section, Task } from './types';

const now = '2026-10-06T15:00:00.000Z';
const later = '2026-10-06T16:00:00.000Z';
const requestId = '73799899-d143-40c1-84bd-a09172bba5a4';
const directory = 'file:///documents/attachments/';
const file: Attachment = { id: 'sibling', kind: 'file', title: 'Keep.pdf', uri: 'file:///keep.pdf',
    mimeType: 'application/pdf', size: 12, cloudKey: 'cloud-file', createdAt: now, updatedAt: now };
const link: Attachment = { id: 'link', kind: 'link', title: 'Keep link', uri: 'https://example.test/keep',
    createdAt: now, updatedAt: now };
const project = (id = 'target', overrides: Partial<Project> = {}): Project => ({
    id, title: id, status: 'active', color: '#3b82f6', order: 0, tagIds: ['#work'],
    supportNotes: 'Keep notes', dueDate: '2026-10-20', isSequential: true, sequentialScope: 'section',
    attachments: [file, link], rev: 3, revBy: 'old-device', createdAt: now, updatedAt: now, ...overrides,
});
const task: Task = { id: 'task', title: 'Keep task', status: 'next', projectId: 'target', tags: [], contexts: [],
    attachments: [file], createdAt: now, updatedAt: now };
const section: Section = { id: 'section', projectId: 'target', title: 'Keep section', order: 0,
    createdAt: now, updatedAt: now };
const json = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

async function open(initial: Partial<AppData> = {}, failure: { disk?: () => boolean; ack?: () => boolean } = {}) {
    await flushPendingSave(); resetForTests();
    let data: AppData = { tasks: [task], projects: [project(), project('other')], sections: [section],
        areas: [], people: [], settings: { deviceId: 'files-device' }, ...initial };
    let saves = 0;
    let ready = false;
    setStorageAdapter({ getData: async () => structuredClone(data), saveData: async (next) => {
        if (ready && failure.disk?.()) throw new Error('private disk failure');
        data = structuredClone(next); saves++;
    } });
    useTaskStore.setState({ _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
        settings: {}, error: null, persistenceFailure: null, isLoading: false, lastDataChangeAt: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    saves = 0; ready = true;
    const deps = { readiness: () => ({ ok: true as const, value: null }), save: async () => {
        try {
            await flushPendingSave();
            return failure.ack?.() ? { ok: false as const, error: { code: 'SAVE_FAILED' as const, message: 'Could not acknowledge' } }
                : { ok: true as const, value: null };
        } catch { return { ok: false as const, error: { code: 'SAVE_FAILED' as const, message: 'Could not save' } }; }
    }, revision: () => 'stable-revision', t: () => (key: string) => key };
    const links = createProjectAttachmentWriteMethods(deps);
    const removes = createProjectFileRemoveWriteMethods(deps);
    const methods = createProjectFileAddWriteMethods(deps);
    const request = (change: Partial<NativeProjectFileAddWriteRequest> = {}): NativeProjectFileAddWriteRequest => {
        const options = links.getProjectAttachmentEditOptions({ projectId: 'target' });
        if (!options.ok) throw new Error(options.error.code);
        const { id: _id, ...expected } = options.value.project;
        return json({ requestId, projectId: 'target', expected,
            picked: { uri: 'file:///provider/Picked.PDF', name: 'Picked.PDF', mimeType: 'application/pdf', size: null },
            measuredSize: 27, managedDirectoryURI: directory, ...change });
    };
    const prepare = async (input = request()) => {
        const answer = await methods.prepareProjectFileAddWrite(input);
        if (!answer.ok || answer.value.kind !== 'prepared')
            throw new Error(answer.ok ? answer.value.kind : `${answer.error.code}: ${answer.error.message}`);
        return { request: input, prepared: answer.value.prepared };
    };
    const replaceProjects = (projects: Project[]) => {
        data = { ...data, projects: structuredClone(projects) };
        useTaskStore.setState({ _allProjects: projects });
    };
    return { links, removes, methods, request, prepare, replaceProjects, data: () => data, saves: () => saves };
}

afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await flushPendingSave(); resetForTests(); });

describe('prepared Project-owned file Add foundation', () => {
    it('prepares, validates and commits with the actual host URL polyfill that has no href property', async () => {
        const env = await open();
        const source = readFileSync(new URL('../../../apps/android-native/bundle/host-polyfills.js', import.meta.url), 'utf8');
        const context = createContext({ URL: undefined, __mindwtrNative: { log() {} } });
        runInContext(source, context);
        const HostURL = runInContext('URL', context) as typeof URL;
        expect(new HostURL(directory).href).toBeUndefined();
        vi.stubGlobal('URL', HostURL);
        const frozen = await env.prepare();
        expect(env.methods.validatePreparedProjectFileAddWrite(frozen)).toEqual({ ok: true, value: frozen.prepared.result });
        expect(await env.methods.commitPreparedProjectFileAddWrite(frozen)).toEqual({ ok: true, value: frozen.prepared.result });
        for (const uri of ['file:///provider/../file.pdf', 'file:///provider/%2e%2e/file.pdf', 'file:///provider/file.pdf?x=y',
            'file://foreign/file.pdf', 'file:///provider/%00/file.pdf', 'file:///provider/file name.pdf']) {
            expect(await env.methods.prepareProjectFileAddWrite(env.request({
                picked: { uri, name: 'file.pdf', mimeType: 'application/pdf', size: null },
            }))).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(env.saves()).toBe(1);
    });

    it.each(['active', 'waiting', 'someday'] as const)('matches actual RN metadata and appends one file on a %s Project', async (status) => {
        vi.useFakeTimers(); vi.setSystemTime(later);
        const env = await open({ projects: [project('target', { status }), project('other')] });
        const before = json(useTaskStore.getState()._allProjects[0]);
        const settings = structuredClone(useTaskStore.getState().settings);
        const children = { tasks: structuredClone(useTaskStore.getState()._allTasks), sections: structuredClone(useTaskStore.getState()._allSections) };
        const frozen = await env.prepare();
        const direct = await addPickedAttachment({ source: 'file', asset: { ...frozen.request.picked, size: frozen.request.measuredSize },
            newId: () => requestId, t: (key) => key, persist: async (attachment) =>
                ({ ...attachment, uri: directory + getManagedAttachmentFileName(attachment) }) });
        if (direct.kind !== 'added') throw new Error('RN refused');
        expect(frozen.prepared.attachment).toEqual(json(direct.attachment));
        expect(frozen.prepared).toMatchObject({ version: 3, kind: 'project-file-add', updateAt: later,
            scope: { project: before }, deviceIdBefore: 'files-device', deviceIdToInitialize: null,
            prepared: { kind: 'prepared', attachment: { id: requestId, uri: frozen.request.picked.uri, size: 27, createdAt: later } },
            targetURI: `${directory}${requestId}.pdf`, result: { id: 'target', attachmentIds: [requestId] } });
        expect(frozen.prepared.effect.project).toEqual({ before, after: { ...before,
            attachments: [...before.attachments!, json(direct.attachment)], updatedAt: later, rev: 4, revBy: 'files-device' } });
        expect(env.methods.validatePreparedProjectFileAddWrite(frozen)).toEqual({ ok: true, value: frozen.prepared.result });
        expect(await env.methods.commitPreparedProjectFileAddWrite(frozen)).toEqual({ ok: true, value: frozen.prepared.result });
        expect(env.data().projects[0]).toEqual(frozen.prepared.effect.project.after);
        expect(env.data().projects[1]).toEqual(project('other'));
        expect(env.data().tasks).toEqual(children.tasks);
        expect(env.data().sections).toEqual(children.sections);
        expect(env.data().settings).toEqual(settings);
        expect(env.saves()).toBe(1);
    });

    it('uses measured bytes despite unknown or inaccurate picker size, preserving null MIME and fallback naming', async () => {
        const env = await open();
        for (const reported of [null, 0, 4.5, 9_999_999]) {
            const input = env.request({ picked: { uri: 'file:///provider/document.TxT', name: null, mimeType: null, size: reported } });
            const frozen = await env.prepare(input);
            expect(frozen.prepared.prepared.attachment).toMatchObject({ title: 'file', size: 27 });
            expect(frozen.prepared.prepared.attachment).not.toHaveProperty('mimeType');
            expect(frozen.prepared.targetURI).toBe(`${directory}${requestId}.txt`);
            expect(frozen.prepared.attachment.size).toBe(27);
        }
        expect(env.saves()).toBe(0);
    });

    it('runs actual RN MIME/size refusal and unchanged-source URI refusal without writes', async () => {
        const env = await open();
        const tooLarge = await env.methods.prepareProjectFileAddWrite(env.request({ measuredSize: DEFAULT_MAX_FILE_SIZE_BYTES + 1 }));
        expect(tooLarge).toEqual({ ok: true, value: { kind: 'refused', result: { message: 'attachments.fileTooLarge' } } });
        const blocked = await env.methods.prepareProjectFileAddWrite(env.request({ picked: { uri: 'file:///provider/file.exe',
            name: 'file.exe', mimeType: ' Application/X-Executable ', size: null } }));
        expect(blocked).toEqual({ ok: true, value: { kind: 'refused', result: { message: 'attachments.invalidFileType' } } });
        const sameURI = await env.methods.prepareProjectFileAddWrite(env.request({ picked: { uri: `${directory}${requestId}.pdf`,
            name: 'Picked.PDF', mimeType: 'application/pdf', size: null } }));
        expect(sameURI).toEqual({ ok: true, value: { kind: 'refused', result: { message: 'attachments.fileNotReadable' } } });
        expect(env.saves()).toBe(0);
    });

    it('checks stale expected before archived policy, blocks archived, and refuses unavailable Projects', async () => {
        const env = await open();
        const stale = env.request();
        useTaskStore.setState({ _allProjects: [project('target', { status: 'archived', rev: 4 })] });
        expect(await env.methods.prepareProjectFileAddWrite(stale)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        env.replaceProjects([project('target', { status: 'archived', rev: 4 })]);
        expect(await env.methods.prepareProjectFileAddWrite(env.request()))
            .toEqual({ ok: true, value: { kind: 'blocked', result: { blocked: '' } } });
        for (const change of [{ deletedAt: now }, { purgedAt: now }]) {
            useTaskStore.setState({ _allProjects: [project('target', change)] });
            expect(await env.methods.prepareProjectFileAddWrite(stale)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        }
        useTaskStore.setState({ _allProjects: [] });
        expect(await env.methods.prepareProjectFileAddWrite(stale)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(env.saves()).toBe(0);
    });

    it('refuses duplicate IDs including tombstones, full attachment lists and malformed request bounds', async () => {
        const env = await open();
        for (const deletedAt of [undefined, now]) {
            env.replaceProjects([project('target', { attachments: [{ ...file, id: requestId, deletedAt }] })]);
            expect(await env.methods.prepareProjectFileAddWrite(env.request())).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        }
        env.replaceProjects([project('target', { attachments: Array.from({ length: 1_000 }, (_, i) => ({ ...file, id: `file-${i}` })) })]);
        expect(await env.methods.prepareProjectFileAddWrite(env.request())).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        env.replaceProjects([project()]);
        const input = env.request();
        for (const bad of [{ ...input, extra: true }, { ...input, requestId: requestId.toUpperCase() },
            { ...input, measuredSize: -1 }, { ...input, measuredSize: 1.5 }, { ...input, measuredSize: Number.MAX_SAFE_INTEGER + 1 },
            { ...input, picked: { ...input.picked, extra: true } }, { ...input, picked: { ...input.picked, name: 'x'.repeat(100_001) } },
            { ...input, picked: { ...input.picked, mimeType: 'x'.repeat(501) } }, { ...input, picked: { ...input.picked, size: -1 } },
            { ...input, managedDirectoryURI: 'file:///documents/attachments' }, { ...input, managedDirectoryURI: 'file://foreign/path/' },
            { ...input, managedDirectoryURI: 'file:///documents/../attachments/' }, { ...input, managedDirectoryURI: 'file:///docs/%2e%2e/' },
            { ...input, managedDirectoryURI: 'file:///docs/%00/' }, { ...input, managedDirectoryURI: 'file:///docs/?private=secret' },
            { ...input, picked: { ...input.picked, uri: 'file:///provider/../private' } },
            { ...input, expected: { ...input.expected, extra: true } }]) {
            const answer = await env.methods.prepareProjectFileAddWrite(bad as never);
            expect(answer).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(JSON.stringify(answer)).not.toMatch(/private|secret/);
            expect(env.methods.probeProjectFileAddWriteOutcome(bad as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(env.saves()).toBe(0);
    });

    it.each(['notes', 'inPlace', 'archive', 'delete', 'purge', 'device'] as const)(
    'rechecks exact detached before row and device after awaited policy: %s', async (change) => {
        const env = await open();
        let release!: (value: uploadPolicy.ValidationResult) => void;
        const policy = vi.spyOn(uploadPolicy, 'validateAttachmentForUpload').mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
        const input = env.request();
        const pending = env.methods.prepareProjectFileAddWrite(input);
        await vi.waitFor(() => expect(policy).toHaveBeenCalledTimes(1));
        if (change === 'device') useTaskStore.setState((state) => ({ settings: { ...state.settings, deviceId: 'other-device' } }));
        else if (change === 'inPlace') useTaskStore.getState()._projectsById.get('target')!.color = '#000000';
        else useTaskStore.setState({ _allProjects: [project('target', change === 'notes' ? { supportNotes: 'Later notes' }
            : change === 'archive' ? { status: 'archived' } : change === 'delete' ? { deletedAt: later } : { purgedAt: later })] });
        release({ valid: true });
        expect(await pending).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(env.saves()).toBe(0);
    });

    it('detaches caller inputs before policy and rejects stale first-write state after the commit policy await', async () => {
        const env = await open();
        let release!: (value: uploadPolicy.ValidationResult) => void;
        const policy = vi.spyOn(uploadPolicy, 'validateAttachmentForUpload').mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
        const input = env.request();
        const original = structuredClone(input);
        const pending = env.methods.prepareProjectFileAddWrite(input);
        input.picked = { ...input.picked, name: 'Changed by caller' };
        input.managedDirectoryURI = 'file:///foreign/';
        await vi.waitFor(() => expect(policy).toHaveBeenCalledTimes(1));
        release({ valid: true });
        const result = await pending;
        if (!result.ok || result.value.kind !== 'prepared') throw new Error('prepare failed');
        expect(result.value.prepared.request).toEqual(original);
        const frozen = { request: original, prepared: result.value.prepared };
        policy.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
        const commit = env.methods.commitPreparedProjectFileAddWrite(frozen);
        await vi.waitFor(() => expect(policy).toHaveBeenCalledTimes(2));
        useTaskStore.setState({ _allProjects: [project('target', { color: '#000000' })] });
        release({ valid: true });
        expect(await commit).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(env.saves()).toBe(0);
    });

    it('validates frozen metadata without clock/policy and refuses forged source, target, effect and envelopes', async () => {
        vi.useFakeTimers(); vi.setSystemTime(later);
        const env = await open();
        const frozen = await env.prepare();
        const policy = vi.spyOn(uploadPolicy, 'validateAttachmentForUpload').mockRejectedValue(new Error('Policy must not run during pure validation'));
        vi.setSystemTime('2030-01-01T00:00:00.000Z');
        expect(env.methods.validatePreparedProjectFileAddWrite(frozen)).toEqual({ ok: true, value: frozen.prepared.result });
        for (const mutate of [
            (value: typeof frozen) => { value.prepared.version = 2 as never; },
            (value: typeof frozen) => { value.prepared.kind = 'owned-file-add-save' as never; },
            (value: typeof frozen) => { value.prepared.prepared.attachment = { ...value.prepared.prepared.attachment, title: 'Forged' }; },
            (value: typeof frozen) => { value.prepared.prepared.attachment = { ...value.prepared.prepared.attachment, cloudKey: 'Forged' }; },
            (value: typeof frozen) => { value.prepared.attachment.uri = 'file:///foreign/file.pdf'; },
            (value: typeof frozen) => { value.prepared.targetURI = 'file:///foreign/file.pdf'; },
            (value: typeof frozen) => { value.prepared.attachment.size = 28; },
            (value: typeof frozen) => { value.prepared.effect.project.after.supportNotes = 'Forged'; },
            (value: typeof frozen) => { value.prepared.effect.project.after.attachments![0].cloudKey = 'Forged sibling'; },
            (value: typeof frozen) => { value.prepared.scope.project.color = '#000000'; },
            (value: typeof frozen) => { value.prepared.updateAt = now; },
            (value: typeof frozen) => { value.prepared.result.attachmentIds = ['wrong']; },
            (value: typeof frozen) => { value.prepared.deviceIdToInitialize = requestId; },
            (value: typeof frozen) => { (value.prepared as unknown as Record<string, unknown>).extra = true; },
        ]) {
            const forged = structuredClone(frozen); mutate(forged);
            expect(env.methods.validatePreparedProjectFileAddWrite(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await env.methods.commitPreparedProjectFileAddWrite(forged)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        expect(env.methods.validatePreparedProjectFileAddWrite({ ...frozen, extra: true } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(env.methods.validatePreparedProjectFileAddWrite({ ...frozen,
            prepared: { ...frozen.prepared, extra: 'x'.repeat(2_000_001) } } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(policy).not.toHaveBeenCalled();
        expect(env.saves()).toBe(0);
    });

    it('keeps historical URL v1, file Remove v2 and Task draft grammars sealed', async () => {
        const env = await open();
        const frozen = await env.prepare();
        expect(env.links.prepareProjectAttachmentWrite(frozen.request as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(env.removes.prepareProjectFileRemoveWrite(frozen.request as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(env.links.validatePreparedProjectAttachmentWrite(frozen as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(env.removes.validatePreparedProjectFileRemoveWrite(frozen as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(() => readNativeAttachmentDraftFrozen(frozen.prepared)).toThrow('INVALID_INPUT');
        const oldRequest = { requestId, projectId: 'target', expected: frozen.request.expected, intent: { kind: 'remove' as const, attachmentId: 'sibling' } };
        const oldPlan = env.removes.prepareProjectFileRemoveWrite(oldRequest);
        if (!oldPlan.ok || oldPlan.value.kind !== 'prepared') throw new Error('Remove failed');
        expect(env.methods.validatePreparedProjectFileAddWrite({ request: oldRequest, prepared: oldPlan.value.prepared } as never))
            .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(env.saves()).toBe(0);
    });

    it('retains nullable raw Project fields without normalizing the before row', async () => {
        const env = await open();
        const raw = { ...project(), areaId: null, areaTitle: null, supportNotes: null, attachments: null,
            startDate: null, dueDate: null, reviewAt: null, rev: null, revBy: null,
            deletedAt: null, purgedAt: null } as unknown as Project;
        env.replaceProjects([raw]);
        const frozen = await env.prepare();
        expect(frozen.prepared.scope.project).toEqual(raw);
        expect(frozen.prepared.effect.project.before).toEqual(raw);
        expect(frozen.prepared.effect.project.after).toMatchObject({ areaId: null, areaTitle: null,
            supportNotes: null, startDate: null, dueDate: null, reviewAt: null,
            rev: 1, revBy: 'files-device', attachments: [frozen.prepared.attachment] });
        expect(await env.methods.commitPreparedProjectFileAddWrite(frozen)).toMatchObject({ ok: true });
        const second = await open(structuredClone(env.data()));
        expect(await second.methods.commitPreparedProjectFileAddWrite(frozen)).toMatchObject({ ok: true });
        expect(second.saves()).toBe(0);
    });

    it('recognizes a complete AFTER reached during another caller policy await before using the current policy answer', async () => {
        const env = await open();
        const frozen = await env.prepare();
        let release!: (value: uploadPolicy.ValidationResult) => void;
        const policy = vi.spyOn(uploadPolicy, 'validateAttachmentForUpload').mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
        const pending = env.methods.commitPreparedProjectFileAddWrite(frozen);
        await vi.waitFor(() => expect(policy).toHaveBeenCalledTimes(1));
        expect(await env.methods.commitPreparedProjectFileAddWrite(frozen)).toEqual({ ok: true, value: frozen.prepared.result });
        const saves = env.saves();
        release({ valid: false, error: 'mime_type_blocked' });
        expect(await pending).toEqual({ ok: true, value: frozen.prepared.result });
        expect(env.saves()).toBe(saves);
    });

    it('overlays only the target Project onto fresh durable rows after unrelated edits during policy validation', async () => {
        const env = await open();
        const frozen = await env.prepare();
        let release!: (value: uploadPolicy.ValidationResult) => void;
        const policy = vi.spyOn(uploadPolicy, 'validateAttachmentForUpload').mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
        const pending = env.methods.commitPreparedProjectFileAddWrite(frozen);
        await vi.waitFor(() => expect(policy).toHaveBeenCalledTimes(1));
        expect((await useTaskStore.getState().updateProject('other', { supportNotes: 'Unrelated edit' })).success).toBe(true);
        await useTaskStore.getState().updateTask('task', { title: 'Unrelated task edit' });
        await flushPendingSave();
        const other = structuredClone(env.data().projects.find((row) => row.id === 'other'));
        const children = structuredClone(env.data().tasks);
        release({ valid: true });
        expect(await pending).toEqual({ ok: true, value: frozen.prepared.result });
        expect(env.data().projects.find((row) => row.id === 'other')).toEqual(other);
        expect(useTaskStore.getState()._projectsById.get('other')).toEqual(other);
        expect(env.data().tasks).toEqual(children);
        expect(useTaskStore.getState()._allTasks).toEqual(children);
        expect(env.data().projects.find((row) => row.id === 'target')).toEqual(frozen.prepared.effect.project.after);
    });

    it('refuses a new first write when current policy rejects, and returns fixed errors if policy fails', async () => {
        const env = await open();
        const frozen = await env.prepare();
        const policy = vi.spyOn(uploadPolicy, 'validateAttachmentForUpload').mockResolvedValueOnce({ valid: false, error: 'file_too_large' });
        expect(await env.methods.commitPreparedProjectFileAddWrite(frozen)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        policy.mockRejectedValueOnce(new Error('private policy failure'));
        const preparation = await env.methods.prepareProjectFileAddWrite(env.request());
        expect(preparation).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(JSON.stringify(preparation)).not.toMatch(/private|failure/);
        policy.mockRejectedValueOnce(new Error('private policy failure'));
        const commit = await env.methods.commitPreparedProjectFileAddWrite(frozen);
        expect(commit).toMatchObject({ ok: false, error: { code: 'ACTION_FAILED' } });
        expect(JSON.stringify(commit)).not.toMatch(/private|failure/);
        expect(env.saves()).toBe(0);
    });

    it('retries failed persistence with exact time/device, then acknowledges AFTER before current policy changes', async () => {
        let failed = true;
        const first = await open({}, { disk: () => failed });
        useTaskStore.setState((state) => {
            const { deviceId: _deviceId, ...settings } = state.settings;
            first.data().settings = structuredClone(settings);
            return { settings };
        });
        const frozen = await first.prepare();
        expect(frozen.prepared.deviceIdToInitialize).toMatch(/^[0-9a-f-]{36}$/);
        expect(await first.methods.commitPreparedProjectFileAddWrite(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(first.data().projects[0].rev).toBe(3);
        failed = false;
        const policy = vi.spyOn(uploadPolicy, 'validateAttachmentForUpload');
        expect(await first.methods.commitPreparedProjectFileAddWrite(frozen)).toEqual({ ok: true, value: frozen.prepared.result });
        expect(policy).toHaveBeenCalledTimes(1);
        expect(first.data().projects[0]).toEqual(frozen.prepared.effect.project.after);
        policy.mockRejectedValue(new Error('Durable replay must not recheck policy'));
        const second = await open(structuredClone(first.data()));
        expect(await second.methods.commitPreparedProjectFileAddWrite(frozen)).toEqual({ ok: true, value: frozen.prepared.result });
        expect(second.saves()).toBe(0);
        useTaskStore.setState((state) => ({ settings: { ...state.settings, deviceId: 'different-device' } }));
        expect(await second.methods.commitPreparedProjectFileAddWrite(frozen)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('replays a committed row after acknowledgement failure and refuses A to B to C replay', async () => {
        const first = await open({}, { ack: () => true });
        const frozen = await first.prepare();
        expect(await first.methods.commitPreparedProjectFileAddWrite(frozen)).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
        expect(first.data().projects[0]).toEqual(frozen.prepared.effect.project.after);
        const second = await open(structuredClone(first.data()));
        expect(await second.methods.commitPreparedProjectFileAddWrite(frozen)).toEqual({ ok: true, value: frozen.prepared.result });
        expect(second.saves()).toBe(0);
        useTaskStore.setState({ _allProjects: [{ ...second.data().projects[0], supportNotes: 'Intervening edit' }] });
        expect(await second.methods.commitPreparedProjectFileAddWrite(frozen)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        expect(second.saves()).toBe(0);
    });

    it.each([
        ['compact', false], ['reversed', false], ['whitespace', false],
        ['compact', true], ['reversed', true], ['whitespace', true],
    ] as const)(
    'recovers a %s raw Project file Add (hash=%s) through SQLite restart and refuses a real stale value', async (encoding, hashed) => {
        const env = await openSqliteHost({ projects: [project(), project('other')], tasks: [task], sections: [section], settings: { deviceId: 'files-device' } });
        try {
            const raw = encoding === 'reversed'
                ? JSON.stringify([file, link].map(item => Object.fromEntries(Object.entries(item).reverse())))
                : encoding === 'whitespace' ? '\n ' + JSON.stringify([file, link], null, 2) + ' ' : JSON.stringify([file, link]);
            const rawSettings = '\n' + JSON.stringify({ ...useTaskStore.getState().settings,
                futureUnknown: { zeta: '保留 / 🌿', alpha: [false, null, '文'] } }, null, 2) + ' ';
            await env.client().run('UPDATE projects SET attachments=?', [raw]);
            await env.client().run('UPDATE settings SET data=? WHERE id=1', [rawSettings]);
            await env.restart(undefined, { recoveryLoad: true });
            const unrelated = () => Promise.all([env.sql('SELECT * FROM projects WHERE id<>?', ['target']),
                env.sql('SELECT * FROM tasks'), env.sql('SELECT * FROM sections'), env.sql('SELECT * FROM settings')]);
            const untouched = await unrelated();
            const options = env.host.getProjectAttachmentEditOptions({ projectId: 'target' });
            if (!options.ok) throw new Error(options.error.code);
            const { id: _id, ...expected } = options.value.project;
            const request: NativeProjectFileAddWriteRequest = json({ requestId, projectId: 'target', expected,
                picked: { uri: 'file:///provider/Picked.PDF', name: 'Picked.PDF', mimeType: 'application/pdf', size: null },
                measuredSize: 27, managedDirectoryURI: directory, ...(hashed ? { version: 2, sourceSha256: 'b'.repeat(64) } : {}) });
            const plan = await env.host.prepareProjectFileAddWrite(request);
            if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(plan.ok ? plan.value.kind : `${plan.error.code}: ${plan.error.message}`);
            const original = { request, prepared: plan.value.prepared };
            const frozen = JSON.parse(JSON.stringify(original, (_name, item: unknown) => item && typeof item === 'object'
                && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)) as typeof original;
            expect(Object.keys(frozen.prepared.effect.project.before.attachments![0]))
                .not.toEqual(Object.keys(original.prepared.effect.project.before.attachments![0]));
            expect((await env.sql<{ attachments: string }>('SELECT attachments FROM projects WHERE id=?', ['target']))[0].attachments).toBe(raw);
            await env.restart(undefined, { recoveryLoad: true });
            expect(await env.host.commitPreparedProjectFileAddWrite(frozen)).toEqual({ ok: true, value: frozen.prepared.result });
            const saved = await env.sql<{ rev: number; attachments: string }>('SELECT rev, attachments FROM projects WHERE id = ?', ['target']);
            expect(saved[0].rev).toBe(frozen.prepared.effect.project.after.rev);
            expect(JSON.parse(saved[0].attachments)).toEqual(frozen.prepared.effect.project.after.attachments);
            expect(await unrelated()).toEqual(untouched);
            expect((await env.sql<{ data: string }>('SELECT data FROM settings WHERE id=1'))[0].data).toBe(rawSettings);
            expect(await env.replay((host) => host.commitPreparedProjectFileAddWrite(frozen)))
                .toEqual({ result: { ok: true, value: frozen.prepared.result }, wrote: false, receipts: false });
            expect((await useTaskStore.getState().updateProject('target', { supportNotes: 'Later notes' })).success).toBe(true);
            await flushPendingSave();
            const staleRows = await env.sql('SELECT * FROM projects ORDER BY id'), staleOthers = await unrelated();
            const changed = await env.replay((host) => host.commitPreparedProjectFileAddWrite(frozen));
            expect(changed.result).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(changed.wrote).toBe(false);
            expect(changed.receipts).toBe(false);
            expect(await env.sql('SELECT * FROM projects ORDER BY id')).toEqual(staleRows); expect(await unrelated()).toEqual(staleOthers);
        } finally { await env.close(); }
    });

    it.each(['[]', null])('preserves raw SQLite BEFORE attachments %j and refuses an intervening []/NULL change', async (rawAttachments) => {
        const env = await openSqliteHost({ projects: [project()], settings: { deviceId: 'files-device' } });
        try {
            await env.client().run('UPDATE projects SET attachments = ? WHERE id = ?', [rawAttachments, 'target']);
            await env.restart();
            const options = env.host.getProjectAttachmentEditOptions({ projectId: 'target' });
            if (!options.ok) throw new Error(options.error.code);
            const { id: _id, ...expected } = options.value.project;
            const request: NativeProjectFileAddWriteRequest = json({ requestId, projectId: 'target', expected,
                picked: { uri: 'file:///provider/Picked.PDF', name: 'Picked.PDF', mimeType: 'application/pdf', size: null },
                measuredSize: 27, managedDirectoryURI: directory });
            expect(request.expected.attachments).toBeNull();
            const plan = await env.host.prepareProjectFileAddWrite(request);
            if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(plan.ok ? plan.value.kind : `${plan.error.code}: ${plan.error.message}`);
            const frozen = { request, prepared: plan.value.prepared };
            if (rawAttachments === '[]') {
                expect(frozen.prepared.scope.project.attachments).toEqual([]);
                const rawToken = structuredClone(frozen);
                rawToken.request.expected.attachments = [];
                rawToken.prepared.request.expected.attachments = [];
                expect(env.host.validatePreparedProjectFileAddWrite(rawToken)).toMatchObject({ ok: true });
                // Initial prepare still requires the actual host's current token exactly.
                expect(await env.host.prepareProjectFileAddWrite(rawToken.request)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            } else expect(frozen.prepared.scope.project).not.toHaveProperty('attachments');
            expect(env.host.validatePreparedProjectFileAddWrite(frozen)).toMatchObject({ ok: true });
            await env.client().run('UPDATE projects SET attachments = ? WHERE id = ?', [rawAttachments === '[]' ? null : '[]', 'target']);
            await env.restart();
            expect(await env.host.commitPreparedProjectFileAddWrite(frozen)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect((await env.sql<{ attachments: string | null }>('SELECT attachments FROM projects WHERE id = ?', ['target']))[0].attachments)
                .toBe(rawAttachments === '[]' ? null : '[]');
            await env.client().run('UPDATE projects SET attachments = ? WHERE id = ?', [rawAttachments, 'target']);
            await env.restart();
            expect(await env.host.commitPreparedProjectFileAddWrite(frozen)).toEqual({ ok: true, value: frozen.prepared.result });
            expect(await env.replay((host) => host.commitPreparedProjectFileAddWrite(frozen)))
                .toEqual({ result: { ok: true, value: frozen.prepared.result }, wrote: false, receipts: false });
        } finally { await env.close(); }
    });

    it.each(['isSequential', 'isFocused', 'orderNum'])('refuses settled raw SQLite NULL in scalar %s before freezing a preparation', async (column) => {
        const env = await openSqliteHost({ projects: [project('target', { isSequential: false, isFocused: false }), project('other')],
            tasks: [task], settings: { deviceId: 'files-device' } });
        try {
            await flushPendingSave();
            await env.client().run(`UPDATE projects SET ${column} = NULL WHERE id = ?`, ['target']);
            await env.restart();
            const rows = await env.sql('SELECT * FROM projects ORDER BY id');
            const options = env.host.getProjectAttachmentEditOptions({ projectId: 'target' });
            if (!options.ok) throw new Error(options.error.code);
            const { id: _id, ...expected } = options.value.project;
            const request: NativeProjectFileAddWriteRequest = json({ requestId, projectId: 'target', expected,
                picked: { uri: 'file:///provider/Picked.PDF', name: 'Picked.PDF', mimeType: 'application/pdf', size: null },
                measuredSize: 27, managedDirectoryURI: directory });
            expect(await env.host.prepareProjectFileAddWrite(request)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(await env.sql('SELECT * FROM projects ORDER BY id')).toEqual(rows);
        } finally { await env.close(); }
    });

    it.each(['isSequential', 'isFocused', 'orderNum'])('refuses raw scalar %s changing 0 to NULL in BEFORE and exact AFTER without writing', async (column) => {
        const env = await openSqliteHost({ projects: [project('target', { isSequential: false, isFocused: false }), project('other')],
            tasks: [task], settings: { deviceId: 'files-device' } });
        try {
            await flushPendingSave();
            const options = env.host.getProjectAttachmentEditOptions({ projectId: 'target' });
            if (!options.ok) throw new Error(options.error.code);
            const { id: _id, ...expected } = options.value.project;
            const request: NativeProjectFileAddWriteRequest = json({ requestId, projectId: 'target', expected,
                picked: { uri: 'file:///provider/Picked.PDF', name: 'Picked.PDF', mimeType: 'application/pdf', size: null },
                measuredSize: 27, managedDirectoryURI: directory });
            const plan = await env.host.prepareProjectFileAddWrite(request);
            if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(plan.ok ? plan.value.kind : plan.error.code);
            const frozen = { request, prepared: plan.value.prepared };
            await env.client().run(`UPDATE projects SET ${column} = NULL WHERE id = ?`, ['target']);
            await env.restart();
            let rows = await env.sql('SELECT * FROM projects ORDER BY id');
            expect(await env.host.commitPreparedProjectFileAddWrite(frozen)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            let durable = await readAreaDurableData(false, true);
            if (!durable.ok) throw new Error(durable.error.code);
            expect(await useTaskStore.getState().commitPreparedProjectFileAddWrite(frozen.prepared, durable.value.authority))
                .toMatchObject({ success: false, reason: 'conflict' });
            expect(await env.sql('SELECT * FROM projects ORDER BY id')).toEqual(rows);

            await env.client().run(`UPDATE projects SET ${column} = 0 WHERE id = ?`, ['target']);
            await env.restart();
            expect(await env.host.commitPreparedProjectFileAddWrite(frozen)).toEqual({ ok: true, value: frozen.prepared.result });
            await env.client().run(`UPDATE projects SET ${column} = NULL WHERE id = ?`, ['target']);
            await env.restart();
            rows = await env.sql('SELECT * FROM projects ORDER BY id');
            const policy = vi.spyOn(uploadPolicy, 'validateAttachmentForUpload').mockRejectedValue(new Error('AFTER drift must refuse before policy'));
            expect(await env.host.commitPreparedProjectFileAddWrite(frozen)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            durable = await readAreaDurableData(false, true);
            if (!durable.ok) throw new Error(durable.error.code);
            expect(await useTaskStore.getState().commitPreparedProjectFileAddWrite(frozen.prepared, durable.value.authority))
                .toMatchObject({ success: false, reason: 'conflict' });
            expect(await env.sql('SELECT * FROM projects ORDER BY id')).toEqual(rows);
            expect(policy).not.toHaveBeenCalled();
        } finally { await env.close(); }
    });

    it('preserves raw sibling JSON metadata that the Node display codec omits, including through restart replay', async () => {
        const originalFile = { ...file, pendingContentUpload: false };
        const env = await openSqliteHost({ projects: [project('target', { attachments: [originalFile, link] }),
            project('other', { attachments: [originalFile], viewSectionIds: [] })], settings: { deviceId: 'files-device' } });
        try {
            // A settled database with valid raw metadata; Add must preserve the row even when its display codec omits false.
            await flushPendingSave();
            await env.client().run('UPDATE projects SET attachments = ?, viewSectionIds = ? WHERE id = ?',
                [JSON.stringify([originalFile]), '[]', 'other']);
            await env.client().run('UPDATE projects SET attachments = ? WHERE id = ?', [JSON.stringify([originalFile, link]), 'target']);
            await env.restart();
            const options = env.host.getProjectAttachmentEditOptions({ projectId: 'target' });
            if (!options.ok) throw new Error(options.error.code);
            const { id: _id, ...expected } = options.value.project;
            const request: NativeProjectFileAddWriteRequest = json({ requestId, projectId: 'target', expected,
                picked: { uri: 'file:///provider/Picked.PDF', name: 'Picked.PDF', mimeType: 'application/pdf', size: null },
                measuredSize: 27, managedDirectoryURI: directory });
            expect(request.expected.attachments![0]).not.toHaveProperty('pendingContentUpload');
            const plan = await env.host.prepareProjectFileAddWrite(request);
            if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(plan.ok ? plan.value.kind : `${plan.error.code}: ${plan.error.message}`);
            const frozen = { request, prepared: plan.value.prepared };
            expect(frozen.prepared.scope.project.attachments![0]).toEqual(originalFile);
            expect(frozen.prepared.effect.project.after.attachments![0]).toEqual(originalFile);
            expect(await env.host.commitPreparedProjectFileAddWrite(frozen)).toMatchObject({ ok: true });
            const untouched = (await env.sql<{ attachments: string; viewSectionIds: string }>(
                'SELECT attachments, viewSectionIds FROM projects WHERE id = ?', ['other']))[0];
            expect(JSON.parse(untouched.attachments)).toEqual([originalFile]);
            expect(untouched.viewSectionIds).toBe('[]');
            expect(await env.replay((host) => host.commitPreparedProjectFileAddWrite(frozen)))
                .toEqual({ result: { ok: true, value: frozen.prepared.result }, wrote: false, receipts: false });
        } finally { await env.close(); }
    });

    it('selects hash-bearing v4 only for the strict version-2 request and preserves historical v3', async () => {
        const env = await open();
        const digest = 'a'.repeat(64);
        const frozen = await env.prepare(env.request({ version: 2, sourceSha256: digest }));
        expect(frozen.prepared.version).toBe(4);
        expect(frozen.prepared.request).toEqual(frozen.request);
        expect(frozen.prepared.prepared.attachment.fileHash).toBe(digest);
        expect(frozen.prepared.attachment.fileHash).toBe(digest);
        expect(frozen.prepared.effect.project.after.attachments!.at(-1)!.fileHash).toBe(digest);
        expect(env.methods.validatePreparedProjectFileAddWrite(frozen)).toEqual({ ok: true, value: frozen.prepared.result });
        const historical = await env.prepare();
        expect(historical.prepared.version).toBe(3);
        expect(historical.request).not.toHaveProperty('version');
        expect(historical.prepared.attachment).not.toHaveProperty('fileHash');
        expect(env.methods.validatePreparedProjectFileAddWrite(historical)).toEqual({ ok: true, value: historical.prepared.result });
        expect(env.saves()).toBe(0);
        for (const fields of [
            { version: 1, sourceSha256: digest }, { version: 2 }, { sourceSha256: digest },
            ...[null, '', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), 1].map((sourceSha256) => ({ version: 2, sourceSha256 })),
        ]) {
            expect(await env.methods.prepareProjectFileAddWrite({ ...env.request(), ...fields } as NativeProjectFileAddWriteRequest))
                .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
    });

    it('rejects new-version pair and frozen metadata/effect hash tampering without applying rows', async () => {
        const env = await open();
        const frozen = await env.prepare(env.request({ version: 2, sourceSha256: 'a'.repeat(64) }));
        const before = structuredClone(env.data());
        const changes = [
            (value: typeof frozen) => { value.prepared.version = 3; },
            (value: typeof frozen) => { delete (value.request as { version?: number }).version; },
            (value: typeof frozen) => { value.prepared.attachment.fileHash = 'b'.repeat(64); },
            (value: typeof frozen) => { value.prepared.prepared = { ...value.prepared.prepared,
                attachment: { ...value.prepared.prepared.attachment, fileHash: 'b'.repeat(64) } }; },
            (value: typeof frozen) => { value.prepared.effect.project.after.attachments!.at(-1)!.fileHash = 'b'.repeat(64); },
            (value: typeof frozen) => { (value.request as { sourceSha256: string }).sourceSha256 = 'b'.repeat(64);
                (value.prepared.request as { sourceSha256: string }).sourceSha256 = 'b'.repeat(64); },
        ];
        for (const mutate of changes) {
            const bad = structuredClone(frozen); mutate(bad);
            expect(env.methods.validatePreparedProjectFileAddWrite(bad)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
            expect(await env.methods.commitPreparedProjectFileAddWrite(bad)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
        const bad = structuredClone(frozen.prepared); bad.attachment.fileHash = 'b'.repeat(64);
        const durable = await readAreaDurableData(false, true);
        if (!durable.ok) throw new Error(durable.error.code);
        expect(await useTaskStore.getState().commitPreparedProjectFileAddWrite(bad, durable.value.authority)).toMatchObject({ success: false });
        expect(env.data()).toEqual(before); expect(env.saves()).toBe(0);
    });

    it('persists a new hash through actual SQLite cold replay and refuses saved hash drift without writing', async () => {
        const env = await openSqliteHost({ projects: [project(), project('other')], tasks: [task], sections: [section], settings: { deviceId: 'files-device' } });
        try {
            const options = env.host.getProjectAttachmentEditOptions({ projectId: 'target' });
            if (!options.ok) throw new Error(options.error.code);
            const { id: _id, ...expected } = options.value.project;
            const digest = 'a'.repeat(64);
            const request: NativeProjectFileAddWriteRequest = json({ version: 2, sourceSha256: digest,
                requestId, projectId: 'target', expected, picked: { uri: 'file:///provider/Picked.PDF', name: 'Picked.PDF', mimeType: 'application/pdf', size: null },
                measuredSize: 27, managedDirectoryURI: directory });
            const plan = await env.host.prepareProjectFileAddWrite(request);
            if (!plan.ok || plan.value.kind !== 'prepared') throw new Error(plan.ok ? plan.value.kind : plan.error.code);
            const frozen = { request, prepared: plan.value.prepared }, exact = JSON.stringify(frozen);
            const others = await env.sql('SELECT * FROM projects WHERE id != ?', ['target']);
            const children = await env.sql('SELECT * FROM tasks');
            expect(await env.host.commitPreparedProjectFileAddWrite(frozen)).toEqual({ ok: true, value: frozen.prepared.result });
            const saved = await env.sql<{ rev: number; attachments: string }>('SELECT rev, attachments FROM projects WHERE id = ?', ['target']);
            expect(saved[0].rev).toBe(4);
            const attachments = JSON.parse(saved[0].attachments) as Attachment[];
            expect(attachments.at(-1)!.fileHash).toBe(digest);
            const policy = vi.spyOn(uploadPolicy, 'validateAttachmentForUpload').mockRejectedValue(new Error('Exact AFTER must not prepare again'));
            expect(await env.replay((host) => host.commitPreparedProjectFileAddWrite(frozen)))
                .toEqual({ result: { ok: true, value: frozen.prepared.result }, wrote: false, receipts: false });
            expect(policy).not.toHaveBeenCalled();
            expect(await env.sql('SELECT * FROM projects WHERE id != ?', ['target'])).toEqual(others);
            expect(await env.sql('SELECT * FROM tasks')).toEqual(children);
            attachments.at(-1)!.fileHash = 'b'.repeat(64);
            await env.client().run('UPDATE projects SET attachments = ? WHERE id = ?', [JSON.stringify(attachments), 'target']);
            const changed = await env.replay((host) => host.commitPreparedProjectFileAddWrite(frozen));
            expect(changed.result).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
            expect(changed.wrote).toBe(false); expect(changed.receipts).toBe(false);
            expect(JSON.stringify(frozen)).toBe(exact);
        } finally { await env.close(); }
    });

});
