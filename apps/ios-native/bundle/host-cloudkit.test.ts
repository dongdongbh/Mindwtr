import { describe, expect, it } from 'bun:test';
import type { AppData } from '@mindwtr/core';
import { createNativeCloudKitRecords, type NativeCloudKitCall, type NativeCloudKitRequest } from './host-cloudkit';

const at = '2026-10-30T12:00:00.000Z';
const task = (id: string) => ({ id, title: 'Synthetic task', status: 'next', tags: [], contexts: [], createdAt: at, updatedAt: at } satisfies AppData['tasks'][number]);
const data = (): AppData => ({
    tasks: [task('legacy/é😀')],
    projects: [{ id: 'project', title: 'Synthetic project', status: 'active', color: '#123456', order: 0, tagIds: [], createdAt: at, updatedAt: at }],
    sections: [{ id: 'section', projectId: 'project', title: 'Synthetic section', order: 0, createdAt: at, updatedAt: at }],
    areas: [{ id: 'area', name: 'Synthetic area', order: 0, createdAt: at, updatedAt: at }],
    people: [{ id: 'person', name: 'Synthetic person', createdAt: at, updatedAt: at }],
    settings: { language: 'zh', gtd: { autoArchiveDays: 7 } },
});
const snapshot = (value = data()): Record<string, unknown> => ({
    MindwtrTask: value.tasks, MindwtrProject: value.projects, MindwtrSection: value.sections,
    MindwtrArea: value.areas, MindwtrPerson: value.people ?? [],
    MindwtrSettings: [{ id: 'settings', payload: value.settings, updatedAt: at }],
});
const fixture = (remote: Record<string, unknown> = snapshot(),
    reply?: (request: NativeCloudKitRequest, signal: AbortSignal) => unknown | Promise<unknown>) => {
    const calls: NativeCloudKitRequest[] = [], signals: AbortSignal[] = [];
    const call: NativeCloudKitCall = async (request, signal) => {
        calls.push(request); signals.push(signal);
        if (reply) return JSON.stringify(await reply(request, signal));
        switch (request.op) {
        case 'accountStatus': return JSON.stringify('available');
        case 'ensureZone': case 'deleteRecords': return 'null';
        case 'fetchAllRecords': return JSON.stringify(remote[request.recordType]);
        case 'saveRecords': return '[]';
        }
    };
    return { port: createNativeCloudKitRecords(call), calls, signals };
};
const recordTypes = ['MindwtrTask', 'MindwtrProject', 'MindwtrSection', 'MindwtrArea', 'MindwtrPerson', 'MindwtrSettings'];

