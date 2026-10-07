import { preparePickedAttachment, persistPreparedPickedAttachment, softDeleteAttachment, patchAttachment, type PreparedPickedAttachment } from './attachment-editor-model';
import { getManagedAttachmentFileName } from './mobile-attachment-files';
import { getAttachmentAvailabilityPatch, getAttachmentDownloadIdentity, getAttachmentUnrecoverablePatch } from './mobile-attachment-availability';
import { isSha256Hex } from './attachment-hash';
import { readNativeAttachments, readNativeTaskLinkHalf } from './native-host-contract-attachments';
import { taskEditValuesEqual } from './json-value-equality';
import { validateAttachmentForUpload } from './attachment-validation';
import type { Attachment } from './types';

/** Internal projection only. Native durable descriptor proofs grant file authority separately. */
export type NativeAttachmentDraftDependencies = {
    assertEditable(taskID: string): void;
    t(key: string): string;
};
export type NativeAttachmentDraftPicked = Readonly<{
    uri: string; name: string | null; mimeType: string | null; size: number | null;
}>;
export type NativeAttachmentDraftFile = Readonly<{
    id: string; kind: 'file'; title: string; uri: string; mimeType?: string; size: number;
    createdAt: string; updatedAt: string; localStatus: 'available';
}>;
export type NativeAttachmentDraftBeginInput = { taskID: string; payloadJSON: string };
export type NativeAttachmentDraftBegin = Readonly<{ version: 1; taskID: string; payloadJSON: string }>;
export type NativeAttachmentDraftPrepared = Readonly<{
    version: 1; kind: 'prepared'; taskID: string; requestId: string;
    picked: NativeAttachmentDraftPicked; measuredSize: number; managedDirectoryURI: string;
    beforePayloadJSON: string; afterPayloadJSON: string; prepared: PreparedPickedAttachment;
    targetURI: string; attachment: NativeAttachmentDraftFile;
}>;
export type NativeAttachmentDraftLineageInput = {
    version: 1; taskID: string; initialPayloadJSON: string; beforePayloadJSON: string;
    priorAdditions: readonly NativeAttachmentDraftPrepared[]; managedDirectoryURI: string;
};
/** A structural history acknowledgment only; it grants no task or file authority. */
export type NativeAttachmentDraftLineage = NativeAttachmentDraftBegin;
export type NativeAttachmentDraftPrepareInput = NativeAttachmentDraftLineageInput & {
    requestId: string;
    picked: NativeAttachmentDraftPicked; measuredSize: number;
};
export type NativeAttachmentDraftLineageInputV2 = Omit<NativeAttachmentDraftLineageInput, 'version'> & { version: 2 };
export type NativeAttachmentDraftPrepareInputV2 = Omit<NativeAttachmentDraftPrepareInput, 'version'> & { version: 2 };
export type NativeAttachmentDraftLineageV2 = Omit<NativeAttachmentDraftLineage, 'version'> & { version: 2 };
export type NativeAttachmentDraftRemovePrepared = Readonly<{
    version: 1; kind: 'prepared-file-remove'; taskID: string; requestId: string; attachmentId: string;
    removedAt: string; beforePayloadJSON: string; afterPayloadJSON: string;
}>;
/** Selected metadata continuity only; neither a download nor file-retirement permission. */
export type NativeAttachmentDraftAvailabilityInput = Readonly<{
    version: 1; taskID: string; requestId: string; attachmentId: string; identity: string;
    beforePayloadJSON: string; status: 'available' | 'unrecoverable'; resolvedAttachmentJSON: string;
}>;
export type NativeAttachmentDraftAvailabilityPrepared = NativeAttachmentDraftAvailabilityInput & Readonly<{
    kind: 'prepared-file-availability'; afterPayloadJSON: string;
}>;
export type NativeAttachmentDraftOperationV3 = Readonly<
    { kind: 'add'; operation: NativeAttachmentDraftPrepared }
    | { kind: 'remove'; operation: NativeAttachmentDraftRemovePrepared }
>;
export type NativeAttachmentDraftLineageInputV3 = {
    version: 3; taskID: string; initialPayloadJSON: string; beforePayloadJSON: string;
    priorOperations: readonly NativeAttachmentDraftOperationV3[]; managedDirectoryURI: string;
};
export type NativeAttachmentDraftPrepareInputV3 = NativeAttachmentDraftLineageInputV3 & {
    requestId: string; picked: NativeAttachmentDraftPicked; measuredSize: number;
};
export type NativeAttachmentDraftRemoveInputV3 = NativeAttachmentDraftLineageInputV3 & {
    requestId: string; attachmentId: string;
};
export type NativeAttachmentDraftLineageV3 = Omit<NativeAttachmentDraftLineage, 'version'> & { version: 3 };
export type NativeAttachmentDraftHashedFile = NativeAttachmentDraftFile & Readonly<{ fileHash: string }>;
export type NativeAttachmentDraftPreparedV2 = Omit<NativeAttachmentDraftPrepared, 'version' | 'prepared' | 'attachment'> & Readonly<{
    version: 2; sourceSha256: string; prepared: Readonly<{ kind: 'prepared'; attachment: NativeAttachmentDraftHashedFile }>;
    attachment: NativeAttachmentDraftHashedFile;
}>;
export type NativeAttachmentDraftOperationV4 = Readonly<
    { kind: 'add'; operation: NativeAttachmentDraftPreparedV2 }
    | { kind: 'remove'; operation: NativeAttachmentDraftRemovePrepared }
