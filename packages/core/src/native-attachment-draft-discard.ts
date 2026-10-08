import { planAttachmentDraftSettlement } from './attachment-draft-settlement';
import { readNativeAttachmentDraftFrozen, readNativeAttachmentDraftFrozenV2, readNativeAttachmentDraftPayload,
    readNativeAttachmentDraftRemoveFrozen, validateNativeAttachmentDraftLineage,
    validateNativeAttachmentDraftLineageV2, validateNativeAttachmentDraftLineageV3, validateNativeAttachmentDraftLineageV4,
    readNativeAttachmentDraftAvailabilityFrozen, validateNativeAttachmentDraftLineageV5,
    type NativeAttachmentDraftOperationV3, type NativeAttachmentDraftOperationV4, type NativeAttachmentDraftOperationV5 } from './native-attachment-draft';

export type NativeAttachmentDraftDiscardPhase =
    'intent' | 'stagePrepared' | 'stageFilled' | 'published' | 'resultDurable' | 'checkpointed';
export type NativeAttachmentDraftDiscardInput = Readonly<{
    version: 1; historyVersion: 1 | 2; taskID: string; managedDirectoryURI: string;
    initialPayloadJSON: string; checkpointPayloadJSON: string;
    operations: readonly Readonly<{ phase: NativeAttachmentDraftDiscardPhase; preparedJSON: string }>[];
}>;
export type NativeAttachmentDraftDiscardCandidates = Readonly<{
    version: 1; kind: 'owned-add-discard-candidates'; taskID: string; historyVersion: 1 | 2;
    candidates: readonly Readonly<{ requestId: string; targetURI: string; reason: 'uncommitted-draft' }>[];
}>;
export type NativeAttachmentDraftDiscardInputV3 = Readonly<{
    version: 2; historyVersion: 3; taskID: string; managedDirectoryURI: string;
    initialPayloadJSON: string; checkpointPayloadJSON: string;
    operations: readonly Readonly<
        { kind: 'add'; phase: NativeAttachmentDraftDiscardPhase; preparedJSON: string }
        | { kind: 'remove'; phase: 'intent' | 'checkpointed'; preparedJSON: string }
    >[];
}>;
export type NativeAttachmentDraftDiscardCandidatesV3 = Readonly<{
    version: 2; kind: 'owned-mixed-discard-candidates'; taskID: string; historyVersion: 3;
    candidates: NativeAttachmentDraftDiscardCandidates['candidates'];
}>;

export type NativeAttachmentDraftDiscardInputV4 = Omit<NativeAttachmentDraftDiscardInputV3, 'version' | 'historyVersion'> & {
    version: 3; historyVersion: 4;
};
export type NativeAttachmentDraftDiscardCandidatesV4 = Omit<NativeAttachmentDraftDiscardCandidatesV3, 'version' | 'historyVersion'> & {
    version: 3; historyVersion: 4;
};

const INPUT_BYTES = 8 * 1024 * 1024;
const OUTPUT_BYTES = 4 * 1024 * 1024;
const PAYLOAD_BYTES = 1_000_000;
const PREPARED_BYTES = 2 * 1024 * 1024;
const PHASES: readonly string[] = ['intent', 'stagePrepared', 'stageFilled', 'published', 'resultDurable', 'checkpointed'];
function invalid(): never {
    throw new Error('INVALID_INPUT: A bounded retained attachment Discard history is required');
}
const utf8Bytes = (value: string, limit: number): number => {
    let bytes = 0;
    for (let index = 0; index < value.length; index++) {
        const unit = value.charCodeAt(index);
        if (unit < 0x80) bytes++;
        else if (unit < 0x800) bytes += 2;
        else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length
            && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
            bytes += 4; index++;
        } else bytes += 3;
        if (bytes > limit) return bytes;
    }
    return bytes;
};
const text = (value: unknown, limit: number): string => {
    if (typeof value !== 'string' || !value || value.length > limit || utf8Bytes(value, limit) > limit) invalid();
    return value as string;
};
const own = (value: object, field: string): boolean => Object.prototype.hasOwnProperty.call(value, field);
// The request has only three structural levels and scalar leaves. Capture via
// descriptors, never by invoking caller accessors, iterators or serialization.
const fields = (value: unknown, names: readonly string[]): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid();
    const keys = Reflect.ownKeys(value as object);
    if (keys.length !== names.length) invalid();
    const result: Record<string, unknown> = Object.create(null);
    for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (!descriptor?.enumerable || !own(descriptor, 'value')) invalid();
        result[name] = descriptor!.value;
    }
    return result;
};
const quote = (value: string): string => JSON.stringify(value);
const operationJSON = (value: { phase: string; preparedJSON: string }): string =>
    `{"phase":${quote(value.phase)},"preparedJSON":${quote(value.preparedJSON)}}`;
