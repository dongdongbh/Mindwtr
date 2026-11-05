import { isObjectRecord, isValidTimestamp, parseSyncDocument, toRemoteSyncDocument,
    type AppData } from '@mindwtr/core';

export type NativeCloudKitRecordType = 'MindwtrTask' | 'MindwtrProject' | 'MindwtrSection'
    | 'MindwtrArea' | 'MindwtrPerson' | 'MindwtrSettings';
export type NativeCloudKitRequest =
    | { op: 'accountStatus' | 'ensureZone' }
    | { op: 'fetchAllRecords'; recordType: NativeCloudKitRecordType }
    | { op: 'saveRecords'; recordType: NativeCloudKitRecordType; recordsJSON: string }
    | { op: 'deleteRecords'; recordType: NativeCloudKitRecordType; recordIDs: string[] };
export type NativeCloudKitCall = (request: NativeCloudKitRequest, signal: AbortSignal) => Promise<string>;
export type NativeCloudKitAccountStatus = 'available' | 'noAccount' | 'restricted' | 'temporarilyUnavailable' | 'unknown';
type Options = { signal?: AbortSignal };
const maximumBytes = 16 * 1024 * 1024;
const maximumRecords = 100_000;
const types = {
    tasks: 'MindwtrTask', projects: 'MindwtrProject', sections: 'MindwtrSection',
    areas: 'MindwtrArea', people: 'MindwtrPerson',
} satisfies Record<string, NativeCloudKitRecordType>;
const invalid = (): never => { throw new Error('Native CloudKit response is invalid or incomplete'); };
const boundedJSON = (value: string): string => {
    if (new TextEncoder().encode(value).byteLength > maximumBytes) return invalid();
    return value;
};
const validID = (id: unknown): id is string => typeof id === 'string' && id.trim().length > 0
    && new TextEncoder().encode(id).byteLength <= 4_096;
const abort = (signal: AbortSignal): void => {
    if (!signal.aborted) return;
    if (signal.reason instanceof Error) throw signal.reason;
    throw Object.assign(new Error('Native CloudKit operation cancelled'), { name: 'AbortError' });
};
const records = (value: unknown): Record<string, unknown>[] => {
    if (!Array.isArray(value) || value.length > maximumRecords) return invalid();
    const ids = new Set<string>();
    return value.map((row: unknown) => {
        if (!isObjectRecord(row) || !validID(row.id) || ids.has(row.id)) return invalid();
        ids.add(row.id); return row;
    });
};
const document = (value: unknown, source: 'local' | 'remote'): AppData => {
    if (!isObjectRecord(value) || !Array.isArray(value.tasks) || !Array.isArray(value.projects)
        || !Array.isArray(value.sections) || !Array.isArray(value.areas) || !isObjectRecord(value.settings)
        || (value.people !== undefined && !Array.isArray(value.people))) return invalid();
    for (const surface of ['tasks', 'projects', 'sections', 'areas', 'people']) {
        if (value[surface] !== undefined) records(value[surface]);
    }
    const parsed = parseSyncDocument(value, source);
    if (!parsed.ok) return invalid();
    return parsed.data;
};

export const createNativeCloudKitRecords = (call: NativeCloudKitCall) => {
    const request = async (input: NativeCloudKitRequest, signal: AbortSignal): Promise<unknown> => {
        abort(signal);
        let raw: string;
        try { raw = await call(input, signal); }
        catch (error) { abort(signal); throw error; }
        abort(signal);
        if (typeof raw !== 'string') return invalid();
        return JSON.parse(boundedJSON(raw));
    };
    const done = async (input: NativeCloudKitRequest, signal: AbortSignal): Promise<void> => {
        if (await request(input, signal) !== null) return invalid();
    };
    const accountStatus = async (options: Options = {}): Promise<NativeCloudKitAccountStatus> => {
        const value = await request({ op: 'accountStatus' }, options.signal ?? new AbortController().signal);
        switch (value) {
        case 'available': case 'noAccount': case 'restricted': case 'temporarilyUnavailable': case 'unknown': return value;
        default: return invalid();
        }
    };
    return {
        accountStatus,
        ensureReady: async (options: Options = {}): Promise<void> => {
            const signal = options.signal ?? new AbortController().signal;
            if (await accountStatus({ signal }) !== 'available') throw new Error('Native CloudKit account is unavailable');
            await done({ op: 'ensureZone' }, signal);
        },
        read: async (options: Options = {}): Promise<AppData> => {
            const signal = options.signal ?? new AbortController().signal;
            const tasks = records(await request({ op: 'fetchAllRecords', recordType: types.tasks }, signal));
            const projects = records(await request({ op: 'fetchAllRecords', recordType: types.projects }, signal));
            const sections = records(await request({ op: 'fetchAllRecords', recordType: types.sections }, signal));
            const areas = records(await request({ op: 'fetchAllRecords', recordType: types.areas }, signal));
            const people = records(await request({ op: 'fetchAllRecords', recordType: types.people }, signal));
            const settingsRecords = records(await request({ op: 'fetchAllRecords', recordType: 'MindwtrSettings' }, signal));
            if (settingsRecords.length > 1) return invalid();
            const settings = settingsRecords[0];
            if (settings && (settings.id !== 'settings' || !isObjectRecord(settings.payload)
                || !isValidTimestamp(settings.updatedAt)
                || Object.keys(settings).some((field) => !['id', 'payload', 'updatedAt'].includes(field)))) return invalid();
            return document({ tasks, projects, sections, areas, people, settings: settings ? settings.payload : {} }, 'remote');
        },
        write: async (data: AppData, options: Options = {}): Promise<void> => {
            const signal = options.signal ?? new AbortController().signal;
            abort(signal);
            const snapshot = toRemoteSyncDocument(document(JSON.parse(boundedJSON(JSON.stringify(data))), 'local'));
            const saves: { recordType: NativeCloudKitRecordType; recordsJSON: string; ids: Set<string> }[] = [];
            for (const surface of ['tasks', 'projects', 'sections', 'areas', 'people'] as const) {
                const rows = snapshot[surface] ?? [];
                if (rows.length) saves.push({ recordType: types[surface], recordsJSON: boundedJSON(JSON.stringify(rows)), ids: new Set(rows.map((row) => row.id)) });
            }
            if (Object.keys(snapshot.settings).length) saves.push({ recordType: 'MindwtrSettings',
                recordsJSON: boundedJSON(JSON.stringify([{ id: 'settings', payload: snapshot.settings, updatedAt: new Date().toISOString() }])), ids: new Set(['settings']) });
            const deletes = [
                { recordType: types.tasks, recordIDs: snapshot.tasks.filter((row) => row.purgedAt).map((row) => row.id) },
                { recordType: types.projects, recordIDs: snapshot.projects.filter((row) => row.purgedAt).map((row) => row.id) },
            ];
            for (const save of saves) {
                const conflicts = await request({ op: 'saveRecords', recordType: save.recordType, recordsJSON: save.recordsJSON }, signal);
                if (!Array.isArray(conflicts) || conflicts.length > save.ids.size
                    || !conflicts.every((id: unknown) => validID(id) && save.ids.has(id))
                    || new Set(conflicts).size !== conflicts.length) return invalid();
                if (conflicts.length) throw new Error('Native CloudKit records conflicted; sync must retry');
            }
            for (const deletion of deletes) {
                if (deletion.recordIDs.length) await done({ op: 'deleteRecords', ...deletion }, signal);
            }
            abort(signal);
        },
    };
};