>;
export type NativeAttachmentDraftLineageInputV4 = Omit<NativeAttachmentDraftLineageInputV3, 'version' | 'priorOperations'> & {
    version: 4; priorOperations: readonly NativeAttachmentDraftOperationV4[];
};
export type NativeAttachmentDraftLineageV4 = Omit<NativeAttachmentDraftLineage, 'version'> & { version: 4 };
export type NativeAttachmentDraftAddedV2 = Omit<NativeAttachmentDraftAdded, 'version' | 'attachment'> & Readonly<{
    version: 2; attachment: NativeAttachmentDraftHashedFile;
}>;
type MixedLineage = NativeAttachmentDraftLineageInputV3 | NativeAttachmentDraftLineageInputV4;
type FrozenAdd = NativeAttachmentDraftPrepared | NativeAttachmentDraftPreparedV2;
export type NativeAttachmentDraftRefusal = { kind: 'refused'; message: string };
export type NativeAttachmentDraftCompleteInput = { prepared: NativeAttachmentDraftPrepared };
export type NativeAttachmentDraftAdded = Readonly<{
    version: 1; kind: 'added'; taskID: string; requestId: string;
    afterPayloadJSON: string; attachment: NativeAttachmentDraftFile;
}>;

const PAYLOAD_BYTES = 1_000_000;
const PREPARED_BYTES = 2 * 1024 * 1024;
const PREPARE_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const PREPARED_FIELDS = ['version', 'kind', 'taskID', 'requestId', 'picked', 'measuredSize',
    'managedDirectoryURI', 'beforePayloadJSON', 'afterPayloadJSON', 'prepared', 'targetURI', 'attachment'];
const FILE_FIELDS = ['id', 'kind', 'title', 'uri', 'size', 'createdAt', 'updatedAt', 'localStatus'];
const invalid = (): never => { throw new Error('INVALID_INPUT'); };
const record = (value: unknown): value is Record<string, unknown> => (
    value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
);
const own = (value: object, field: string): boolean => Object.prototype.hasOwnProperty.call(value, field);
const exact = (value: unknown, fields: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> => (
    record(value) && fields.every((field) => own(value, field))
    && Reflect.ownKeys(value).every((field) => {
        if (typeof field !== 'string' || !fields.includes(field) && !optional.includes(field)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, field);
        return Boolean(descriptor?.enumerable && own(descriptor, 'value'));
    })
);

// Works on native JS engines without requiring a TextEncoder host capability.
const utf8Bytes = (text: string, limit = Number.MAX_SAFE_INTEGER): number => {
    let bytes = 0;
    for (let index = 0; index < text.length; index++) {
        const unit = text.charCodeAt(index);
        if (unit < 0x80) bytes++;
        else if (unit < 0x800) bytes += 2;
        else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length
            && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
            bytes += 4; index++;
        } else bytes += 3;
        if (bytes > limit) return bytes;
    }
    return bytes;
};
const text = (value: unknown, bytes: number, nonempty = false): string => {
    if (typeof value !== 'string' || value.length > bytes || utf8Bytes(value, bytes) > bytes || nonempty && !value) invalid();
    return value as string;
};
const size = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
    return value as number;
};
const requestID = (value: unknown): string => {
    if (typeof value !== 'string' || !UUID.test(value)) invalid();
    return value as string;
};
const jsonBytes = (value: unknown, limit: number): number => {
    try {
        const encoded = JSON.stringify(value);
        if (typeof encoded !== 'string') invalid();
        const bytes = utf8Bytes(encoded, limit);
        if (bytes > limit) invalid();
        return bytes;
    } catch { return invalid(); }
};
const same = (left: unknown, right: unknown): boolean => {
    try { return taskEditValuesEqual(left, right); } catch { return false; }
};
const fileURI = (value: unknown, directory = false): string => {
    const uri = text(value, 16 * 1024, true);
    // URL parsers may silently discard ASCII whitespace/control units.
    for (let index = 0; index < uri.length; index++) {
        if (uri.charCodeAt(index) <= 32 || uri.charCodeAt(index) === 127) invalid();
    }
    try {
        const parsed = new URL(uri);
        const path = decodeURIComponent(uri.slice('file://'.length));
        if (!uri.startsWith('file:///') || parsed.protocol !== 'file:' || parsed.host || parsed.username || parsed.password
            || /[?#\\]/.test(uri) || path.includes('\\') || path.includes('\0')
            || !path.startsWith('/') || path.split('/').some((part) => part === '.' || part === '..')
            || directory && !uri.endsWith('/')) invalid();
    } catch { return invalid(); }
    return uri;
};
const picked = (value: unknown): NativeAttachmentDraftPicked => {
    if (!exact(value, ['uri', 'name', 'mimeType', 'size'])) invalid();
    const input = value as Record<string, unknown>;
    if (input.name !== null && (typeof input.name !== 'string' || input.name.length > 100_000)
        || input.mimeType !== null && (typeof input.mimeType !== 'string' || input.mimeType.length > 500)
        || input.size !== null && (typeof input.size !== 'number' || !Number.isFinite(input.size) || input.size < 0)) invalid();
    return Object.freeze({ uri: fileURI(input.uri), name: input.name as string | null,
        mimeType: input.mimeType as string | null, size: input.size as number | null });
};
const sha256 = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) invalid();
    return value as string;
};
const attachment = (value: unknown, hashed = false): NativeAttachmentDraftFile | NativeAttachmentDraftHashedFile => {
    if (!exact(value, hashed ? [...FILE_FIELDS, 'fileHash'] : FILE_FIELDS, ['mimeType'])) invalid();
    const input = value as Record<string, unknown>;
    const id = requestID(input.id), uri = fileURI(input.uri);
    if (input.kind !== 'file' || typeof input.title !== 'string' || input.title.length > 100_000
        || input.localStatus !== 'available' || own(input, 'mimeType') && (typeof input.mimeType !== 'string' || input.mimeType.length > 500)
        || typeof input.createdAt !== 'string' || input.createdAt.length > 100 || input.createdAt !== input.updatedAt) invalid();
    const createdAt = input.createdAt as string;
    try { if (new Date(createdAt).toISOString() !== createdAt) invalid(); } catch { return invalid(); }
    const file: NativeAttachmentDraftFile = Object.freeze({ id, kind: 'file', title: input.title as string, uri,
        ...(own(input, 'mimeType') ? { mimeType: input.mimeType as string } : {}), size: size(input.size),
        createdAt, updatedAt: createdAt, localStatus: 'available',
        ...(hashed ? { fileHash: sha256(input.fileHash) } : {}) });
    if (!readNativeAttachments([file])) invalid();
    return file;
};
const payload = (encoded: unknown, taskID: string): { object: Record<string, unknown>; attachments: Attachment[] } => {
    const bounded = text(encoded, PAYLOAD_BYTES, true);
    let value: unknown;
    try {
        value = JSON.parse(bounded, (_field, entry: unknown) => {
            // Overflowing JSON numbers would otherwise stringify as null and
            // change an unrelated editor field during attachment projection.
            if (typeof entry === 'number' && !Number.isFinite(entry)) invalid();
            return entry;
        });
    } catch { return invalid(); }
    if (!record(value) || value.version !== 2 || value.taskID !== taskID || value.attachmentsOwned !== true
        || !readNativeAttachments(value.attachmentsBase)) invalid();
    const object = value as Record<string, unknown>;
    const attachments = readNativeAttachments(object.attachments);
    if (!attachments) invalid();
    return { object, attachments: attachments! };
};
const initialPayload = (encoded: unknown, taskID: string): void => {
    const before = payload(encoded, taskID);
    if (!readNativeTaskLinkHalf({ base: before.object.attachmentsBase, value: before.attachments }, false)) invalid();
};