const capture = (input: unknown): NativeAttachmentDraftDiscardInput => {
    const value = fields(input, ['version', 'historyVersion', 'taskID', 'managedDirectoryURI',
        'initialPayloadJSON', 'checkpointPayloadJSON', 'operations']);
    if (value.version !== 1 || value.historyVersion !== 1 && value.historyVersion !== 2) invalid();
    const taskID = text(value.taskID, 500), managedDirectoryURI = text(value.managedDirectoryURI, 16 * 1024);
    const initialPayloadJSON = text(value.initialPayloadJSON, PAYLOAD_BYTES);
    const checkpointPayloadJSON = text(value.checkpointPayloadJSON, PAYLOAD_BYTES);
    if (!Array.isArray(value.operations) || Object.getPrototypeOf(value.operations) !== Array.prototype) invalid();
    const length = Object.getOwnPropertyDescriptor(value.operations, 'length')?.value as unknown;
    if (typeof length !== 'number' || length > 128 || Reflect.ownKeys(value.operations).length !== length + 1) invalid();
    // Measure captured scalar encoding incrementally; never concatenate an
    // oversized history before admission. Primitive serialization has no hooks.
    const header = `{"version":1,"historyVersion":${value.historyVersion},"taskID":${quote(taskID)},`
        + `"managedDirectoryURI":${quote(managedDirectoryURI)},"initialPayloadJSON":${quote(initialPayloadJSON)},`
        + `"checkpointPayloadJSON":${quote(checkpointPayloadJSON)},"operations":[]}`;
    let encodedBytes = utf8Bytes(header, INPUT_BYTES);
    if (encodedBytes > INPUT_BYTES) invalid();
    const operations: { phase: NativeAttachmentDraftDiscardPhase; preparedJSON: string }[] = [];
    const seen = new Set<object>();
    for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value.operations, String(index));
        if (!descriptor?.enumerable || !own(descriptor, 'value')) invalid();
        const raw: unknown = descriptor!.value;
        if (!raw || typeof raw !== 'object' || seen.has(raw)) invalid();
        seen.add(raw as object);
        const operation = fields(raw, ['phase', 'preparedJSON']);
        if (typeof operation.phase !== 'string' || !PHASES.includes(operation.phase)
            || index < length - 1 && operation.phase !== 'checkpointed') invalid();
        const captured = { phase: operation.phase as NativeAttachmentDraftDiscardPhase,
            preparedJSON: text(operation.preparedJSON, PREPARED_BYTES) };
        encodedBytes += utf8Bytes(operationJSON(captured), INPUT_BYTES) + (index ? 1 : 0);
        if (encodedBytes > INPUT_BYTES) invalid();
        operations.push(captured);
    }
    return { version: 1, historyVersion: value.historyVersion, taskID, managedDirectoryURI,
        initialPayloadJSON, checkpointPayloadJSON, operations };
};

// Opaque JSON remains byte-for-byte intact. Inspect its parsed shape before
// existing readers compare it, bounding traversal even for hostile nesting.
const parsed = (json: string, budget: { remaining: number }, maximumDepth = 40): unknown => {
    const value: unknown = JSON.parse(json);
    const pending = [{ value, depth: 0 }];
    while (pending.length) {
        const entry = pending.pop()!;
        if (--budget.remaining < 0 || entry.depth > maximumDepth) invalid();
        if (typeof entry.value === 'number' && !Number.isFinite(entry.value)) invalid();
        if (entry.value && typeof entry.value === 'object') {
            const keys = Object.keys(entry.value);
            if (keys.length > budget.remaining) invalid();
            for (const key of keys) pending.push({
                value: (entry.value as Record<string, unknown>)[key], depth: entry.depth + 1,
            });
        }
    }
    return value;
};

