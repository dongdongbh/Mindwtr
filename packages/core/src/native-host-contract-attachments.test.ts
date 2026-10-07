import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getAttachmentLinkEditText } from './attachment-editor-model';
import { globalProgressTracker } from './attachment-progress';
import { setLogger } from './logger';
import { getAttachmentDownloadIdentity, type AttachmentAvailabilityOutcome } from './mobile-attachment-availability';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import type { NativeAttachmentOwner, NativeAttachmentsHost } from './native-host-contract-attachments';
import { requestRowId, taskRevisionOf } from './native-request-receipts';
import { loadScreenFixture, normalize, openScreenHost, openSqliteHost, value } from './screen-parity.replay';
import { flushPendingSave, useTaskStore } from './store';
import type { Attachment, Project, Task } from './types';

type Ports = {
    sandbox?: boolean;
    pickDocument?: { canceled: boolean; assets: Record<string, unknown>[] };
    pickImage?: { canceled: boolean; assets: Record<string, unknown>[] };
    persist?: 'copy' | 'unreadable';
    ensure?: AttachmentAvailabilityOutcome;
    viewer?: boolean;
    shareAvailable?: boolean;
    openUrlFails?: boolean;
};
type Scenario = {
    name: string;
    surface: 'task' | 'project';
    attachments: Attachment[];
    stored?: Attachment[];
    projectStatus?: Project['status'];
    steps: { action: string; ports?: Ports }[];
};
type Observation = { action: string; events: unknown[][]; attachments: Attachment[]; screen: Record<string, unknown> };
type Fixture = { now: string; taskId: string; projectId: string; scenarios: Scenario[]; observations: Record<string, Observation[]> };

// The fixture writes an undefined field as '<undefined>' (normalize); its inputs drop those fields again.
const revive = <T,>(value: T): T => JSON.parse(JSON.stringify(value), (_key, entry) => (entry === '<undefined>' ? undefined : entry));
const fixture = loadScreenFixture<Fixture>('attachments');
const scenarios = revive(fixture.scenarios);
const CREATED = '2026-09-01T00:00:00.000Z';
const NOW = fixture.now;

/** core's attachment modules as the parity harness replaced them, recording each call. */
const fakeHost = (state: { ports: Ports; log: unknown[][] }): NativeAttachmentsHost => ({
    persistAttachmentLocally: async (attachment) => {
        state.log.push(['persistAttachmentLocally', attachment]);
        if (state.ports.persist === 'unreadable') return attachment;
        const extension = /\.[a-z0-9]+$/i.exec(attachment.title)?.[0] ?? '';
        return { ...attachment, uri: `file:///data/files/attachments/${attachment.id}${extension}`, localStatus: 'available' };
    },
    ensureAttachmentAvailableDetailed: async (attachment) => {
        state.log.push(['ensureAttachmentAvailableDetailed', attachment]);
        return state.ports.ensure ?? { status: 'available', attachment };
    },
    deleteManagedAttachmentFile: async (attachment) => { state.log.push(['deleteManagedAttachmentFile', attachment]); },
});

const ok = <T,>(result: NativeHostResult<T>): T => value(result);
const rnId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

/** The RN events a host call can be compared on: the native host does the rest (pickers, logs, React state). */
const COMPARED = new Set(['alert', 'persistAttachmentLocally', 'ensureAttachmentAvailableDetailed', 'openURL',
    'tryOpenWithAndroidViewer', 'sharingAvailable', 'shareAsync']);

/**
 * React Native names new links by generateUUID, the contract by the request (requestRowId):
 * new IDs are compared by order of appearance.
 */
const canonicalIds = (value: unknown, known: Set<string>): unknown => {
    const names = new Map<string, string>();
    const json = JSON.stringify(value);
    for (const match of json.matchAll(/"id":"([^"]+)"/g)) {
        if (!known.has(match[1]) && !names.has(match[1])) names.set(match[1], `new-${names.size + 1}`);
    }
    return JSON.parse(json.replace(/"id":"([^"]+)"/g, (whole, id: string) => (names.has(id) ? `"id":"${names.get(id)}"` : whole)));
};