describe('foreground native CloudKit records adapter', () => {
    it('reads all six types every cycle and retains imported record identities and settings', async () => {
        const { port, calls, signals } = fixture(), controller = new AbortController();
        expect(await port.read({ signal: controller.signal })).toEqual(data());
        expect(await port.read({ signal: controller.signal })).toEqual(data());
        expect(calls).toEqual([...recordTypes, ...recordTypes].map((recordType) => ({ op: 'fetchAllRecords', recordType })));
        expect(signals.every((signal) => signal === controller.signal)).toBe(true);
    });

    it('checks an explicit account and zone without subscription, token, or implicit setup', async () => {
        const { port, calls } = fixture();
        await port.ensureReady();
        expect(calls).toEqual([{ op: 'accountStatus' }, { op: 'ensureZone' }]);
        expect(await port.accountStatus()).toBe('available');
        for (const status of ['noAccount', 'restricted', 'temporarilyUnavailable', 'unknown', 'not-a-status', null]) {
            const blocked = fixture({}, async (request) => request.op === 'accountStatus' ? status : null);
            await expect(blocked.port.ensureReady()).rejects.toThrow();
            expect(blocked.calls).toEqual([{ op: 'accountStatus' }]);
        }
        const failedZone = fixture({}, async (request) => request.op === 'accountStatus' ? 'available' : true);
        await expect(failedZone.port.ensureReady()).rejects.toThrow('invalid');
    });

    it('rejects malformed or incomplete entity arrays rather than publishing an empty or partial snapshot', async () => {
        for (const bad of [null, {}, '[]', [null], [{ title: 'No identity' }], [task('duplicate'), task('duplicate')],
            [task('')], [task('x'.repeat(4_097))], [{ ...task('attachment'), attachments: 7 }]]) {
            const { port, calls } = fixture({ ...snapshot(), MindwtrTask: bad });
            await expect(port.read()).rejects.toThrow();
            expect(calls.some((request) => request.op === 'saveRecords' || request.op === 'deleteRecords')).toBe(false);
        }
        for (const recordType of recordTypes) {
            const { port } = fixture({ ...snapshot(), [recordType]: { records: [], partial: true } });
            await expect(port.read()).rejects.toThrow('invalid');
        }
    });

    it('rejects malformed settings and accepts only verified absence as an empty settings object', async () => {
        const valid = { id: 'settings', payload: {}, updatedAt: at };
        for (const bad of [[{}], [{ ...valid, id: 'other' }], [{ ...valid, payload: null }], [{ ...valid, payload: [] }],
            [{ ...valid, payload: 'corrupt JSON' }], [{ ...valid, updatedAt: 'invalid' }], [{ ...valid, extra: true }],
            [valid, { ...valid, id: 'another' }], [{ ...valid, payload: { taxonomy: [] } }]]) {
            await expect(fixture({ ...snapshot(), MindwtrSettings: bad }).port.read()).rejects.toThrow();
        }
        const empty = await fixture({ ...snapshot(), MindwtrSettings: [] }).port.read();
        expect(empty.settings).toEqual({}); expect(empty.tasks).toEqual(data().tasks);
    });

    it('fails the whole read when a later record type fails and does not start subsequent reads', async () => {
        const failure = new Error('Synthetic partial query failure'), calls: NativeCloudKitRequest[] = [];
        const port = createNativeCloudKitRecords(async (request) => {
            calls.push(request);
            if (request.op !== 'fetchAllRecords') throw new Error('Unexpected write');
            if (request.recordType === 'MindwtrSection') throw failure;
            return JSON.stringify(snapshot()[request.recordType]);
        });
        await expect(port.read()).rejects.toBe(failure);
        expect(calls).toEqual(recordTypes.slice(0, 3).map((recordType) => ({ op: 'fetchAllRecords', recordType })));
        await expect(createNativeCloudKitRecords(async () => '{').read()).rejects.toThrow();
        await expect(createNativeCloudKitRecords(async () => ' '.repeat(16 * 1024 * 1024 + 1)).read()).rejects.toThrow('invalid');
    });

    it('runs the shared inbound attachment validation and strips remote device paths', async () => {
        const input = data();
        input.tasks[0].attachments = [{ id: 'attachment', title: 'Synthetic file', kind: 'file', uri: 'file:///foreign/private',
            cloudKey: 'cloudkit:asset', localStatus: 'available', createdAt: at, updatedAt: at }];
        const remote = await fixture(snapshot(input)).port.read();
        expect(remote.tasks[0].attachments?.[0]).toMatchObject({ cloudKey: 'cloudkit:asset', uri: '' });
        expect(remote.tasks[0].attachments?.[0]).not.toHaveProperty('localStatus');
        expect(input.tasks[0].attachments[0].uri).toBe('file:///foreign/private');
    });

    it('writes RN record types/settings format and deletes only purged tasks/projects after saves', async () => {
        const input = data();
        input.tasks.push({ ...task('soft-deleted'), deletedAt: at }, { ...task('purged-task'), deletedAt: at, purgedAt: at });
        input.projects.push({ ...input.projects[0], id: 'purged-project', deletedAt: at, purgedAt: at });
        input.sections.push({ ...input.sections[0], id: 'deleted-section', deletedAt: at });
        const { port, calls } = fixture(); await port.write(input);
        const saves = calls.filter((request) => request.op === 'saveRecords');
        expect(saves.map((request) => request.recordType)).toEqual(recordTypes);
        expect(JSON.parse(saves[0].recordsJSON).map((row: { id: string }) => row.id)).toEqual(['legacy/é😀', 'soft-deleted', 'purged-task']);
        expect(JSON.parse(saves[5].recordsJSON)).toEqual([{ id: 'settings', payload: expect.objectContaining({ gtd: { autoArchiveDays: 7 } }), updatedAt: expect.any(String) }]);
        expect(JSON.parse(saves[5].recordsJSON)[0].payload).not.toHaveProperty('language');
        expect(calls.slice(6)).toEqual([
            { op: 'deleteRecords', recordType: 'MindwtrTask', recordIDs: ['purged-task'] },
            { op: 'deleteRecords', recordType: 'MindwtrProject', recordIDs: ['purged-project'] },
        ]);
    });

    it('reports save conflicts or malformed replies as failures and never follows them with later writes/deletes', async () => {
        for (const conflicts of [['legacy/é😀'], ['unrelated'], ['legacy/é😀', 'legacy/é😀'], null, false, [1]]) {
            const { port, calls } = fixture({}, async () => conflicts);
            await expect(port.write(data())).rejects.toThrow();
            expect(calls).toHaveLength(1); expect(calls[0].op).toBe('saveRecords');
        }
        const missingDelete = fixture({}, async (request) => request.op === 'saveRecords' ? [] : false), input = data();
        input.tasks[0].purgedAt = at;
        await expect(missingDelete.port.write(input)).rejects.toThrow('invalid');
    });

    it('validates and detaches the entire write before native mutations', async () => {
        const input = data(), { port, calls } = fixture({}, async () => { input.projects[0].title = 'Mutated while awaiting'; return []; });
        await port.write(input);
        const project = calls.find((request) => request.op === 'saveRecords' && request.recordType === 'MindwtrProject');
        if (project?.op !== 'saveRecords') throw new Error('Missing project write');
        expect(JSON.parse(project.recordsJSON)[0].title).toBe('Synthetic project');
        const bad = fixture();
        await expect(bad.port.write(JSON.parse(JSON.stringify({ ...data(), areas: 'corrupt' })))).rejects.toThrow('invalid');
        expect(bad.calls).toEqual([]);
    });

    it('checks cancellation before any call and forwards the same signal through every operation', async () => {
        const controller = new AbortController(), reason = new Error('Retired foreground job'); controller.abort(reason);
        const { port, calls } = fixture();
        await expect(port.accountStatus({ signal: controller.signal })).rejects.toBe(reason);
        await expect(port.ensureReady({ signal: controller.signal })).rejects.toBe(reason);
        await expect(port.read({ signal: controller.signal })).rejects.toBe(reason);
        await expect(port.write(data(), { signal: controller.signal })).rejects.toBe(reason);
        expect(calls).toEqual([]);
    });

    it('rejects an aborted result before any later read, save, delete, or setup call', async () => {
        for (const operation of ['read', 'write', 'ensureReady'] as const) {
            const controller = new AbortController(), reason = new Error('Retired during native call');
            const { port, calls, signals } = fixture({}, async (request, signal) => {
                expect(signal).toBe(controller.signal); controller.abort(reason);
                return request.op === 'accountStatus' ? 'available' : [];
            });
            const promise = operation === 'write' ? port.write(data(), { signal: controller.signal }) : port[operation]({ signal: controller.signal });
            await expect(promise).rejects.toBe(reason); expect(calls).toHaveLength(1);
            expect(signals).toEqual([controller.signal]);
        }
    });
});