/** Logical owned-Add candidates only. Native separately proves existence and retirement authority. */
export function prepareNativeAttachmentDraftDiscardCandidates(input: unknown): NativeAttachmentDraftDiscardCandidates {
    try {
        const captured = capture(input), budget = { remaining: 100_000 };
        parsed(captured.initialPayloadJSON, budget);
        parsed(captured.checkpointPayloadJSON, budget);
        const additions = captured.operations.map((operation) => {
            const raw = parsed(operation.preparedJSON, budget);
            const value = fields(raw, ['version', 'kind', 'taskID', 'requestId', 'picked', 'measuredSize',
                'managedDirectoryURI', 'beforePayloadJSON', 'afterPayloadJSON', 'prepared', 'targetURI', 'attachment']);
            parsed(text(value.beforePayloadJSON, PAYLOAD_BYTES), budget);
            parsed(text(value.afterPayloadJSON, PAYLOAD_BYTES), budget);
            return readNativeAttachmentDraftFrozen(raw);
        });
        const validate = captured.historyVersion === 1
            ? validateNativeAttachmentDraftLineage : validateNativeAttachmentDraftLineageV2;
        const last = additions[additions.length - 1];
        const pending = captured.operations[captured.operations.length - 1]?.phase !== 'checkpointed' && Boolean(last);
        const lineage = (priorAdditions: typeof additions, beforePayloadJSON: string) => validate({
            version: captured.historyVersion, taskID: captured.taskID, managedDirectoryURI: captured.managedDirectoryURI,
            initialPayloadJSON: captured.initialPayloadJSON, beforePayloadJSON, priorAdditions,
        });
        lineage(additions, pending ? last!.afterPayloadJSON : captured.checkpointPayloadJSON);
        if (pending) {
            if (captured.checkpointPayloadJSON !== last!.beforePayloadJSON) invalid();
            lineage(additions.slice(0, -1), captured.checkpointPayloadJSON);
        }
        const opening = readNativeAttachmentDraftPayload(captured.initialPayloadJSON, captured.taskID);
        const baselineIDs = new Set(opening.baselineAttachments.map((attachment) => attachment.id));
        const retainedURIs = new Set([...opening.baselineAttachments, ...opening.attachments].map((attachment) => attachment.uri));
        const targets = new Set<string>();
        for (const addition of additions) {
            if (baselineIDs.has(addition.requestId) || retainedURIs.has(addition.targetURI) || targets.has(addition.targetURI)) invalid();
            targets.add(addition.targetURI);
        }
        const planned = planAttachmentDraftSettlement({ baselineAttachments: opening.baselineAttachments,
            draftAttachments: [...opening.attachments, ...additions.map((addition) => addition.attachment)],
            committedAttachments: opening.baselineAttachments });
        const byID = new Map(additions.map((addition) => [addition.requestId, addition]));
        const candidates: { requestId: string; targetURI: string; reason: 'uncommitted-draft' }[] = [];
        for (const candidate of planned) {
            if (baselineIDs.has(candidate.attachment.id)) continue;
            const addition = byID.get(candidate.attachment.id);
            if (!addition || candidate.reason !== 'uncommitted-draft' || candidate.attachment.uri !== addition.targetURI) invalid();
            candidates.push(Object.freeze({ requestId: addition.requestId, targetURI: addition.targetURI, reason: 'uncommitted-draft' }));
        }
        if (candidates.length !== additions.length || candidates.some((candidate, index) => candidate.requestId !== additions[index].requestId)) invalid();
        const encoded = `{"version":1,"kind":"owned-add-discard-candidates","taskID":${quote(captured.taskID)},`
            + `"historyVersion":${captured.historyVersion},"candidates":[${candidates.map((candidate) =>
                `{"requestId":${quote(candidate.requestId)},"targetURI":${quote(candidate.targetURI)},"reason":"uncommitted-draft"}`).join(',')}]}`;
        if (utf8Bytes(encoded, OUTPUT_BYTES) > OUTPUT_BYTES) invalid();
        return Object.freeze({ version: 1, kind: 'owned-add-discard-candidates', taskID: captured.taskID,
            historyVersion: captured.historyVersion, candidates: Object.freeze(candidates) });
    } catch { return invalid(); }
}