describe('native host contract: attachments, against React Native\'s frozen parity fixture', () => {
    const originalTz = process.env.TZ;
    beforeAll(() => {
        process.env.TZ = 'UTC';
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW));
    });
    afterAll(() => {
        vi.useRealTimers();
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });

    // Native has no sandbox mode, and its picker hands back one size (an image's is fileSize).
    const SKIPPED: Record<string, string> = {
        'task: sandbox refuses every attachment action': 'the native app has no sandbox mode',
        'task: an image without a name takes its file name, and only fileSize is kept': 'expo-image-picker reported `size` without `fileSize`; a native picker reports one size, as fileSize',
    };

    for (const scenario of scenarios) {
        it.skipIf(Boolean(SKIPPED[scenario.name]))(scenario.name, async () => {
            const state = { ports: {} as Ports, log: [] as unknown[][] };
            const stored = scenario.stored ?? scenario.attachments;
            const task: Task = { id: fixture.taskId, title: 'Task', status: 'next', tags: [], contexts: [], attachments: stored, createdAt: CREATED, updatedAt: CREATED };
            const project: Project = { id: fixture.projectId, title: 'Project', status: scenario.projectStatus ?? 'active', color: '#3b82f6',
                order: 0, tagIds: [], attachments: stored, createdAt: CREATED, updatedAt: CREATED };
            const host = await openScreenHost({ data: { tasks: [task], projects: [project] }, record: {}, log: [], bindings: { attachments: fakeHost(state) } });
            const t = (key: string) => key === 'attachments.title' ? 'Attachments' : key;
            let draft = scenario.attachments;
            let ids = 0;
            const sheet = { visible: false, text: '', touched: false, editing: null as { attachmentId: string; title: string; uri: string } | null };
            let imagePreview: string | null = null;
            let audio: string | null = null;
            const owner = (): NativeAttachmentOwner => (scenario.surface === 'task'
                ? { kind: 'task', taskId: fixture.taskId, attachments: draft }
                : { kind: 'project', projectId: fixture.projectId });
            const listed = () => (scenario.surface === 'task' ? draft : useTaskStore.getState()._allProjects[0]?.attachments ?? []);
            const known = new Set(scenario.attachments.map((attachment) => attachment.id));
            for (const [index, step] of scenario.steps.entries()) {
                state.ports = step.ports ?? {};
                state.log = [];
                const alert = (message: string) => state.log.push(['alert', t('attachments.title'), message]);
                const [verb, ...rest] = step.action.split(':');
                const arg = rest.join(':');
                const change = (result: Awaited<ReturnType<typeof host.addAttachmentFile>>) => {
                    const answer = ok(result);
                    if (answer.kind === 'refused') alert(answer.message);
                    if (answer.kind === 'empty') sheet.touched = true;
                    if (answer.kind === 'saved') {
                        if (answer.attachments) draft = answer.attachments;
                        Object.assign(sheet, { visible: false, text: '', touched: false, editing: null });
                    }
                };
                switch (verb) {
                    case 'addFile':
                    case 'addImage': {
                        const pick = verb === 'addFile' ? state.ports.pickDocument : state.ports.pickImage;
                        if (!pick || pick.canceled) break;
                        const asset = pick.assets[0] as { uri: string; name?: string; fileName?: string | null; mimeType?: string; size?: number; fileSize?: number };
                        change(await host.addAttachmentFile({
                            requestId: rnId(++ids),
                            owner: owner(),
                            source: verb === 'addFile' ? 'file' : 'image',
                            picked: {
                                uri: asset.uri,
                                name: (verb === 'addFile' ? asset.name : asset.fileName) ?? null,
                                mimeType: asset.mimeType ?? null,
                                size: (verb === 'addFile' ? asset.size : asset.fileSize) ?? null,
                            },
                        }));
                        break;
                    }
                    case 'openAddLink':
                        Object.assign(sheet, { visible: true, text: '', touched: false, editing: null });
                        break;
                    case 'editLink': {
                        const row = ok(host.getAttachmentList({ owner: owner() })).rows.find((entry) => entry.id === arg);
                        const link = draft.find((entry) => entry.id === arg);
                        if (row?.editText != null && link) {
                            Object.assign(sheet, { visible: true, text: row.editText, touched: false, editing: { attachmentId: arg, title: link.title, uri: link.uri } });
                        }
                        break;
                    }
                    case 'setLinkInput':
                        sheet.text = arg;
                        break;
                    case 'confirmLink':
                        change(await host.submitAttachmentLinks({ requestId: rnId(1000 + index), owner: owner(), text: sheet.text, editing: sheet.editing }));
                        break;
                    case 'closeLinkModal':
                        Object.assign(sheet, { visible: false, text: '', touched: false, editing: null });
                        break;
                    case 'remove':
                        change(await host.removeAttachment({ requestId: rnId(2000 + index), owner: owner(), attachmentId: arg }));
                        break;
                    case 'download':
                    case 'open': {
                        const answer = ok(verb === 'open'
                            ? await host.openAttachment({ owner: owner(), attachmentId: arg })
                            : await host.downloadAttachment({ owner: owner(), attachmentId: arg }));
                        if (answer.update) draft = ok(host.applyAttachmentUpdate({ attachments: draft, update: answer.update }));
                        if (answer.message) alert(answer.message);
                        const plan = 'open' in answer ? answer.open : null;
                        if (!plan) break;
                        if (plan.kind === 'alert') alert(plan.message);
                        if (plan.kind === 'link') {
                            state.log.push(['openURL', plan.uri]);
                            if (state.ports.openUrlFails) alert(plan.failedMessage!);
                        }
                        if (plan.kind === 'image') imagePreview = plan.attachment.id;
                        if (plan.kind === 'audio') audio = plan.attachment.id;
                        if (plan.kind === 'file') {
                            state.log.push(['tryOpenWithAndroidViewer', plan.uri, plan.mimeType]);
                            if (state.ports.viewer) break;
                            state.log.push(['sharingAvailable']);
                            state.log.push(state.ports.shareAvailable ? ['shareAsync', plan.uri] : ['openURL', plan.uri]);
                        }
                        break;
                    }
                    default:
                        throw new Error(`Unknown step ${step.action}`);
                }
                await flushPendingSave();
                const frozen = fixture.observations[scenario.name][index];
                const screen = scenario.surface === 'task'
                    ? { linkModalVisible: sheet.visible, linkInput: sheet.text, linkInputTouched: sheet.touched,
                        editingLinkAttachmentId: sheet.editing?.attachmentId ?? null, imagePreview, audio }
                    : { linkModalVisible: frozen.screen.linkModalVisible, linkInput: frozen.screen.linkInput, imagePreview };
                const frozenScreen = scenario.surface === 'task'
                    ? frozen.screen
                    : { linkModalVisible: frozen.screen.linkModalVisible, linkInput: frozen.screen.linkInput, imagePreview: frozen.screen.imagePreview };
                const frozenAttachments = scenario.surface === 'task' ? frozen.attachments : frozen.screen.storedAttachments;
                // The host speaks JSON: an undefined field is an absent one on both sides.
                expect(canonicalIds(revive({ step: step.action, events: normalize(state.log), attachments: listed(), screen }), known)).toEqual(
                    canonicalIds(revive({ step: step.action, events: frozen.events.filter(([kind]) => COMPARED.has(String(kind))),
                        attachments: frozenAttachments, screen: frozenScreen }), known),
                );
            }
        });
    }
});