/** Capture bounded scalar proof fields before parsing payloads or awaiting shared policy. */
const frozenShape = (value: unknown, version: 1 | 2 = 1): FrozenAdd => {
    if (!exact(value, version === 2 ? [...PREPARED_FIELDS, 'sourceSha256'] : PREPARED_FIELDS)) invalid();
    const input = value as Record<string, unknown>;
    if (input.version !== version || input.kind !== 'prepared' || !exact(input.prepared, ['kind', 'attachment'])
        || input.prepared.kind !== 'prepared') invalid();
    const prepared = Object.freeze({ kind: 'prepared' as const,
        attachment: attachment((input.prepared as Record<string, unknown>).attachment, version === 2) });
    const result = Object.freeze({ version, kind: 'prepared' as const,
        taskID: text(input.taskID, 500, true), requestId: requestID(input.requestId), picked: picked(input.picked),
        measuredSize: size(input.measuredSize), managedDirectoryURI: fileURI(input.managedDirectoryURI, true),
        beforePayloadJSON: text(input.beforePayloadJSON, PAYLOAD_BYTES, true),
        afterPayloadJSON: text(input.afterPayloadJSON, PAYLOAD_BYTES, true), prepared,
        targetURI: fileURI(input.targetURI), attachment: attachment(input.attachment, version === 2),
        ...(version === 2 ? { sourceSha256: sha256(input.sourceSha256) } : {}) }) as FrozenAdd;
    jsonBytes(result, PREPARED_BYTES);
    return result;
};
const validateFrozen = (value: FrozenAdd): void => {
    const source = value.prepared.attachment;
    if (value.version === 2 && (value.prepared.attachment.fileHash !== value.sourceSha256
        || value.attachment.fileHash !== value.sourceSha256)) invalid();
    if (source.id !== value.requestId || source.title !== (value.picked.name || 'file') || source.uri !== value.picked.uri
        || source.mimeType !== (value.picked.mimeType ?? undefined) || source.size !== value.measuredSize
        || value.targetURI !== value.managedDirectoryURI + getManagedAttachmentFileName(source)
        || !same(value.attachment, { ...source, uri: value.targetURI, size: value.measuredSize, localStatus: 'available' })) invalid();
    const before = payload(value.beforePayloadJSON, value.taskID), after = payload(value.afterPayloadJSON, value.taskID);
    if (before.attachments.length >= 1_000 || before.attachments.some((item) => item.id === value.requestId)
        || !same(after.object, { ...before.object, attachments: [...before.attachments, value.attachment] })) invalid();
};

/** Internal structural reader; no current policy, IO or publication authority. */
export function readNativeAttachmentDraftFrozen(input: unknown): NativeAttachmentDraftPrepared {
    const captured = frozenShape(input) as NativeAttachmentDraftPrepared;
    validateFrozen(captured);
    return captured;
}

export function readNativeAttachmentDraftFrozenV2(input: unknown): NativeAttachmentDraftPreparedV2 {
    const captured = frozenShape(input, 2) as NativeAttachmentDraftPreparedV2;
    validateFrozen(captured);
    return captured;
}

/** Internal attachment projection reader. Opaque editor fields remain untouched. */
export function readNativeAttachmentDraftPayload(input: unknown, taskID: string): {
    baselineAttachments: Attachment[]; attachments: Attachment[];
} {
    const captured = payload(input, taskID);
    return { baselineAttachments: readNativeAttachments(captured.object.attachmentsBase)!,
        attachments: captured.attachments };
}