const captureMixed = (input: unknown, version: 2 | 3): NativeAttachmentDraftDiscardInputV3 | NativeAttachmentDraftDiscardInputV4 => {
    const value = fields(input, ['version', 'historyVersion', 'taskID', 'managedDirectoryURI',
        'initialPayloadJSON', 'checkpointPayloadJSON', 'operations']);
    if (value.version !== version || value.historyVersion !== version + 1) invalid();
    const taskID = text(value.taskID, 500), managedDirectoryURI = text(value.managedDirectoryURI, 16 * 1024);
    const initialPayloadJSON = text(value.initialPayloadJSON, PAYLOAD_BYTES);
    const checkpointPayloadJSON = text(value.checkpointPayloadJSON, PAYLOAD_BYTES);
    if (!Array.isArray(value.operations) || Object.getPrototypeOf(value.operations) !== Array.prototype) invalid();
    const length = Object.getOwnPropertyDescriptor(value.operations, 'length')?.value as unknown;
    if (typeof length !== 'number' || length > 128 || Reflect.ownKeys(value.operations).length !== length + 1) invalid();
    const header = `{"version":${version},"historyVersion":${version + 1},"taskID":${quote(taskID)},`
        + `"managedDirectoryURI":${quote(managedDirectoryURI)},"initialPayloadJSON":${quote(initialPayloadJSON)},`
        + `"checkpointPayloadJSON":${quote(checkpointPayloadJSON)},"operations":[]}`;
    let encodedBytes = utf8Bytes(header, INPUT_BYTES);
    if (encodedBytes > INPUT_BYTES) invalid();
    const operations: NativeAttachmentDraftDiscardInputV3['operations'][number][] = [], seen = new Set<object>();
    for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value.operations, String(index));
        if (!descriptor?.enumerable || !own(descriptor, 'value')) invalid();
        const raw: unknown = descriptor!.value;
        if (!raw || typeof raw !== 'object' || seen.has(raw)) invalid();
        seen.add(raw as object);
        const operation = fields(raw, ['kind', 'phase', 'preparedJSON']);
        if (operation.kind !== 'add' && operation.kind !== 'remove' || typeof operation.phase !== 'string'
            || !(operation.kind === 'add' ? PHASES : ['intent', 'checkpointed']).includes(operation.phase)
            || index < length - 1 && operation.phase !== 'checkpointed') invalid();
        const captured = { kind: operation.kind, phase: operation.phase,
            preparedJSON: text(operation.preparedJSON, PREPARED_BYTES) } as NativeAttachmentDraftDiscardInputV3['operations'][number];
        encodedBytes += utf8Bytes(`{"kind":${quote(captured.kind)},"phase":${quote(captured.phase)},`
            + `"preparedJSON":${quote(captured.preparedJSON)}}`, INPUT_BYTES) + (index ? 1 : 0);
        if (encodedBytes > INPUT_BYTES) invalid();
        operations.push(captured);
    }
    return { version, historyVersion: version + 1, taskID, managedDirectoryURI,
        initialPayloadJSON, checkpointPayloadJSON, operations } as NativeAttachmentDraftDiscardInputV3 | NativeAttachmentDraftDiscardInputV4;
};

/** Pure mixed-history candidates. Native separately proves publication and retirement authority. */
export function prepareNativeAttachmentDraftDiscardCandidatesV3(input: unknown): NativeAttachmentDraftDiscardCandidatesV3 {
    return prepareMixedCandidates(input, 2) as NativeAttachmentDraftDiscardCandidatesV3;
}

export function prepareNativeAttachmentDraftDiscardCandidatesV4(input: unknown): NativeAttachmentDraftDiscardCandidatesV4 {
    return prepareMixedCandidates(input, 3) as NativeAttachmentDraftDiscardCandidatesV4;
}

