import { afterEach, describe, expect, it, vi } from 'vitest';
import { ingestIOSWatchAudio, ingestIOSWatchBatch, readIOSWatchAudioNeedsTranscript, readIOSWatchAudioOutcome } from './ios-watch-ingest';
import { openSqliteHost } from '../../../packages/core/src/screen-parity.replay';
import { flushPendingSave, resetForTests, useTaskStore } from '../../../packages/core/src/store';
import type { AppSettings, Task } from '../../../packages/core/src/types';

const ID = 'abcdef11-1111-4111-8111-111111111111';
const AT = '2026-10-10T12:00:00.000Z';
const name = `${ID}.json`;
const body = (extra = {}) => JSON.stringify({ protocolVersion: 1, id: ID, source: 'apple-watch', kind: 'audio', createdAt: AT,
    audioPath: `file:///old-container/Documents/watch-audio/${ID}.wav`, ...extra });
const envelope = (source = body(), transcript: string | null = 'Transcript') => JSON.stringify({ version: 1, requestId: ID, name, body: source, transcript });
const completed = { version: 1, ingested: 1, completed: [{ name }] };
const hosts: Awaited<ReturnType<typeof openSqliteHost>>[] = [];
const current = () => undefined;
async function open(tasks: Task[] = [], settings: AppSettings = {}) {
    const env = await openSqliteHost({ tasks, settings }); hosts.push(env);
    let record: string | null = null;
    const deps = { contract: env.host, current, lastApplied: { read: async () => record, write: async (value: string) => { record = value; } } };
    return { env, deps };
}
afterEach(async () => {
    vi.restoreAllMocks();
    for (const env of hosts.splice(0)) await env.close();
    resetForTests();
});

