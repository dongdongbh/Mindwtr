import { createNativeHostContract, type NativeHostResult } from '../../../packages/core/src/native-host-contract';
import { createNativeRequestReceipts } from '../../../packages/core/src/native-request-receipts';
import { createSandboxData } from '../../../packages/core/src/sandbox-data';
import { createSandboxStorage, initializeSandboxRuntime, pickSandboxDisplaySettings } from '../../../packages/core/src/sandbox';
import { flushPendingSave, setStorageAdapter } from '../../../packages/core/src/store';
import type { AppSettings } from '../../../packages/core/src/types';

const MAX_INPUT = 128 * 1024;
const MAX_REPLY = 1024 * 1024;
const MAX_TICKETS = 64;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const failure = <Code extends string>(code: Code, message: string): { ok: false; error: { code: Code; message: string } } =>
    ({ ok: false, error: { code, message } });
const object = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const parseObject = (json: string, limit = MAX_INPUT): Record<string, unknown> => {
    if (typeof json !== 'string' || json.length > limit) throw new Error('INVALID_INPUT');
    const input: unknown = JSON.parse(json);
    if (!object(input)) throw new Error('INVALID_INPUT');
    return input;
};
const hasOwn = (input: object, field: string) => Object.prototype.hasOwnProperty.call(input, field);
const closedFields = (input: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
    required.every((field) => hasOwn(input, field))
    && Object.keys(input).every((field) => required.includes(field) || optional.includes(field));

// Only this closed display preference object crosses from personal mode.
const displaySettings = (json: string): AppSettings => {
    const input = parseObject(json, 4096);
    if (!closedFields(input, [], ['language', 'theme', 'dateFormat', 'calendarSystem', 'timeFormat', 'appearance'])
        || ['language', 'theme', 'dateFormat', 'calendarSystem', 'timeFormat'].some((field) =>
            input[field] !== undefined && typeof input[field] !== 'string')) throw new Error('INVALID_INPUT');
    if (input.appearance !== undefined && (!object(input.appearance)
        || !closedFields(input.appearance, [], ['density', 'textSize', 'showTaskAge', 'showFutureStarts']))) throw new Error('INVALID_INPUT');
    // Shared picking validates theme and appearance values; no personal settings are spread.
    return pickSandboxDisplaySettings(input as AppSettings);
};

type Contract = ReturnType<typeof createNativeHostContract>;
type Slot = { cancelled: boolean; reply: string | null };
const pending = new Map<string, Slot>();
let nextTicket = 1;
let queue: Promise<void> = Promise.resolve();
let phase: 'fresh' | 'starting' | 'ready' | 'failed' | 'closed' = 'fresh';
let contract: Contract | null = null;
let closeDrain: Promise<unknown> | null = null;

const encode = (result: unknown): string => {
    const json = JSON.stringify(result);
    return json.length <= MAX_REPLY ? json
        : JSON.stringify(failure('REPLY_TOO_LARGE', 'Sample response exceeds the bounded reply'));
};
const submit = (work: () => Promise<unknown> | unknown): string => {
    if (pending.size >= MAX_TICKETS) throw new Error('BUSY: Too many unconsumed sample tickets');
    const ticket = String(nextTicket++);
    const slot: Slot = { cancelled: false, reply: null };
    pending.set(ticket, slot);
    queue = queue.then(async () => {
        let result: unknown;
        try { result = slot.cancelled ? failure('CANCELLED', 'Sample operation cancelled') : await work(); }
        catch { result = failure('INVALID_INPUT', 'Invalid sample operation or input'); }
        slot.reply = encode(slot.cancelled ? failure('CANCELLED', 'Sample operation cancelled') : result);
    });
    return ticket;
};

const save = async (): Promise<NativeHostResult<null>> => {
    try { await flushPendingSave(); return { ok: true, value: null }; }
    catch { return { ok: false, error: { code: 'SAVE_FAILED', message: 'Sample memory save failed' } }; }
};
let receipts: ReturnType<typeof createNativeRequestReceipts> | null = null;

const list = (host: Contract, key: 'next' | 'schedule', input: Record<string, unknown>) => {
    if (typeof input.offset !== 'number' || !Number.isSafeInteger(input.offset) || input.offset < 0
        || typeof input.limit !== 'number' || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100
        || (input.offset > 0 && typeof input.revision !== 'string')
        || (input.revision !== undefined && typeof input.revision !== 'string')) return failure('INVALID_INPUT', 'Invalid sample list window');
    const focus = host.getFocus({ limit: input.limit });
    if (!focus.ok) return focus;
    return host.getFocusSectionWindow({ key, offset: input.offset, limit: input.limit,
        revision: typeof input.revision === 'string' ? input.revision : focus.value.revision });
};

const operations = (host: Contract) => ({
    inbox: { required: ['offset', 'limit'], optional: ['revision'], method: host.getInboxWindow },
    next: { required: ['offset', 'limit'], optional: ['revision'], method: (input: Record<string, unknown>) => list(host, 'next', input) },
    today: { required: ['offset', 'limit'], optional: ['revision'], method: (input: Record<string, unknown>) => list(host, 'schedule', input) },
    projects: { required: [], method: host.getProjects },
    project: { required: ['projectId', 'offset', 'limit'], optional: ['revision'], method: host.getProjectDetail },
    task: { required: ['id'], optional: ['offset', 'limit', 'revision'], method: host.getTaskView },
    editor: { required: ['id'], method: host.getTaskEditorModel },
    editDraft: { required: ['id', 'draft'], optional: ['edit'], method: host.editTaskDraft },
    saveDraft: { required: ['id', 'base', 'patch', 'requestId'], method: host.saveTaskDraft },
    capture: { required: ['title', 'captureId'], method: async (input: Record<string, unknown>) => {
        if (typeof input.title !== 'string' || typeof input.captureId !== 'string'
            || !UUID.test(input.captureId) || !receipts) return failure('INVALID_INPUT', 'A capture title and UUID are required');
        const { title, captureId } = input;
        return receipts.run(captureId, JSON.stringify(['sandboxCapture', title, captureId]), () => host.createInboxTask({ title, captureId }));
    } },
    complete: { required: ['id', 'taskRevision', 'requestId'], method: async (input: Record<string, unknown>) => {
        if (typeof input.id !== 'string' || typeof input.taskRevision !== 'string'
            || typeof input.requestId !== 'string' || !UUID.test(input.requestId) || !receipts) return failure('INVALID_INPUT', 'A bounded completion request is required');
        const { id, taskRevision, requestId } = input;
        return receipts.run(requestId, JSON.stringify(['sandboxComplete', id, taskRevision]), () => host.completeTask({ id, taskRevision }));
    } },
    createProject: { required: ['title', 'areaId', 'requestId'], method: host.createProject },
    renameOptions: { required: ['projectId'], method: host.getProjectRenameOptions },
    renameProject: { required: ['projectId', 'title', 'expected', 'requestId'], method: async (input: Record<string, unknown>) => {
        if (typeof input.requestId !== 'string' || !UUID.test(input.requestId) || !receipts) return failure('INVALID_INPUT', 'A project rename UUID is required');
        return receipts.run(input.requestId, JSON.stringify(['sandboxRename', input.projectId, input.title, input.expected]), async () => {
            // Shared preparation validates the complete request before the shared commit writer.
            const prepared: ReturnType<Contract['prepareProjectRename']> = Reflect.apply(host.prepareProjectRename, host, [input]);
            if (!prepared.ok) return prepared;
            if (prepared.value.kind === 'blocked') return failure('INVALID_INPUT', 'Sample project is read-only');
            if (prepared.value.kind === 'noop') return { ok: true, value: prepared.value.result };
            return host.commitPreparedProjectRename({ request: prepared.value.prepared.request, prepared: prepared.value.prepared });
        });
    } },
});

export const sandboxHost = {
    start(json: string): string {
        if (phase !== 'fresh') return submit(() => failure(phase === 'closed' ? 'CLOSED' : 'NOT_READY', 'Sample context cannot start again'));
        if (pending.size >= MAX_TICKETS) throw new Error('BUSY: Too many unconsumed sample tickets');
        phase = 'starting';
        return submit(async () => {
            try {
                const settings = displaySettings(json);
                initializeSandboxRuntime(true);
                setStorageAdapter(createSandboxStorage(createSandboxData({ settings })));
                const host = createNativeHostContract({ replayTokens: 'required' });
                const activated = await host.activate({ writeSafetyReady: true });
                if (!activated.ok) { if (phase !== 'closed') phase = 'failed'; return activated; }
                const language = await host.setLanguage({ storedLanguage: settings.language ?? null, systemLocale: null });
                if (!language.ok) { if (phase !== 'closed') phase = 'failed'; return language; }
                contract = host;
                receipts = createNativeRequestReceipts({ save });
                if (phase !== 'closed') phase = 'ready';
                return { ok: true, value: { version: 1, workspace: 'sandbox', volatile: true } };
            } catch { if (phase !== 'closed') phase = 'failed'; return failure('INVALID_INPUT', 'Invalid sample display preferences or activation'); }
        });
    },
    call(method: string, json: string): string {
        if (phase !== 'ready' || !contract) return submit(() => failure(phase === 'closed' ? 'CLOSED' : 'NOT_READY', 'Sample context is unavailable'));
        const host = contract;
        return submit(async () => {
            const table = operations(host);
            if (typeof method !== 'string' || !hasOwn(table, method)) return failure('METHOD_DENIED', 'Sample method is not allowed');
            const input = parseObject(json);
            const operation = table[method as keyof typeof table];
            if (!closedFields(input, operation.required, 'optional' in operation ? operation.optional : [])) return failure('INVALID_INPUT', 'Unexpected or missing sample fields');
            // Each allowlisted core method owns runtime validation of its DTO values.
            return Reflect.apply(operation.method, host, [input]);
        });
    },
    poll(ticket: string): string | null {
        const slot = pending.get(ticket);
        if (!slot) return encode(failure('INVALID_TICKET', 'Unknown sample ticket'));
        if (slot.reply === null) return null;
        pending.delete(ticket);
        return slot.reply;
    },
    abort(ticket: string): null {
        const slot = pending.get(ticket);
        if (slot && slot.reply === null) slot.cancelled = true;
        return null;
    },
    close(): string {
        phase = 'closed';
        if (!closeDrain) {
            closeDrain = queue.then(async () => { await flushPendingSave(); contract = null; receipts = null; return { closed: true }; });
            pending.clear();
        }
        return submit(async () => ({ ok: true, value: await closeDrain }));
    },
};

Object.defineProperty(globalThis, 'MindwtrSandboxHost', { value: Object.freeze(sandboxHost), writable: false, configurable: false });