function prepareMixedCandidates(input: unknown, version: 2 | 3): NativeAttachmentDraftDiscardCandidatesV3 | NativeAttachmentDraftDiscardCandidatesV4 {
    try {
        const captured = captureMixed(input, version);
        const parse = (json: string): unknown => parsed(json, { remaining: 100_000 }, 64);
        parse(captured.initialPayloadJSON); parse(captured.checkpointPayloadJSON);
        const history: (NativeAttachmentDraftOperationV3 | NativeAttachmentDraftOperationV4)[] = captured.operations.map((entry) => {
            const raw = parse(entry.preparedJSON);
            const value = fields(raw, entry.kind === 'add'
                ? ['version', 'kind', 'taskID', 'requestId', 'picked', 'measuredSize', 'managedDirectoryURI',
                    'beforePayloadJSON', 'afterPayloadJSON', 'prepared', 'targetURI', 'attachment', ...(version === 3 ? ['sourceSha256'] : [])]
                : ['version', 'kind', 'taskID', 'requestId', 'attachmentId', 'removedAt', 'beforePayloadJSON', 'afterPayloadJSON']);
            parse(text(value.beforePayloadJSON, PAYLOAD_BYTES)); parse(text(value.afterPayloadJSON, PAYLOAD_BYTES));
            return (entry.kind === 'add' ? { kind: 'add', operation: version === 3 ? readNativeAttachmentDraftFrozenV2(raw) : readNativeAttachmentDraftFrozen(raw) }
                : { kind: 'remove', operation: readNativeAttachmentDraftRemoveFrozen(raw) }) as NativeAttachmentDraftOperationV3 | NativeAttachmentDraftOperationV4;
        });
        const last = history[history.length - 1];
        const pending = Boolean(last) && captured.operations[captured.operations.length - 1].phase !== 'checkpointed';
        const validate = version === 3 ? validateNativeAttachmentDraftLineageV4 : validateNativeAttachmentDraftLineageV3;
        const lineage = (priorOperations: typeof history, beforePayloadJSON: string) => validate({
            version: captured.historyVersion, taskID: captured.taskID, managedDirectoryURI: captured.managedDirectoryURI,
            initialPayloadJSON: captured.initialPayloadJSON, beforePayloadJSON, priorOperations,
        });
        const latestPayloadJSON = pending ? last.operation.afterPayloadJSON : captured.checkpointPayloadJSON;
        lineage(history, latestPayloadJSON);
        if (pending) {
            if (captured.checkpointPayloadJSON !== last.operation.beforePayloadJSON) invalid();
            lineage(history.slice(0, -1), captured.checkpointPayloadJSON);
        }
        const opening = readNativeAttachmentDraftPayload(captured.initialPayloadJSON, captured.taskID);
        const latest = readNativeAttachmentDraftPayload(latestPayloadJSON, captured.taskID);
        const additions = history.flatMap((entry) => entry.kind === 'add' ? [entry.operation] : []);
        const baselineIDs = new Set(opening.baselineAttachments.map((attachment) => attachment.id));
        const retainedURIs = new Set([...opening.baselineAttachments, ...opening.attachments].map((attachment) => attachment.uri));
        const targets = new Set<string>();
        for (const addition of additions) {
            if (baselineIDs.has(addition.requestId) || retainedURIs.has(addition.targetURI) || targets.has(addition.targetURI)) invalid();
            targets.add(addition.targetURI);
        }
        const planned = planAttachmentDraftSettlement({ baselineAttachments: opening.baselineAttachments,
            draftAttachments: latest.attachments, committedAttachments: opening.baselineAttachments });
        const byID = new Map(additions.map((addition) => [addition.requestId, addition]));
        const candidates: { requestId: string; targetURI: string; reason: 'uncommitted-draft' }[] = [];
        for (const candidate of planned) {
            if (baselineIDs.has(candidate.attachment.id)) continue;
            const addition = byID.get(candidate.attachment.id);
            if (!addition || candidate.reason !== 'uncommitted-draft' || candidate.attachment.uri !== addition.targetURI) invalid();
            candidates.push(Object.freeze({ requestId: addition.requestId, targetURI: addition.targetURI, reason: 'uncommitted-draft' }));
        }
        if (candidates.length !== additions.length || candidates.some((candidate, index) => candidate.requestId !== additions[index].requestId)) invalid();
        const encoded = `{"version":${version},"kind":"owned-mixed-discard-candidates","taskID":${quote(captured.taskID)},`
            + `"historyVersion":${captured.historyVersion},"candidates":[${candidates.map((candidate) =>
                `{"requestId":${quote(candidate.requestId)},"targetURI":${quote(candidate.targetURI)},"reason":"uncommitted-draft"}`).join(',')}]}`;
        if (utf8Bytes(encoded, OUTPUT_BYTES) > OUTPUT_BYTES) invalid();
        return Object.freeze({ version, kind: 'owned-mixed-discard-candidates', taskID: captured.taskID,
            historyVersion: captured.historyVersion, candidates: Object.freeze(candidates) }) as NativeAttachmentDraftDiscardCandidatesV3 | NativeAttachmentDraftDiscardCandidatesV4;
    } catch { return invalid(); }
}