const pdf = (id: string, fields: Partial<Attachment> = {}): Attachment => ({
    id, kind: 'file', title: `${id}.pdf`, uri: `file:///data/files/attachments/${id}.pdf`, mimeType: 'application/pdf',
    size: 10, localStatus: 'available', createdAt: CREATED, updatedAt: CREATED, ...fields,
});
const remote = (id: string): Attachment => pdf(id, { uri: '', localStatus: 'missing', cloudKey: `attachments/${id}.pdf`, fileHash: 'a'.repeat(64), contentRev: 1 });
const PICKED = { uri: 'content://picker/report', name: 'Report.pdf', mimeType: 'application/pdf', size: 1234 };

describe('native host contract: attachments, crash safety', () => {
    const originalTz = process.env.TZ;
    let env: Awaited<ReturnType<typeof openSqliteHost>> | null = null;
    beforeAll(() => { process.env.TZ = 'UTC'; });
    afterAll(() => {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });
    afterEach(async () => {
        await env?.close();
        env = null;
    });
    const seedProject = (attachments: Attachment[] = []): Project => ({ id: 'p1', title: 'Project', status: 'active', color: '#3b82f6',
        order: 0, tagIds: [], attachments, createdAt: CREATED, updatedAt: CREATED });
    const projectOwner: NativeAttachmentOwner = { kind: 'project', projectId: 'p1' };
    const stored = () => useTaskStore.getState()._allProjects.find((project) => project.id === 'p1')!;
    const later = async (change: () => Promise<unknown>) => {
        await change();
        await flushPendingSave();
    };

    it('adds a project file once: a replay after a restart answers its first reply, copies nothing and keeps a later removal', async () => {
        const state = { ports: {} as Ports, log: [] as unknown[][] };
        env = await openSqliteHost({ projects: [seedProject()] }, undefined, { attachments: fakeHost(state) });
        const input = { requestId: '00000000-0000-4000-8000-00000000a001', owner: projectOwner, source: 'file' as const, picked: PICKED };
        const first = await env.host.addAttachmentFile(input);
        expect(first).toEqual({ ok: true, value: { kind: 'saved', ids: [input.requestId], attachments: null } });
        expect(stored().attachments).toEqual([expect.objectContaining({ id: input.requestId, uri: `file:///data/files/attachments/${input.requestId}.pdf` })]);
        await later(() => useTaskStore.getState().updateProject('p1', { attachments: stored().attachments!.map((item) => ({ ...item, deletedAt: CREATED })) }));
        state.log = [];

        const replay = await env.replay((host) => host.addAttachmentFile(input));
        expect(replay.result).toEqual(first);
        expect(replay.wrote).toBe(false);
        expect(state.log).toEqual([]);
        expect(stored().attachments![0].deletedAt).toBe(CREATED);
        expect(await env.receiptIds()).toEqual([input.requestId]);
    });

    it('refuses a project file replayed after a restart whose picked document can no longer be read, and saves nothing', async () => {
        // The process died before the first send's receipt; at the next boot the picker's read grant is gone.
        const state = { ports: { persist: 'unreadable' } as Ports, log: [] as unknown[][] };
        env = await openSqliteHost({ projects: [seedProject()] }, undefined, { attachments: fakeHost(state) });
        const input = { requestId: '00000000-0000-4000-8000-00000000a0f1', owner: projectOwner, source: 'image' as const, picked: PICKED };
        const replay = await env.replay((host) => host.addAttachmentFile(input));
        expect(replay.result).toMatchObject({ ok: true, value: { kind: 'refused' } });
        expect(replay.wrote).toBe(false);
        expect(stored().attachments ?? []).toEqual([]);
    });

    it('adds a project link batch once: a replay after a restart answers its first reply', async () => {
        env = await openSqliteHost({ projects: [seedProject()] }, undefined, { attachments: fakeHost({ ports: {}, log: [] }) });
        const input = { requestId: '00000000-0000-4000-8000-00000000a002', owner: projectOwner, text: 'https://one.example\nTwo | https://two.example' };
        const first = ok(await env.host.submitAttachmentLinks(input));
        const ids = [requestRowId(input.requestId, 'link:0'), requestRowId(input.requestId, 'link:1')];
        expect(first).toEqual({ kind: 'saved', ids, attachments: null });
        expect(stored().attachments!.map((item) => [item.id, item.uri])).toEqual([[ids[0], 'https://one.example'], [ids[1], 'https://two.example']]);
        await later(() => useTaskStore.getState().updateProject('p1', { title: 'Renamed' }));

        const replay = await env.replay((host) => host.submitAttachmentLinks(input));
        expect(replay.result).toEqual({ ok: true, value: first });
        expect(replay.wrote).toBe(false);
        expect(stored().attachments).toHaveLength(2);
    });

    it('answers a project link batch\'s retry from its receipt after the project was archived', async () => {
        env = await openSqliteHost({ projects: [seedProject()] }, undefined, { attachments: fakeHost({ ports: {}, log: [] }) });
        const input = { requestId: '00000000-0000-4000-8000-00000000a004', owner: projectOwner, text: 'https://one.example' };
        const first = ok(await env.host.submitAttachmentLinks(input));
        expect(first).toEqual({ kind: 'saved', ids: [requestRowId(input.requestId, 'link:0')], attachments: null });
        await later(() => useTaskStore.getState().updateProject('p1', { status: 'archived' }));
        expect(ok(await env.host.submitAttachmentLinks(input))).toEqual(first);
        const replay = await env.replay((host) => host.submitAttachmentLinks(input));
        expect(replay.result).toEqual({ ok: true, value: first });
        expect(replay.wrote).toBe(false);
    });

    it('removes a synced project attachment once: a replay after a restart writes nothing', async () => {
        const synced = pdf('synced', { cloudKey: 'attachments/synced.pdf', fileHash: 'b'.repeat(64) });
        env = await openSqliteHost({ projects: [seedProject([synced])] }, undefined, { attachments: fakeHost({ ports: {}, log: [] }) });
        const input = { requestId: '00000000-0000-4000-8000-00000000a003', owner: projectOwner, attachmentId: 'synced' };
        const first = ok(await env.host.removeAttachment(input));
        expect(first).toEqual({ kind: 'saved', ids: ['synced'], attachments: null });
        const removed = stored().attachments![0];
        expect(removed).toMatchObject({ id: 'synced', cloudKey: 'attachments/synced.pdf', deletedAt: expect.any(String) });

        const replay = await env.replay((host) => host.removeAttachment(input));
        expect(replay.result).toEqual({ ok: true, value: first });
        expect(replay.wrote).toBe(false);
        expect(stored().attachments![0]).toEqual(removed);
    });

    it('downloads a project file; a replay after a restart finds it there and writes nothing', async () => {
        const state = { ports: {} as Ports, log: [] as unknown[][] };
        env = await openSqliteHost({ projects: [seedProject([remote('r1')])] }, undefined, { attachments: fakeHost(state) });
        state.ports.ensure = { status: 'available', attachment: { ...remote('r1'), uri: 'file:///data/files/attachments/r1.pdf', localStatus: 'available' } };
        expect(ok(await env.host.downloadAttachment({ owner: projectOwner, attachmentId: 'r1' })))
            .toEqual({ status: 'available', message: null, update: null });
        const downloaded = stored().attachments![0];
        expect(downloaded).toMatchObject({ uri: 'file:///data/files/attachments/r1.pdf', localStatus: 'available' });
        state.ports.ensure = { status: 'available', attachment: downloaded };

        const replay = await env.replay((host) => host.downloadAttachment({ owner: projectOwner, attachmentId: 'r1' }));
        expect(replay.result).toEqual({ ok: true, value: { status: 'available', message: null, update: null } });
        expect(replay.wrote).toBe(false);
        expect(stored()).toMatchObject({ rev: 2 });
    });

    it('keeps a task draft\'s commands target-state: a retry with the draft it answered changes nothing and copies nothing', async () => {
        const state = { ports: {} as Ports, log: [] as unknown[][] };
        const task: Task = { id: 't1', title: 'Task', status: 'next', tags: [], contexts: [], createdAt: CREATED, updatedAt: CREATED };
        env = await openSqliteHost({ tasks: [task] }, undefined, { attachments: fakeHost(state) });
        const owner = (attachments: Attachment[]): NativeAttachmentOwner => ({ kind: 'task', taskId: 't1', attachments });
        const fileRequest = '00000000-0000-4000-8000-00000000b001';
        const added = ok(await env.host.addAttachmentFile({ requestId: fileRequest, owner: owner([]), source: 'file', picked: PICKED }));
        if (added.kind !== 'saved') throw new Error('not added');
        const linkRequest = '00000000-0000-4000-8000-00000000b002';
        const linked = ok(await env.host.submitAttachmentLinks({ requestId: linkRequest, owner: owner(added.attachments!), text: 'https://one.example' }));
        if (linked.kind !== 'saved') throw new Error('not linked');
        const removed = ok(await env.host.removeAttachment({ requestId: '00000000-0000-4000-8000-00000000b003', owner: owner(linked.attachments!), attachmentId: fileRequest }));
        if (removed.kind !== 'saved') throw new Error('not removed');
        expect(state.log.filter(([name]) => name === 'persistAttachmentLocally')).toHaveLength(1);
        expect(useTaskStore.getState()._tasksById.get('t1')?.attachments).toBeUndefined();

        const restarted = await env.restart();
        state.log = [];
        const draft = removed.attachments!;
        expect(ok(await restarted.addAttachmentFile({ requestId: fileRequest, owner: owner(draft), source: 'file', picked: PICKED })))
            .toEqual({ kind: 'saved', ids: [fileRequest], attachments: draft });
        expect(ok(await restarted.submitAttachmentLinks({ requestId: linkRequest, owner: owner(draft), text: 'https://one.example' })))
            .toEqual({ kind: 'saved', ids: [requestRowId(linkRequest, 'link:0')], attachments: draft });
        expect(ok(await restarted.removeAttachment({ requestId: '00000000-0000-4000-8000-00000000b004', owner: owner(draft), attachmentId: fileRequest })))
            .toEqual({ kind: 'saved', ids: [fileRequest], attachments: draft });
        expect(state.log).toEqual([]);
    });

    it('edits a task link compare-and-set: an old edit replayed after a restart never undoes a later one', async () => {
        const task: Task = { id: 't1', title: 'Task', status: 'next', tags: [], contexts: [], createdAt: CREATED, updatedAt: CREATED };
        env = await openSqliteHost({ tasks: [task] }, undefined, { attachments: fakeHost({ ports: {}, log: [] }) });
        const a: Attachment = { id: 'l1', kind: 'link', title: 'A', uri: 'https://a.example', createdAt: CREATED, updatedAt: CREATED };
        const owner = (attachments: Attachment[]): NativeAttachmentOwner => ({ kind: 'task', taskId: 't1', attachments });
        const edit = (requestId: string, draft: Attachment[], text: string) => {
            const link = draft.find((item) => item.id === 'l1')!;
            return env!.host.submitAttachmentLinks({ requestId, owner: owner(draft), text, editing: { attachmentId: 'l1', title: link.title, uri: link.uri } });
        };
        const first = { requestId: '00000000-0000-4000-8000-00000000b011', draft: [a], text: 'B | https://b.example' };
        const toB = ok(await edit(first.requestId, first.draft, first.text));
        if (toB.kind !== 'saved') throw new Error('not edited');
        const toC = ok(await edit('00000000-0000-4000-8000-00000000b012', toB.attachments!, 'C | https://c.example'));
        if (toC.kind !== 'saved') throw new Error('not edited');
        expect(toC.attachments![0]).toMatchObject({ title: 'C', uri: 'https://c.example' });

        const restarted = await env.restart();
        // The first request, retried with its own original values against the draft that now holds C.
        const replay = await restarted.submitAttachmentLinks({ requestId: first.requestId, owner: owner(toC.attachments!), text: first.text,
            editing: { attachmentId: 'l1', title: 'A', uri: 'https://a.example' } });
        expect(replay).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
        // A retry whose draft already holds its text changes nothing.
        expect(ok(await restarted.submitAttachmentLinks({ requestId: first.requestId, owner: owner(toB.attachments!), text: first.text,
            editing: { attachmentId: 'l1', title: 'A', uri: 'https://a.example' } }))).toEqual({ kind: 'saved', ids: ['l1'], attachments: toB.attachments });
    });

    it('saves the editor\'s attachments with the draft once, over a sync\'s change to another attachment', async () => {
        const other = pdf('other');
        const task: Task = { id: 't1', title: 'Task', status: 'next', tags: [], contexts: [], attachments: [other], createdAt: CREATED, updatedAt: CREATED };
        env = await openSqliteHost({ tasks: [task] }, undefined, { attachments: fakeHost({ ports: {}, log: [] }) });
        const base = [other];
        const link: Attachment = { id: 'l1', kind: 'link', title: 'One', uri: 'https://one.example', createdAt: CREATED, updatedAt: CREATED };
        // While the editor is open, sync records the other attachment's upload.
        await later(() => useTaskStore.getState().updateTask('t1', { attachments: [{ ...other, cloudKey: 'attachments/other.pdf' }] }));
        const input = { id: 't1', base: {}, patch: {}, attachments: { base, value: [...base, link] }, requestId: '00000000-0000-4000-8000-00000000c001' };
        const first = await env.host.saveTaskDraft(input);
        expect(first).toMatchObject({ ok: true });
        expect(useTaskStore.getState()._tasksById.get('t1')?.attachments).toEqual([{ ...other, cloudKey: 'attachments/other.pdf' }, link]);
        await later(() => useTaskStore.getState().updateTask('t1', { attachments: [{ ...other, cloudKey: 'attachments/other.pdf' }, { ...link, deletedAt: CREATED }] }));

        const replay = await env.replay((host) => host.saveTaskDraft(input));
        expect(replay.result).toEqual(first);
        expect(replay.wrote).toBe(false);
        expect(useTaskStore.getState()._tasksById.get('t1')?.attachments?.[1]?.deletedAt).toBe(CREATED);
    });

    it('never brings back an attachment sync removed after the editor downloaded it', async () => {
        const state = { ports: {} as Ports, log: [] as unknown[][] };
        const task: Task = { id: 't1', title: 'Task', status: 'next', tags: [], contexts: [], attachments: [remote('r1')], createdAt: CREATED, updatedAt: CREATED };
        env = await openSqliteHost({ tasks: [task] }, undefined, { attachments: fakeHost(state) });
        const base = [remote('r1')];
        state.ports.ensure = { status: 'available', attachment: { ...remote('r1'), uri: 'file:///data/files/attachments/r1.pdf', localStatus: 'available' } };
        const answer = ok(await env.host.downloadAttachment({ owner: { kind: 'task', taskId: 't1', attachments: base }, attachmentId: 'r1' }));
        const draft = ok(env.host.applyAttachmentUpdate({ attachments: base, update: answer.update! }));
        const tombstone = { ...remote('r1'), deletedAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' };
        await later(() => useTaskStore.getState().updateTask('t1', { attachments: [tombstone] }));
        expect(await env.host.saveTaskDraft({ id: 't1', base: {}, patch: {}, attachments: { base, value: draft },
            requestId: '00000000-0000-4000-8000-00000000c002' })).toMatchObject({ ok: true });
        expect(useTaskStore.getState()._tasksById.get('t1')?.attachments).toEqual([tombstone]);
    });

    it('keeps a removed file\'s bytes when its attachment is restored before the cleanup runs, or the task changed since the Save', async () => {
        const state = { ports: {} as Ports, log: [] as unknown[][] };
        const kept = pdf('f1');
        const task: Task = { id: 't1', title: 'Task', status: 'next', tags: [], contexts: [], attachments: [kept], createdAt: CREATED, updatedAt: CREATED };
        env = await openSqliteHost({ tasks: [task] }, undefined, { attachments: fakeHost(state) });
        const saveRemoval = async (requestId: string) => {
            const baseline = useTaskStore.getState()._tasksById.get('t1')!.attachments!;
            const draft = baseline.map((item) => ({ ...item, deletedAt: NOW, updatedAt: NOW }));
            expect(await env!.host.saveTaskDraft({ id: 't1', base: {}, patch: {}, attachments: { base: baseline, value: draft }, requestId })).toMatchObject({ ok: true });
            const saved = useTaskStore.getState()._tasksById.get('t1')!;
            return { baseline, draft, committed: saved.attachments!, taskId: 't1', taskRevision: taskRevisionOf(saved) };
        };
        const removal = await saveRemoval('00000000-0000-4000-8000-00000000c003');
        // Restored (an undo, or another device) before the delayed cleanup runs.
        await later(() => useTaskStore.getState().updateTask('t1', { attachments: [kept] }));
        expect(ok(await env.host.settleTaskDraftAttachments(removal))).toEqual({ deleted: 0 });
        expect(state.log).toEqual([]);

        const second = await saveRemoval('00000000-0000-4000-8000-00000000c004');
        await later(() => useTaskStore.getState().updateTask('t1', { title: 'Renamed elsewhere' }));
        expect(ok(await env.host.settleTaskDraftAttachments(second))).toEqual({ deleted: 0 });
        expect(state.log).toEqual([]);
        expect(ok(await env.host.settleTaskDraftAttachments({ ...second, taskRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get('t1')!) })))
            .toEqual({ deleted: 1 });
        expect(state.log).toEqual([['deleteManagedAttachmentFile', expect.objectContaining({ id: 'f1', uri: kept.uri })]]);
    });

    it('checks ownership after the host\'s own awaits, immediately before each delete', async () => {
        const state = { ports: {} as Ports, log: [] as unknown[][] };
        const kept = pdf('f1');
        const task: Task = { id: 't1', title: 'Task', status: 'next', tags: [], contexts: [], attachments: [kept], createdAt: CREATED, updatedAt: CREATED };
        const host: NativeAttachmentsHost = {
            ...fakeHost(state),
            // As createMobileAttachmentFiles: the directory setup is awaited before the delete,
            // and the attachment is restored meanwhile.
            deleteManagedAttachmentFile: async (attachment, options) => {
                useTaskStore.getState().updateTask('t1', { attachments: [kept] });
                await flushPendingSave();
                if (options?.keep?.()) return false;
                state.log.push(['deleteManagedAttachmentFile', attachment]);
                return true;
            },
        };
        env = await openSqliteHost({ tasks: [task] }, undefined, { attachments: host });
        const baseline = [kept];
        const draft = [{ ...kept, deletedAt: NOW, updatedAt: NOW }];
        expect(await env.host.saveTaskDraft({ id: 't1', base: {}, patch: {}, attachments: { base: baseline, value: draft },
            requestId: '00000000-0000-4000-8000-00000000c005' })).toMatchObject({ ok: true });
        const saved = useTaskStore.getState()._tasksById.get('t1')!;
        expect(ok(await env.host.settleTaskDraftAttachments({ taskId: 't1', taskRevision: taskRevisionOf(saved), baseline, draft,
            committed: saved.attachments! }))).toEqual({ deleted: 0 });
        expect(state.log).toEqual([]);
    });
});