describe('owned native Watch audio envelope', () => {
    it('uses shared title, note, status and relative-date assembly under the original source UUID', async () => {
        const { env, deps } = await open(); const source = body({ title: 'Watch title', note: 'Retained note', defaultStatus: 'someday' });
        expect(await ingestIOSWatchAudio(envelope(source, 'buy milk /next /due:tomorrow'), deps)).toEqual(completed);
        const task = useTaskStore.getState()._allTasks.find(task => task.id === ID)!;
        expect(task).toMatchObject({ title: 'Watch title buy milk', description: 'Retained note', status: 'next', dueDate: '2026-10-11' });
        expect(await env.receiptIds()).toEqual([ID]);
        expect(await readIOSWatchAudioOutcome(source, current)).toEqual(completed);
        expect((await env.sql<{ method: string }>('SELECT method FROM native_request_receipts'))[0].method)
            .toContain('iosWatchIngestItem');
    });
    it('retains original-body receipt identity across cold replay after task edit, deletion and purge', async () => {
        const { env, deps } = await open(); const source = ` ${body()}\n`;
        await ingestIOSWatchAudio(envelope(source), deps);
        const original = await env.sql('SELECT * FROM native_request_receipts');
        await useTaskStore.getState().updateTask(ID, { title: 'Later edit', deletedAt: AT, purgedAt: AT }); await flushPendingSave();
        await env.restart(); deps.contract = env.host;
        const before = structuredClone(useTaskStore.getState()._allTasks);
        expect(await readIOSWatchAudioOutcome(source, current)).toEqual(completed);
        expect(await ingestIOSWatchAudio(envelope(source, 'Different replay transcript'), deps)).toEqual(completed);
        expect(useTaskStore.getState()._allTasks).toEqual(before); expect(await env.sql('SELECT * FROM native_request_receipts')).toEqual(original);
        useTaskStore.setState({ _allTasks: [], tasks: [], _tasksById: new Map() });
        expect(await readIOSWatchAudioOutcome(source, current)).toEqual(completed);
        expect(await ingestIOSWatchAudio(envelope(source, null), deps)).toEqual(completed);
        expect(useTaskStore.getState()._allTasks).toEqual([]);
        await expect(readIOSWatchAudioOutcome(body(), current)).rejects.toThrow('SAVE_FAILED');
        expect(await env.sql('SELECT * FROM native_request_receipts')).toEqual(original);
    });
    it.each([true, false])('uses the saved natural-language date policy (%s)', async naturalLanguageDates => {
        const { deps } = await open([], { gtd: { naturalLanguageDates } });
        await ingestIOSWatchAudio(envelope(body(), 'Read a book tomorrow'), deps);
        const task = useTaskStore.getState()._allTasks.find(task => task.id === ID)!;
        expect(task.title).toBe('Read a book tomorrow');
        expect(task.dueDate).toBe(naturalLanguageDates ? '2026-10-11' : undefined);
    });
    it('refuses a missing previously loaded receipt and malformed saved reply', async () => {
        const { env, deps } = await open(); const source = body();
        expect(await readIOSWatchAudioOutcome(source, current)).toBeNull();
        await ingestIOSWatchAudio(envelope(source), deps);
        await env.client().run('UPDATE native_request_receipts SET reply=? WHERE request_id=?', ['{}', ID]);
        await expect(readIOSWatchAudioOutcome(source, current)).rejects.toThrow('SAVE_FAILED');
        await env.client().run('DELETE FROM native_request_receipts WHERE request_id=?', [ID]);
        await expect(readIOSWatchAudioOutcome(source, current)).rejects.toThrow('SAVE_FAILED');
    });
    it.each(['existing', 'deleted', 'purged'] as const)('completes UUID-only %s task replay without a transcript or task changes', async mode => {
        const task: Task = { id: ID, title: 'Saved task', status: 'next', tags: [], contexts: [], createdAt: AT, updatedAt: AT,
            ...(mode !== 'existing' ? { deletedAt: AT } : {}), ...(mode === 'purged' ? { purgedAt: AT } : {}) };
        const { env, deps } = await open([task]); const before = structuredClone(useTaskStore.getState()._allTasks);
        expect(readIOSWatchAudioNeedsTranscript(body(), current)).toBe(false);
        expect(await ingestIOSWatchAudio(envelope(body(), null), deps)).toEqual(completed);
        expect(useTaskStore.getState()._allTasks).toEqual(before); expect(await env.receiptIds()).toEqual([ID]);
    });
    it('refuses missing-task null transcripts and a task removed before the drain reads its queue', async () => {
        const { env, deps } = await open();
        expect(readIOSWatchAudioNeedsTranscript(body(), current)).toBe(true);
        await expect(ingestIOSWatchAudio(envelope(body(), null), deps)).rejects.toThrow('NOT_READY');
        expect(await env.receiptIds()).toEqual([]); expect(useTaskStore.getState()._allTasks).toEqual([]);
        const task: Task = { id: ID, title: 'Saved', status: 'next', tags: [], contexts: [], createdAt: AT, updatedAt: AT };
        useTaskStore.setState({ _allTasks: [task] });
        const contract = deps.contract;
        deps.contract = { ...contract, ingestPendingCaptures: async input => {
            useTaskStore.setState({ _allTasks: [] });
            return contract.ingestPendingCaptures(input);
        } };
        await expect(ingestIOSWatchAudio(envelope(body(), null), deps)).rejects.toThrow();
        expect(await env.receiptIds()).toEqual([]); expect(useTaskStore.getState()._allTasks).toEqual([]);
    });
    it.each(['', ' ', '\n\t', ' leading', 'trailing ', 'é'.repeat(32769)])('rejects empty, noncanonical or oversized transcript before contract access (%#)', async transcript => {
        const { env, deps } = await open(); const ingest = vi.spyOn(deps.contract, 'ingestPendingCaptures');
        await expect(ingestIOSWatchAudio(envelope(body(), transcript), deps)).rejects.toThrow('INVALID_INPUT');
        expect(ingest).not.toHaveBeenCalled(); expect(await env.receiptIds()).toEqual([]); expect(useTaskStore.getState()._allTasks).toEqual([]);
    });
    it('keeps ordinary Watch batches closed to audio and rejects malformed source/envelope before mutation', async () => {
        const { env, deps } = await open();
        await expect(ingestIOSWatchBatch(JSON.stringify({ version: 1, requestId: ID, entries: [{ name, body: body() }] }), deps)).rejects.toThrow('INVALID_INPUT');
        const sources = [body({ protocolVersion: true }), body({ source: 'phone' }), body({ kind: 'text', title: 'Invalid' }),
            body({ id: ID.toUpperCase() }), body({ createdAt: '2026-02-30T00:00:00Z' }), body({ extra: true }),
            body({ audioPath: 'https://example.org/audio.wav' }), body({ audioPath: `file:///watch-audio/${ID}.wav?secret=1` }),
            body().replace('"kind":"audio"', '"kind":"audio","kind":"audio"')];
        for (const source of sources) {
            await expect(ingestIOSWatchAudio(envelope(source), deps)).rejects.toThrow('INVALID_INPUT');
            await expect(readIOSWatchAudioOutcome(source, current)).rejects.toThrow('INVALID_INPUT');
        }
        for (const extra of [{ name: '../bad.json' }, { requestId: '22222222-2222-4222-8222-222222222222' }, { extra: true }])
            await expect(ingestIOSWatchAudio(JSON.stringify({ ...JSON.parse(envelope()), ...extra }), deps)).rejects.toThrow('INVALID_INPUT');
        await expect(ingestIOSWatchAudio(envelope().replace('"version":1', '"version":1,"\\u0076ersion":1'), deps)).rejects.toThrow('INVALID_INPUT');
        expect(await env.receiptIds()).toEqual([]); expect(useTaskStore.getState()._allTasks).toEqual([]);
    });
    it('passes only a synthetic mapping to the drain and performs no physical audio deletion', async () => {
        const { deps } = await open(); const contract = deps.contract;
        let physicalPort: unknown;
        deps.contract = { ...contract, ingestPendingCaptures: async input => {
            physicalPort = input.audio;
            const parsed = JSON.parse(body());
            expect(input.audio?.resolvePath(parsed)).toBe(`watch-audio/${ID}.wav`);
            expect(await input.audio?.transcribe?.(`watch-audio/${ID}.wav`, {})).toBe('Transcript');
            await expect(input.audio!.delete('file:///private/unrelated.wav')).rejects.toThrow('INVALID_INPUT');
            return contract.ingestPendingCaptures(input);
        } };
        expect(await ingestIOSWatchAudio(envelope(), deps)).toEqual(completed); expect(physicalPort).toBeDefined();
    });
});