type CapturedLineage = Omit<NativeAttachmentDraftLineageInput, 'version'> & { version: 1 | 2 };
const captureLineage = (object: Record<string, unknown>, additionalFields: object = {}, version: 1 | 2 = 1): CapturedLineage => {
    if (object.version !== version || !Array.isArray(object.priorAdditions) || object.priorAdditions.length > 128) invalid();
    const additions = object.priorAdditions as unknown[];
    if (Reflect.ownKeys(additions).length !== additions.length + 1) invalid();
    const captured = { version, taskID: text(object.taskID, 500, true),
        initialPayloadJSON: text(object.initialPayloadJSON, PAYLOAD_BYTES, true),
        beforePayloadJSON: text(object.beforePayloadJSON, PAYLOAD_BYTES, true), priorAdditions: [] as NativeAttachmentDraftPrepared[],
        managedDirectoryURI: fileURI(object.managedDirectoryURI, true) };
    // Bound each record before measuring the aggregate. Prepare supplies its
    // already bounded new-operation fields so the same 8 MiB total applies.
    let encodedBytes = jsonBytes({ ...captured, ...additionalFields }, PREPARE_BYTES);
    for (let index = 0; index < additions.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(additions, String(index));
        if (!descriptor?.enumerable || !own(descriptor, 'value')) invalid();
        const copy = frozenShape(descriptor!.value) as NativeAttachmentDraftPrepared;
        encodedBytes += jsonBytes(copy, PREPARED_BYTES) + (captured.priorAdditions.length ? 1 : 0);
        if (encodedBytes > PREPARE_BYTES) invalid();
        captured.priorAdditions.push(copy);
    }
    return captured;
};
const validateLineage = (captured: CapturedLineage): Set<string> => {
    initialPayload(captured.initialPayloadJSON, captured.taskID);
    let previous = captured.initialPayloadJSON;
    const ids = new Set<string>();
    for (const prior of captured.priorAdditions) {
        validateFrozen(prior);
        if (prior.taskID !== captured.taskID || prior.managedDirectoryURI !== captured.managedDirectoryURI
            || prior.beforePayloadJSON !== previous || ids.has(prior.requestId)) invalid();
        ids.add(prior.requestId); previous = prior.afterPayloadJSON;
    }
    if (captured.beforePayloadJSON !== previous) invalid();
    return ids;
};

// Only the v2 entry points select projection continuity. Every operation still
// retains its complete frozen before/after bytes; ordinary editor changes
// between operations grant neither Save permission nor filesystem authority.
const validateLineageV2 = (captured: CapturedLineage): Set<string> => {
    initialPayload(captured.initialPayloadJSON, captured.taskID);
    const initial = payload(captured.initialPayloadJSON, captured.taskID);
    if (!same(initial.object.attachmentsBase, initial.attachments)) invalid();
    let previous = initial.attachments;
    const ids = new Set<string>();
    for (const prior of captured.priorAdditions) {
        validateFrozen(prior);
        const before = payload(prior.beforePayloadJSON, captured.taskID);
        if (prior.taskID !== captured.taskID || prior.managedDirectoryURI !== captured.managedDirectoryURI
            || ids.has(prior.requestId) || !same(before.object.attachmentsBase, initial.object.attachmentsBase)
            || !same(before.attachments, previous)) invalid();
        ids.add(prior.requestId);
        previous = payload(prior.afterPayloadJSON, captured.taskID).attachments;
    }
    const latest = payload(captured.beforePayloadJSON, captured.taskID);
    if (!same(latest.object.attachmentsBase, initial.object.attachmentsBase) || !same(latest.attachments, previous)) invalid();
    return ids;
};

/** Validate retained Add history, including on Discard of a now-readonly task. */
export function validateNativeAttachmentDraftLineage(input: unknown): NativeAttachmentDraftLineage {
    if (!exact(input, ['version', 'taskID', 'initialPayloadJSON', 'beforePayloadJSON', 'priorAdditions', 'managedDirectoryURI'])) invalid();
    const captured = captureLineage(input as Record<string, unknown>);
    validateLineage(captured);
    return Object.freeze({ version: 1, taskID: captured.taskID, payloadJSON: captured.beforePayloadJSON });
}

export function validateNativeAttachmentDraftLineageV2(input: unknown): NativeAttachmentDraftLineageV2 {
    if (!exact(input, ['version', 'taskID', 'initialPayloadJSON', 'beforePayloadJSON', 'priorAdditions', 'managedDirectoryURI'])) invalid();
    const captured = captureLineage(input as Record<string, unknown>, {}, 2);
    validateLineageV2(captured);
    return Object.freeze({ version: 2, taskID: captured.taskID, payloadJSON: captured.beforePayloadJSON });
}

export function validateNativeAttachmentDraftBegin(input: unknown, deps: NativeAttachmentDraftDependencies): NativeAttachmentDraftBegin {
    if (!exact(input, ['taskID', 'payloadJSON'])) invalid();
    const object = input as Record<string, unknown>;
    const taskID = text(object.taskID, 500, true), payloadJSON = text(object.payloadJSON, PAYLOAD_BYTES, true);
    initialPayload(payloadJSON, taskID);
    deps.assertEditable(taskID);
    return Object.freeze({ version: 1, taskID, payloadJSON });
}

export function validateNativeAttachmentDraftBeginV2(input: unknown, deps: NativeAttachmentDraftDependencies): NativeAttachmentDraftLineageV2 {
    if (!exact(input, ['taskID', 'payloadJSON'])) invalid();
    const object = input as Record<string, unknown>;
    const taskID = text(object.taskID, 500, true), payloadJSON = text(object.payloadJSON, PAYLOAD_BYTES, true);
    initialPayload(payloadJSON, taskID);
    const initial = payload(payloadJSON, taskID);
    if (!same(initial.object.attachmentsBase, initial.attachments)) invalid();
    deps.assertEditable(taskID);
    return Object.freeze({ version: 2, taskID, payloadJSON });
}

export function validateNativeAttachmentDraftBeginV3(input: unknown, deps: NativeAttachmentDraftDependencies): NativeAttachmentDraftLineageV3 {
    if (!exact(input, ['taskID', 'payloadJSON'])) invalid();
    const object = input as Record<string, unknown>;
    const taskID = text(object.taskID, 500, true), payloadJSON = text(object.payloadJSON, PAYLOAD_BYTES, true);
    const initial = payloadV3(payloadJSON, taskID);
    if (!linkOnlyGapV3(initial.object.attachmentsBase, initial.attachments)) invalid();
    deps.assertEditable(taskID);
    return Object.freeze({ version: 3, taskID, payloadJSON });
}