describe('native host contract: attachments, the list and the editor\'s helpers', () => {
    const originalTz = process.env.TZ;
    beforeAll(() => { process.env.TZ = 'UTC'; });
    afterAll(() => {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    });

    const open = async (state = { ports: {} as Ports, log: [] as unknown[][] }, projectStatus: Project['status'] = 'active') => {
        const link: Attachment = { id: 'l1', kind: 'link', title: 'Docs', uri: 'https://docs.example/a', createdAt: CREATED, updatedAt: CREATED };
        const attachments = [pdf('f1'), remote('r1'), link, pdf('gone', { deletedAt: CREATED })];
        const task: Task = { id: 't1', title: 'Task', status: 'next', tags: [], contexts: [], attachments, createdAt: CREATED, updatedAt: CREATED };
        const project: Project = { id: 'p1', title: 'Project', status: projectStatus, color: '#3b82f6', order: 0, tagIds: [], attachments, createdAt: CREATED, updatedAt: CREATED };
        const host = await openScreenHost({ data: { tasks: [task], projects: [project] }, record: {}, log: [], bindings: { attachments: fakeHost(state) } });
        return { host, attachments, state };
    };

    it('lists the rows React Native draws: titles, Missing or Download, Loading, the link\'s edit text and a project\'s progress', async () => {
        const { host, attachments } = await open();
        globalProgressTracker.updateProgress('r1', { operation: 'download', bytesTransferred: 25, totalBytes: 100, status: 'active' });
        try {
            const task = ok(host.getAttachmentList({ owner: { kind: 'task', taskId: 't1', attachments }, downloading: ['f1'] }));
            expect(task).toEqual({ canEdit: true, rows: [
                { id: 'f1', kind: 'file', title: 'f1.pdf', missing: false, canDownload: false, downloading: true, downloadIdentity: getAttachmentDownloadIdentity(attachments[0]), editText: null, progress: null },
                { id: 'r1', kind: 'file', title: 'r1.pdf', missing: true, canDownload: true, downloading: false, downloadIdentity: getAttachmentDownloadIdentity(attachments[1]), editText: null, progress: null },
                { id: 'l1', kind: 'link', title: 'Docs', missing: false, canDownload: false, downloading: false, downloadIdentity: null, editText: getAttachmentLinkEditText(attachments[2]), progress: null },
            ] });
            const project = ok(host.getAttachmentList({ owner: { kind: 'project', projectId: 'p1' } }));
            expect(project.rows.map((row) => [row.id, row.progress, row.editText])).toEqual([['f1', null, null], ['r1', { percentage: 25 }, null], ['l1', null, null]]);
        } finally {
            globalProgressTracker.clear('r1');
        }
        expect(host.getAttachmentList({ owner: { kind: 'task', taskId: 't1' } as never })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        expect(host.getAttachmentList({ owner: { kind: 'project', projectId: 'missing' } })).toMatchObject({ ok: false, error: { code: 'STALE_REVISION' } });
    });

    it('projects the captured raw file identity without changing it for a Loading row or persisting display fields', async () => {
        const { host, attachments } = await open();
        const before = JSON.stringify(useTaskStore.getState()._tasksById.get('t1')?.attachments);
        const owner: NativeAttachmentOwner = { kind: 'task', taskId: 't1', attachments };
        const first = ok(host.getAttachmentList({ owner }));
        const loading = ok(host.getAttachmentList({ owner, downloading: ['r1'] }));
        expect(loading.rows.find((row) => row.id === 'r1')?.downloadIdentity)
            .toBe(first.rows.find((row) => row.id === 'r1')?.downloadIdentity);
        expect(loading.rows.find((row) => row.id === 'r1')?.downloading).toBe(true);
        const changed = attachments.map((attachment) => attachment.id === 'r1'
            ? { ...attachment, fileHash: 'new-content-generation' } : attachment);
        const next = ok(host.getAttachmentList({ owner: { ...owner, attachments: changed } }));
        expect(next.rows.find((row) => row.id === 'r1')?.downloadIdentity)
            .not.toBe(first.rows.find((row) => row.id === 'r1')?.downloadIdentity);
        expect(first.rows.find((row) => row.id === 'l1')?.downloadIdentity).toBeNull();
        expect(ok(host.getAttachmentList({ owner: { kind: 'project', projectId: 'p1' } })).rows
            .map((row) => row.downloadIdentity)).toEqual(first.rows.map((row) => row.downloadIdentity));
        expect(JSON.stringify(useTaskStore.getState()._tasksById.get('t1')?.attachments)).toBe(before);
        expect(useTaskStore.getState()._tasksById.get('t1')?.attachments?.some((attachment) => 'downloadIdentity' in attachment)).toBe(false);
    });

    it('checks the link sheet\'s text as React Native\'s sheet does while typing: the first line that is not a link', async () => {
        const { host } = await open();
        expect(ok(host.getAttachmentLinkCheck({ text: 'https://a.example\n\nDocs | https://b.example' }))).toEqual({ error: null });
        expect(ok(host.getAttachmentLinkCheck({ text: 'https://a.example\nnot a link' }))).toEqual({ error: 'Line 2: enter a valid link.' });
        // The edit sheet takes one line and shows no line error, as RN's single-line field does.
        expect(ok(host.getAttachmentLinkCheck({ text: 'not a link', editing: true }))).toEqual({ error: null });
        expect(ok(host.getAttachmentLinkCheck({ text: '' }))).toEqual({ error: null });
        expect(host.getAttachmentLinkCheck({ text: 7 } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    });

    it('takes no edit on an archived project', async () => {
        const { host } = await open(undefined, 'archived');
        const owner: NativeAttachmentOwner = { kind: 'project', projectId: 'p1' };
        expect(ok(host.getAttachmentList({ owner })).canEdit).toBe(false);
        expect(ok(await host.addAttachmentFile({ requestId: '00000000-0000-4000-8000-00000000d001', owner, source: 'file', picked: PICKED }))).toEqual({ kind: 'blocked' });
        expect(ok(await host.submitAttachmentLinks({ requestId: '00000000-0000-4000-8000-00000000d002', owner, text: 'not a link' }))).toEqual({ kind: 'blocked' });
        expect(ok(await host.removeAttachment({ requestId: '00000000-0000-4000-8000-00000000d003', owner, attachmentId: 'f1' }))).toEqual({ kind: 'blocked' });
    });

    it('applies a task download to the draft only while the attachment is unchanged', async () => {
        const { host, attachments, state } = await open();
        state.ports.ensure = { status: 'available', attachment: { ...remote('r1'), uri: 'file:///data/files/attachments/r1.pdf', localStatus: 'available' } };
        const answer = ok(await host.downloadAttachment({ owner: { kind: 'task', taskId: 't1', attachments }, attachmentId: 'r1' }));
        expect(answer.update?.patch).toEqual({ localStatus: 'available', uri: 'file:///data/files/attachments/r1.pdf' });
        const applied = ok(host.applyAttachmentUpdate({ attachments, update: answer.update! }));
        expect(applied[1]).toMatchObject({ uri: 'file:///data/files/attachments/r1.pdf', localStatus: 'available' });
        const replaced = attachments.map((item) => item.id === 'r1' ? { ...item, contentRev: 2 } : item);
        expect(ok(host.applyAttachmentUpdate({ attachments: replaced, update: answer.update! }))).toEqual(replaced);
        // The draft owns it until Save: the stored task is unchanged.
        expect(useTaskStore.getState()._tasksById.get('t1')?.attachments?.[1]).toEqual(remote('r1'));
    });

    it('deletes the managed copies a discarded draft added, and none the task keeps', async () => {
        const { host, attachments, state } = await open();
        const added = pdf('added');
        const baseline = attachments.filter((item) => !item.deletedAt);
        const taskRevision = taskRevisionOf(useTaskStore.getState()._tasksById.get('t1')!);
        const answer = ok(await host.settleTaskDraftAttachments({ taskId: 't1', taskRevision, baseline, draft: [...baseline, added], committed: baseline }));
        expect(answer).toEqual({ deleted: 1 });
        expect(state.log).toEqual([['deleteManagedAttachmentFile', added]]);
    });

    it('logs a failed copy by ID and URI kind only, never the link\'s password or the file name', async () => {
        const lines: unknown[] = [];
        setLogger((entry) => { lines.push(entry); });
        try {
            const state = { ports: {} as Ports, log: [] as unknown[][] };
            const { host } = await open(state);
            const failing = { ...fakeHost(state), persistAttachmentLocally: async () => { throw new Error('read failed for secret-name.pdf'); } };
            const contract = createNativeHostContract({ attachments: failing });
            value(await contract.setLanguage({ storedLanguage: 'en', systemLocale: null }));
            value(await contract.activate({ writeSafetyReady: true }));
            void host;
            const answer = ok(await contract.addAttachmentFile({ requestId: '00000000-0000-4000-8000-00000000e001',
                owner: { kind: 'task', taskId: 't1', attachments: [] }, source: 'file',
                picked: { uri: 'content://user:hunter2@provider/secret-name.pdf', name: 'secret-name.pdf', mimeType: null, size: null } }));
            expect(answer).toEqual({ kind: 'refused', message: 'Couldn\'t read this file, so it was not attached. Move it to a different folder and try again.' });
            const text = JSON.stringify(lines);
            expect(text).toContain('Native attachment copy failed');
            expect(text).toContain('content:.pdf');
            expect(text).not.toContain('hunter2');
            expect(text).not.toContain('secret-name');
        } finally {
            setLogger(() => undefined);
        }
    });
});