export type NativeAttachmentDraftDiscardInputV5 = Readonly<{
    version: 4; historyVersion: 5; taskID: string; managedDirectoryURI: string;
    initialPayloadJSON: string; checkpointPayloadJSON: string;
    operations: readonly Readonly<{ kind: 'availability'; phase: 'intent' | 'checkpointed'; preparedJSON: string }>[];
}>;
export type NativeAttachmentDraftDiscardCandidatesV5 = Readonly<{
    version: 4; kind: 'owned-availability-discard-candidates'; taskID: string; historyVersion: 5;
    candidates: readonly Readonly<{ requestId: string; attachmentId: string; targetURI: string; reason: 'uncommitted-draft' }>[];
}>;

const captureAvailability = (input: unknown): NativeAttachmentDraftDiscardInputV5 => {
    const value = fields(input, ['version', 'historyVersion', 'taskID', 'managedDirectoryURI',
        'initialPayloadJSON', 'checkpointPayloadJSON', 'operations']);
    if (value.version !== 4 || value.historyVersion !== 5) invalid();
    const taskID = text(value.taskID, 500), managedDirectoryURI = text(value.managedDirectoryURI, 16 * 1024);
    const initialPayloadJSON = text(value.initialPayloadJSON, PAYLOAD_BYTES);
    const checkpointPayloadJSON = text(value.checkpointPayloadJSON, PAYLOAD_BYTES);
    if (!Array.isArray(value.operations) || Object.getPrototypeOf(value.operations) !== Array.prototype) invalid();
    const length = Object.getOwnPropertyDescriptor(value.operations, 'length')?.value as unknown;
    if (typeof length !== 'number' || length > 128 || Reflect.ownKeys(value.operations).length !== length + 1) invalid();
    const header = `{"version":4,"historyVersion":5,"taskID":${quote(taskID)},`
        + `"managedDirectoryURI":${quote(managedDirectoryURI)},"initialPayloadJSON":${quote(initialPayloadJSON)},`
        + `"checkpointPayloadJSON":${quote(checkpointPayloadJSON)},"operations":[]}`;
    let encodedBytes = utf8Bytes(header, INPUT_BYTES);
    if (encodedBytes > INPUT_BYTES) invalid();
    const operations: NativeAttachmentDraftDiscardInputV5['operations'][number][] = [], seen = new Set<object>();
    for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value.operations, String(index));
        if (!descriptor?.enumerable || !own(descriptor, 'value')) invalid();
        const raw: unknown = descriptor!.value;
        if (!raw || typeof raw !== 'object' || seen.has(raw)) invalid();
        seen.add(raw as object);
        const operation = fields(raw, ['kind', 'phase', 'preparedJSON']);
        if (operation.kind !== 'availability' || operation.phase !== 'intent' && operation.phase !== 'checkpointed'
            || index < length - 1 && operation.phase !== 'checkpointed') invalid();
        const captured = { kind: 'availability', phase: operation.phase,
            preparedJSON: text(operation.preparedJSON, PREPARED_BYTES) } as NativeAttachmentDraftDiscardInputV5['operations'][number];
        encodedBytes += utf8Bytes(`{"kind":"availability","phase":${quote(captured.phase)},`
            + `"preparedJSON":${quote(captured.preparedJSON)}}`, INPUT_BYTES) + (index ? 1 : 0);
        if (encodedBytes > INPUT_BYTES) invalid();
        operations.push(captured);
    }
    return { version: 4, historyVersion: 5, taskID, managedDirectoryURI, initialPayloadJSON, checkpointPayloadJSON, operations };
};