export async function prepareNativeAttachmentDraftAdd(input: unknown, deps: NativeAttachmentDraftDependencies):
Promise<NativeAttachmentDraftPrepared | NativeAttachmentDraftRefusal> {
    return prepareDraftAdd(input, deps, 1);
}

export async function prepareNativeAttachmentDraftAddV2(input: unknown, deps: NativeAttachmentDraftDependencies):
Promise<NativeAttachmentDraftPrepared | NativeAttachmentDraftRefusal> {
    return prepareDraftAdd(input, deps, 2);
}

async function prepareDraftAdd(input: unknown, deps: NativeAttachmentDraftDependencies, version: 1 | 2):
Promise<NativeAttachmentDraftPrepared | NativeAttachmentDraftRefusal> {
    if (!exact(input, ['version', 'taskID', 'initialPayloadJSON', 'beforePayloadJSON', 'priorAdditions',
        'requestId', 'picked', 'measuredSize', 'managedDirectoryURI'])) invalid();
    const object = input as Record<string, unknown>;
    const additionalFields = { requestId: requestID(object.requestId), picked: picked(object.picked), measuredSize: size(object.measuredSize) };
    const captured = { ...captureLineage(object, additionalFields, version), ...additionalFields };
    if ((version === 1 ? validateLineage(captured) : validateLineageV2(captured)).has(captured.requestId)) invalid();
    return prepareCapturedAdd(captured, deps) as Promise<NativeAttachmentDraftPrepared | NativeAttachmentDraftRefusal>;
}

// Both sealed legacy and mixed histories use the same picked-file policy and metadata producer.
async function prepareCapturedAdd(captured: { taskID: string; beforePayloadJSON: string; requestId: string;
    picked: NativeAttachmentDraftPicked; measuredSize: number; managedDirectoryURI: string; sourceSha256?: string },
    deps: NativeAttachmentDraftDependencies): Promise<FrozenAdd | NativeAttachmentDraftRefusal> {
    const before = payload(captured.beforePayloadJSON, captured.taskID);
    if (before.attachments.length >= 1_000 || before.attachments.some((item) => item.id === captured.requestId)) invalid();
    const { assertEditable, t } = deps;
    assertEditable(captured.taskID);
    const result = await preparePickedAttachment({ source: 'file', asset: { ...captured.picked, size: captured.measuredSize },
        newId: () => captured.requestId, t });
    assertEditable(captured.taskID);
    if (result.kind === 'refused') return result;
    // RN's optional undefined MIME field is absent in the durable JSON record.
    const preparedAttachment = { ...result.attachment };
    if (preparedAttachment.mimeType === undefined) delete preparedAttachment.mimeType;
    const hashed = captured.sourceSha256 !== undefined;
    const prepared = Object.freeze({ kind: 'prepared' as const, attachment: attachment({ ...preparedAttachment,
        ...(hashed ? { fileHash: captured.sourceSha256 } : {}) }, hashed) });
    const targetURI = captured.managedDirectoryURI + getManagedAttachmentFileName(prepared.attachment);
    fileURI(targetURI);
    if (targetURI === captured.picked.uri) return { kind: 'refused', message: t('attachments.fileNotReadable') };
    const completed = attachment({ ...prepared.attachment, uri: targetURI, size: captured.measuredSize, localStatus: 'available' }, hashed);
    let afterPayloadJSON: string;
    try { afterPayloadJSON = JSON.stringify({ ...before.object, attachments: [...before.attachments, completed] }); }
    catch { return invalid(); }
    text(afterPayloadJSON, PAYLOAD_BYTES, true);
    const frozen = Object.freeze({ version: hashed ? 2 : 1, kind: 'prepared', taskID: captured.taskID,
        requestId: captured.requestId, picked: captured.picked, measuredSize: captured.measuredSize,
        managedDirectoryURI: captured.managedDirectoryURI, beforePayloadJSON: captured.beforePayloadJSON,
        afterPayloadJSON, prepared, targetURI, attachment: completed,
        ...(hashed ? { sourceSha256: captured.sourceSha256 } : {}) }) as FrozenAdd;
    jsonBytes(frozen, PREPARED_BYTES);
    return frozen;
}

/** Call only after native publication proof. This projection neither copies nor owns bytes. */
export async function completeNativeAttachmentDraftAdd(input: unknown, deps: NativeAttachmentDraftDependencies):
Promise<NativeAttachmentDraftAdded | NativeAttachmentDraftRefusal> {
    return completeDraftAdd(input, deps, 1) as Promise<NativeAttachmentDraftAdded | NativeAttachmentDraftRefusal>;
}

export async function completeNativeAttachmentDraftAddV4(input: unknown, deps: NativeAttachmentDraftDependencies):
Promise<NativeAttachmentDraftAddedV2 | NativeAttachmentDraftRefusal> {
    return completeDraftAdd(input, deps, 2) as Promise<NativeAttachmentDraftAddedV2 | NativeAttachmentDraftRefusal>;
}

async function completeDraftAdd(input: unknown, deps: NativeAttachmentDraftDependencies, version: 1 | 2):
Promise<NativeAttachmentDraftAdded | NativeAttachmentDraftAddedV2 | NativeAttachmentDraftRefusal> {
    if (!exact(input, ['prepared'])) invalid();
    const frozen = frozenShape((input as Record<string, unknown>).prepared, version);
    validateFrozen(frozen);
    const { assertEditable, t } = deps;
    assertEditable(frozen.taskID);
    // Historical additions are structurally preserved; only the current
    // completion rechecks shared upload policy without generating metadata.
    const validation = await validateAttachmentForUpload(frozen.prepared.attachment, frozen.measuredSize);
    assertEditable(frozen.taskID);
    if (!validation.valid) invalid();
    const result = await persistPreparedPickedAttachment({ prepared: frozen.prepared,
        persist: async () => ({ ...frozen.attachment }), t });
    assertEditable(frozen.taskID);
    if (result.kind === 'refused') return result;
    return Object.freeze({ version, kind: 'added', taskID: frozen.taskID, requestId: frozen.requestId,
        afterPayloadJSON: frozen.afterPayloadJSON, attachment: frozen.attachment }) as NativeAttachmentDraftAdded | NativeAttachmentDraftAddedV2;
}


const requestIDV3 = (value: unknown): string => {
    if (typeof value !== 'string' || value.length !== 36) invalid();
    return requestID(value);
};
const attachmentIDV3 = (value: unknown): string => {
    // readNativeAttachments bounds IDs by UTF-16 length, not UTF-8 bytes.
    if (typeof value !== 'string' || !value || value.length > 500) invalid();
    return value as string;
};
const REMOVE_FIELDS = ['version', 'kind', 'taskID', 'requestId', 'attachmentId', 'removedAt',
    'beforePayloadJSON', 'afterPayloadJSON'];
const LINEAGE_V3_FIELDS = ['version', 'taskID', 'initialPayloadJSON', 'beforePayloadJSON',
    'priorOperations', 'managedDirectoryURI'];

// V3 inspects only parsed JSON: no caller getters, toJSON or custom prototypes can run.
const payloadV3 = (encoded: unknown, taskID: string): ReturnType<typeof payload> => {
    const value = payload(encoded, taskID);
    let nodes = 0;
    const visit = (entry: unknown, depth: number): void => {
        if (++nodes > 100_000 || depth > 64) invalid();
        if (entry !== null && typeof entry === 'object') {
            for (const key of Object.keys(entry)) {
                if (key === '__proto__' || key === 'prototype' || key === 'constructor') invalid();
                visit((entry as Record<string, unknown>)[key], depth + 1);
            }
        }
    };
    visit(value.object, 0);
    return value;
};
// Ordinary links may change at V3 gaps; every file field and its order stay frozen.
const linkOnlyGapV3 = (base: unknown, value: Attachment[]): boolean => {
    const half = readNativeTaskLinkHalf({ base, value }, false);
    return half !== null && same(half.base.filter((item) => item.kind === 'file'),
        half.value.filter((item) => item.kind === 'file'));
};
const removeShape = (value: unknown): NativeAttachmentDraftRemovePrepared => {
    if (!exact(value, REMOVE_FIELDS)) invalid();
    const input = value as Record<string, unknown>;
    if (input.version !== 1 || input.kind !== 'prepared-file-remove') invalid();
    const removedAt = text(input.removedAt, 100, true);
    try { if (new Date(removedAt).toISOString() !== removedAt) invalid(); } catch { return invalid(); }
    const captured: NativeAttachmentDraftRemovePrepared = Object.freeze({ version: 1, kind: 'prepared-file-remove',
        taskID: text(input.taskID, 500, true), requestId: requestIDV3(input.requestId),
        attachmentId: attachmentIDV3(input.attachmentId), removedAt,
        beforePayloadJSON: text(input.beforePayloadJSON, PAYLOAD_BYTES, true),
        afterPayloadJSON: text(input.afterPayloadJSON, PAYLOAD_BYTES, true) });
    jsonBytes(captured, PREPARED_BYTES);
    return captured;
};
const validateRemoveFrozen = (value: NativeAttachmentDraftRemovePrepared): void => {
    const before = payloadV3(value.beforePayloadJSON, value.taskID), after = payloadV3(value.afterPayloadJSON, value.taskID);
    const selected = before.attachments.find((item) => item.id === value.attachmentId);
    if (!selected || selected.kind !== 'file' || selected.deletedAt
        || !same(after.object, { ...before.object,
            attachments: softDeleteAttachment(before.attachments, value.attachmentId, value.removedAt) })) invalid();
};

/** Pure historical projection, not a claim that any file was copied or is owned. */
export function readNativeAttachmentDraftRemoveFrozen(input: unknown): NativeAttachmentDraftRemovePrepared {
    const captured = removeShape(input);
    validateRemoveFrozen(captured);
    return captured;
}