/** Availability metadata candidates only; native must separately prove the installed file generation and live references. */
export function prepareNativeAttachmentDraftDiscardCandidatesV5(input: unknown): NativeAttachmentDraftDiscardCandidatesV5 {
    try {
        const captured = captureAvailability(input);
        const parse = (json: string): unknown => parsed(json, { remaining: 100_000 }, 64);
        parse(captured.initialPayloadJSON); parse(captured.checkpointPayloadJSON);
        const history: NativeAttachmentDraftOperationV5[] = captured.operations.map((entry) => {
            const raw = parse(entry.preparedJSON);
            const value = fields(raw, ['version', 'kind', 'taskID', 'requestId', 'attachmentId', 'identity',
                'beforePayloadJSON', 'status', 'resolvedAttachmentJSON', 'afterPayloadJSON']);
            parse(text(value.beforePayloadJSON, PAYLOAD_BYTES)); parse(text(value.afterPayloadJSON, PAYLOAD_BYTES));
            return { kind: 'availability', operation: readNativeAttachmentDraftAvailabilityFrozen(raw) };
        });
        const last = history[history.length - 1];
        const pending = Boolean(last) && captured.operations[captured.operations.length - 1].phase === 'intent';
        const lineage = (priorOperations: typeof history, beforePayloadJSON: string) => validateNativeAttachmentDraftLineageV5({
            version: 5, taskID: captured.taskID, managedDirectoryURI: captured.managedDirectoryURI,
            initialPayloadJSON: captured.initialPayloadJSON, beforePayloadJSON, priorOperations,
        });
        const latestPayloadJSON = pending ? last.operation.afterPayloadJSON : captured.checkpointPayloadJSON;
        lineage(history, latestPayloadJSON);
        if (pending) {
            if (captured.checkpointPayloadJSON !== last.operation.beforePayloadJSON) invalid();
            lineage(history.slice(0, -1), captured.checkpointPayloadJSON);
        }
        const opening = readNativeAttachmentDraftPayload(captured.initialPayloadJSON, captured.taskID);
        const latest = readNativeAttachmentDraftPayload(latestPayloadJSON, captured.taskID);
        const planned = planAttachmentDraftSettlement({ baselineAttachments: opening.baselineAttachments,
            draftAttachments: latest.attachments, committedAttachments: opening.baselineAttachments });
        const available = history.flatMap(({ operation }) => operation.status === 'available' ? [{ operation,
            attachments: readNativeAttachmentDraftPayload(operation.afterPayloadJSON, captured.taskID).attachments }] : []);
        const baselineURIs = new Set(opening.baselineAttachments.filter((row) => row.kind === 'file').map((row) => row.uri));
        const targets = new Set<string>();
        const candidates: NativeAttachmentDraftDiscardCandidatesV5['candidates'][number][] = [];
        for (const candidate of planned) {
            // Baseline tombstones can appear in the generic plan but confer no ownership on this projection.
            if (candidate.reason !== 'uncommitted-draft') continue;
            const attachmentId = candidate.attachment.id, targetURI = candidate.attachment.uri;
            if (baselineURIs.has(targetURI) || targets.has(targetURI)) invalid();
            const bindings = available.filter(({ operation, attachments }) => operation.attachmentId === attachmentId
                && attachments.some((row) => row.id === attachmentId && row.uri === targetURI));
            if (bindings.length !== 1) invalid();
            targets.add(targetURI);
            candidates.push(Object.freeze({ requestId: bindings[0].operation.requestId, attachmentId, targetURI, reason: 'uncommitted-draft' }));
        }
        const result: NativeAttachmentDraftDiscardCandidatesV5 = { version: 4, kind: 'owned-availability-discard-candidates',
            taskID: captured.taskID, historyVersion: 5, candidates: Object.freeze(candidates) };
        if (utf8Bytes(JSON.stringify(result), OUTPUT_BYTES) > OUTPUT_BYTES) invalid();
        return Object.freeze(result);
    } catch { return invalid(); }
}