const captureLineageV3 = (object: Record<string, unknown>, additionalFields: object = {}, version: 3 | 4 = 3): MixedLineage => {
    const operations = object.priorOperations;
    if (object.version !== version || !Array.isArray(operations) || Object.getPrototypeOf(operations) !== Array.prototype
        || operations.length > 128 || Reflect.ownKeys(operations).length !== operations.length + 1) invalid();
    const captured = { version, taskID: text(object.taskID, 500, true),
        initialPayloadJSON: text(object.initialPayloadJSON, PAYLOAD_BYTES, true),
        beforePayloadJSON: text(object.beforePayloadJSON, PAYLOAD_BYTES, true),
        managedDirectoryURI: fileURI(object.managedDirectoryURI, true), priorOperations: [] };
    const copied: (NativeAttachmentDraftOperationV3 | NativeAttachmentDraftOperationV4)[] = [];
    let bytes = jsonBytes({ ...captured, ...additionalFields }, PREPARE_BYTES);
    for (let index = 0; index < (operations as unknown[]).length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(operations, String(index));
        if (!descriptor?.enumerable || !own(descriptor, 'value') || !exact(descriptor.value, ['kind', 'operation'])) invalid();
        const entry = descriptor!.value as Record<string, unknown>;
        const operation = entry.kind === 'add'
            ? Object.freeze({ kind: 'add' as const, operation: frozenShape(entry.operation, version === 4 ? 2 : 1) })
            : entry.kind === 'remove' ? Object.freeze({ kind: 'remove', operation: removeShape(entry.operation) }) : invalid();
        bytes += jsonBytes(operation, PREPARED_BYTES) + (index ? 1 : 0);
        if (bytes > PREPARE_BYTES) invalid();
        copied.push(operation as NativeAttachmentDraftOperationV3 | NativeAttachmentDraftOperationV4);
    }
    return { ...captured, priorOperations: Object.freeze(copied) } as MixedLineage;
};
const validateLineageV3 = (captured: MixedLineage): Set<string> => {
    const initial = payloadV3(captured.initialPayloadJSON, captured.taskID);
    if (!linkOnlyGapV3(initial.object.attachmentsBase, initial.attachments)) invalid();
    let previous = initial.attachments;
    const ids = new Set<string>();
    for (const entry of captured.priorOperations) {
        const prior = entry.operation;
        requestIDV3(prior.requestId);
        const before = payloadV3(prior.beforePayloadJSON, captured.taskID);
        if (prior.taskID !== captured.taskID || ids.has(prior.requestId)
            || !same(before.object.attachmentsBase, initial.object.attachmentsBase) || !linkOnlyGapV3(previous, before.attachments)) invalid();
        if (entry.kind === 'add') {
            validateFrozen(entry.operation);
            if (entry.operation.managedDirectoryURI !== captured.managedDirectoryURI) invalid();
        } else validateRemoveFrozen(entry.operation);
        ids.add(prior.requestId);
        previous = payloadV3(prior.afterPayloadJSON, captured.taskID).attachments;
    }
    const latest = payloadV3(captured.beforePayloadJSON, captured.taskID);
    if (!same(latest.object.attachmentsBase, initial.object.attachmentsBase) || !linkOnlyGapV3(previous, latest.attachments)) invalid();
    return ids;
};

export function validateNativeAttachmentDraftLineageV3(input: unknown): NativeAttachmentDraftLineageV3 {
    if (!exact(input, LINEAGE_V3_FIELDS)) invalid();
    const captured = captureLineageV3(input as Record<string, unknown>);
    validateLineageV3(captured);
    return Object.freeze({ version: 3, taskID: captured.taskID, payloadJSON: captured.beforePayloadJSON });
}

export async function prepareNativeAttachmentDraftAddV3(input: unknown, deps: NativeAttachmentDraftDependencies):
Promise<NativeAttachmentDraftPrepared | NativeAttachmentDraftRefusal> {
    if (!exact(input, [...LINEAGE_V3_FIELDS, 'requestId', 'picked', 'measuredSize'])) invalid();
    const object = input as Record<string, unknown>;
    const fields = { requestId: requestIDV3(object.requestId), picked: picked(object.picked), measuredSize: size(object.measuredSize) };
    const captured = { ...captureLineageV3(object, fields), ...fields };
    if (captured.priorOperations.length >= 128 || validateLineageV3(captured).has(captured.requestId)) invalid();
    return prepareCapturedAdd(captured, deps) as Promise<NativeAttachmentDraftPrepared | NativeAttachmentDraftRefusal>;
}

export function prepareNativeAttachmentDraftRemoveV3(input: unknown, deps: NativeAttachmentDraftDependencies): NativeAttachmentDraftRemovePrepared {
    if (!exact(input, [...LINEAGE_V3_FIELDS, 'requestId', 'attachmentId'])) invalid();
    const object = input as Record<string, unknown>;
    const fields = { requestId: requestIDV3(object.requestId), attachmentId: attachmentIDV3(object.attachmentId) };
    const captured = { ...captureLineageV3(object, fields), ...fields };
    if (captured.priorOperations.length >= 128 || validateLineageV3(captured).has(captured.requestId)) invalid();
    return prepareCapturedRemove(captured, deps);
}

function prepareCapturedRemove(captured: MixedLineage & { requestId: string; attachmentId: string },
    deps: NativeAttachmentDraftDependencies): NativeAttachmentDraftRemovePrepared {
    const before = payloadV3(captured.beforePayloadJSON, captured.taskID);
    const selected = before.attachments.find((item) => item.id === captured.attachmentId);
    if (!selected || selected.kind !== 'file' || selected.deletedAt) invalid();
    const { assertEditable } = deps;
    assertEditable(captured.taskID);
    const removedAt = new Date().toISOString();
    const afterPayloadJSON = JSON.stringify({ ...before.object,
        attachments: softDeleteAttachment(before.attachments, captured.attachmentId, removedAt) });
    const frozen = readNativeAttachmentDraftRemoveFrozen({ version: 1, kind: 'prepared-file-remove', taskID: captured.taskID,
        requestId: captured.requestId, attachmentId: captured.attachmentId, removedAt,
        beforePayloadJSON: captured.beforePayloadJSON, afterPayloadJSON });
    assertEditable(captured.taskID);
    return frozen;
}

/** Selected hash-bearing history. Historical V3 and Add1 readers remain sealed. */
export function validateNativeAttachmentDraftBeginV4(input: unknown, deps: NativeAttachmentDraftDependencies): NativeAttachmentDraftLineageV4 {
    const begin = validateNativeAttachmentDraftBeginV3(input, deps);
    return Object.freeze({ ...begin, version: 4 });
}
export function validateNativeAttachmentDraftLineageV4(input: unknown): NativeAttachmentDraftLineageV4 {
    if (!exact(input, LINEAGE_V3_FIELDS)) invalid();
    const captured = captureLineageV3(input as Record<string, unknown>, {}, 4);
    validateLineageV3(captured);
    return Object.freeze({ version: 4, taskID: captured.taskID, payloadJSON: captured.beforePayloadJSON });
}
export async function prepareNativeAttachmentDraftAddV4(input: unknown, deps: NativeAttachmentDraftDependencies):
Promise<NativeAttachmentDraftPreparedV2 | NativeAttachmentDraftRefusal> {
    if (!exact(input, [...LINEAGE_V3_FIELDS, 'requestId', 'picked', 'measuredSize', 'sourceSha256'])) invalid();
    const object = input as Record<string, unknown>;
    const fields = { requestId: requestIDV3(object.requestId), picked: picked(object.picked),
        measuredSize: size(object.measuredSize), sourceSha256: sha256(object.sourceSha256) };
    const captured = { ...captureLineageV3(object, fields, 4), ...fields };
    if (captured.priorOperations.length >= 128 || validateLineageV3(captured).has(captured.requestId)) invalid();
    return prepareCapturedAdd(captured, deps) as Promise<NativeAttachmentDraftPreparedV2 | NativeAttachmentDraftRefusal>;
}
export function prepareNativeAttachmentDraftRemoveV4(input: unknown, deps: NativeAttachmentDraftDependencies): NativeAttachmentDraftRemovePrepared {
    if (!exact(input, [...LINEAGE_V3_FIELDS, 'requestId', 'attachmentId'])) invalid();
    const object = input as Record<string, unknown>;
    const fields = { requestId: requestIDV3(object.requestId), attachmentId: attachmentIDV3(object.attachmentId) };
    const captured = { ...captureLineageV3(object, fields, 4), ...fields };
    if (captured.priorOperations.length >= 128 || validateLineageV3(captured).has(captured.requestId)) invalid();
    return prepareCapturedRemove(captured, deps);
}

const AVAILABILITY_FIELDS = ['version', 'taskID', 'requestId', 'attachmentId', 'identity',
    'beforePayloadJSON', 'status', 'resolvedAttachmentJSON'];
const availabilityShape = (value: unknown, frozen: boolean): NativeAttachmentDraftAvailabilityInput => {
    if (!exact(value, frozen ? [...AVAILABILITY_FIELDS, 'kind', 'afterPayloadJSON'] : AVAILABILITY_FIELDS)) invalid();
    const input = value as Record<string, unknown>;
    if (input.version !== 1 || input.status !== 'available' && input.status !== 'unrecoverable'
        || frozen && input.kind !== 'prepared-file-availability') invalid();
    return Object.freeze({ version: 1, taskID: text(input.taskID, 500, true), requestId: requestIDV3(input.requestId),
        attachmentId: attachmentIDV3(input.attachmentId), identity: text(input.identity, PAYLOAD_BYTES, true),
        beforePayloadJSON: text(input.beforePayloadJSON, PAYLOAD_BYTES, true), status: input.status,
        resolvedAttachmentJSON: text(input.resolvedAttachmentJSON, PAYLOAD_BYTES, true) }) as NativeAttachmentDraftAvailabilityInput;
};
const availabilityAfterPayload = (captured: NativeAttachmentDraftAvailabilityInput): string => {
    const before = payloadV3(captured.beforePayloadJSON, captured.taskID);
    const current = before.attachments.find((item) => item.id === captured.attachmentId) ?? invalid();
    if (current.kind !== 'file' || current.deletedAt !== undefined
        || getAttachmentDownloadIdentity(current) !== captured.identity) invalid();
    let value: unknown;
    try { value = JSON.parse(captured.resolvedAttachmentJSON); } catch { return invalid(); }
    const rows = readNativeAttachments([value]);
    if (!rows) invalid();
    const resolved = rows![0];
    if (resolved.kind !== 'file' || resolved.id !== current.id
        || (resolved.contentRev ?? 0) !== (current.contentRev ?? 0)) invalid();
    if (captured.status === 'available') {
        if (resolved.deletedAt !== undefined || resolved.localStatus !== 'available'
            || resolved.cloudKey !== current.cloudKey
            || current.fileHash && resolved.fileHash !== current.fileHash
            || !current.fileHash && resolved.fileHash !== undefined && !isSha256Hex(resolved.fileHash)) invalid();
        fileURI(resolved.uri);
    } else {
        if (resolved.cloudKey !== undefined || resolved.fileHash !== undefined || resolved.localStatus !== 'missing'
            || !resolved.deletedAt || resolved.updatedAt !== resolved.deletedAt) invalid();
        try { if (new Date(resolved.deletedAt!).toISOString() !== resolved.deletedAt) invalid(); } catch { return invalid(); }
    }
    const patch = captured.status === 'available'
        ? getAttachmentAvailabilityPatch(current, resolved) : getAttachmentUnrecoverablePatch(resolved);
    // Apply undefined lifecycle fields before JSON encoding; a serialized patch would lose deletions.
    const after = JSON.stringify({ ...before.object, attachments: patchAttachment(before.attachments, current.id, patch) });
    return text(after, PAYLOAD_BYTES, true);
};

/** Pure selected outcome projection. Native must separately prove the resolver and installed generation. */
export function prepareNativeAttachmentDraftAvailability(input: unknown): NativeAttachmentDraftAvailabilityPrepared {
    const captured = availabilityShape(input, false);
    const result = Object.freeze({ ...captured, kind: 'prepared-file-availability' as const,
        afterPayloadJSON: availabilityAfterPayload(captured) });
    jsonBytes(result, PREPARED_BYTES);
    return result;
}

/** Frozen replay never calls current policy, a clock, UUID creation, filesystem or network. */
export function readNativeAttachmentDraftAvailabilityFrozen(input: unknown): NativeAttachmentDraftAvailabilityPrepared {
    const captured = availabilityShape(input, true);
    const afterPayloadJSON = text((input as Record<string, unknown>).afterPayloadJSON, PAYLOAD_BYTES, true);
    const result = Object.freeze({ ...captured, kind: 'prepared-file-availability' as const, afterPayloadJSON });
    jsonBytes(result, PREPARED_BYTES);
    if (afterPayloadJSON !== availabilityAfterPayload(captured)) invalid();
    return result;
}
