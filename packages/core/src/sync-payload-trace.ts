// Formatters for the optional `tracePayload` sync port (sync-run-ports.ts).
// Shared by desktop and mobile so a trace read from either platform's log means
// the same thing. Every string here is ids, field names, counts and
// fingerprints — never task content (#854).
import {
    computeStableValueFingerprint,
    sanitizeAppDataForRemote,
    toStableSyncJson as toStableJson,
} from './sync-helpers';
import type { AppData, AppSettings } from './types';
import type { SyncPayloadTraceEvent } from './sync-run-ports';

/** Payload tracing rides the diagnostics-logging switch on both platforms:
 *  it is verbose and only useful while a user is capturing a sync log. */
export const isSyncPayloadTraceEnabled = (settings: AppSettings | undefined): boolean => (
    settings?.diagnostics?.loggingEnabled === true
);

export const SYNC_TRACE_EVENT_MESSAGES: Record<SyncPayloadTraceEvent, string> = {
    'read-local': 'Sync trace read local payload',
    'read-remote': 'Sync trace read remote payload',
    'write-local': 'Sync trace write local payload',
    'write-remote': 'Sync trace write remote payload',
    'remote-write-completed': 'Sync trace remote write completed',
    'remote-write-skipped-unchanged': 'Sync trace remote write skipped unchanged payload',
    'core-result': 'Sync trace core result payload',
    'post-attachment': 'Sync trace post-attachment payload',
};

const SYNC_TRACE_SURFACES = ['tasks', 'projects', 'sections', 'areas', 'people', 'settings'] as const;
type SyncTraceSurface = typeof SYNC_TRACE_SURFACES[number];

const capitalizeTraceName = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

const getSyncTraceSurfaceValue = (data: AppData, surface: SyncTraceSurface): unknown => {
    if (surface === 'settings') return data.settings ?? {};
    const value = data[surface];
    return Array.isArray(value) ? value : [];
};

type SurfaceSignatures = Record<SyncTraceSurface, string>;

const buildSurfaceSignatures = (sanitized: AppData): SurfaceSignatures => Object.fromEntries(
    SYNC_TRACE_SURFACES.map((surface) => [
        surface,
        computeStableValueFingerprint(getSyncTraceSurfaceValue(sanitized, surface)),
    ]),
) as SurfaceSignatures;

const nameSurfaceSignatures = (
    signatures: SurfaceSignatures,
    prefix: string,
): Record<string, string> => Object.fromEntries(
    SYNC_TRACE_SURFACES.map((surface) => [
        `${prefix}${prefix ? capitalizeTraceName(surface) : surface}Sig`,
        signatures[surface],
    ]),
);

export const buildSyncPayloadSurfaceTraceExtra = (
    data: AppData,
    prefix = '',
): Record<string, string> => nameSurfaceSignatures(
    buildSurfaceSignatures(sanitizeAppDataForRemote(data)),
    prefix,
);

/**
 * #766: each of `fingerprint` and the six surface signatures stringifies and
 * hashes the whole sanitized document, and at 7k tasks the tasks surface alone
 * is ~98% of it. One trace cost ~3.4s on the reporter's device and a sync cycle
 * emits seven of them — about a third of the cycle, spent only while a user is
 * capturing a log, which is exactly when the app already feels slow.
 *
 * So: sanitize once per document instead of twice, and memoize the derived
 * strings on the document's identity, since a cycle re-traces the same object
 * several times (write-remote/remote-write-completed, core-result/post-attachment).
 * Keyed on identity, which is sound because synced documents and entities are
 * replaced, never mutated in place (sync-signatures.ts carries the test teeth for
 * that invariant). Only strings are retained — never the sanitized copy, which is
 * document-sized and would put this device back under memory pressure.
 */
const payloadTraceSignatureCache = new WeakMap<AppData, Record<string, string>>();

const getPayloadTraceSignatures = (data: AppData): Record<string, string> => {
    const cached = payloadTraceSignatureCache.get(data);
    if (cached) return cached;
    // computeStableValueFingerprint of the sanitized document IS
    // computeSyncPayloadFingerprint(data) — same value, one less sanitize pass.
    const sanitized = sanitizeAppDataForRemote(data);
    const signatures = {
        fingerprint: computeStableValueFingerprint(sanitized),
        ...nameSurfaceSignatures(buildSurfaceSignatures(sanitized), ''),
    };
    payloadTraceSignatureCache.set(data, signatures);
    return signatures;
};

export const buildSyncPayloadTraceExtra = (
    data: AppData | null | undefined,
    extra: Record<string, string> = {},
): Record<string, string> => {
    if (!data) {
        return { ...extra, hasData: 'false' };
    }

    const areas = Array.isArray(data.areas) ? data.areas : [];
    const areaIds = areas
        .map((area) => `${area.id}${area.deletedAt ? ':deleted' : ''}`)
        .sort();
    return {
        ...extra,
        hasData: 'true',
        tasks: String(Array.isArray(data.tasks) ? data.tasks.length : 0),
        projects: String(Array.isArray(data.projects) ? data.projects.length : 0),
        sections: String(Array.isArray(data.sections) ? data.sections.length : 0),
        areas: String(areas.length),
        deletedAreas: String(areas.filter((area) => Boolean(area.deletedAt)).length),
        areaIdsSample: areaIds.slice(0, 24).join(','),
        areaIdsTruncated: String(areaIds.length > 24),
        pendingRemoteWrite: String(Boolean(data.settings?.pendingRemoteWriteAt)),
        ...getPayloadTraceSignatures(data),
    };
};

const MAX_TRACE_DIFF_ITEMS = 12;
const MAX_TRACE_DIFF_FIELDS = 16;

const isPlainTraceRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const sanitizeTraceFieldPath = (path: string): string => (
    /(password|token|secret|authorization|api[-_.]?key)/i.test(path) ? '[sensitive]' : path
);

export const collectChangedTracePaths = (
    left: unknown,
    right: unknown,
    prefix = '',
    depth = 0,
): string[] => {
    if (toStableJson(left) === toStableJson(right)) return [];
    if (depth >= 3 || !isPlainTraceRecord(left) || !isPlainTraceRecord(right)) {
        return [sanitizeTraceFieldPath(prefix || '<root>')];
    }
    const names = Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort();
    return names.flatMap((name) => {
        const nextPath = prefix ? `${prefix}.${name}` : name;
        return collectChangedTracePaths(left[name], right[name], nextPath, depth + 1);
    });
};

const getTraceRecordId = (item: Record<string, unknown>, index: number): string => {
    const id = typeof item.id === 'string' && item.id.trim().length > 0 ? item.id : `index-${index}`;
    return id.length > 80 ? `${id.slice(0, 80)}...` : id;
};

export const buildCollectionDiffTraceSample = (left: unknown, right: unknown): string => {
    const leftItems = Array.isArray(left) ? left.filter(isPlainTraceRecord) : [];
    const rightItems = Array.isArray(right) ? right.filter(isPlainTraceRecord) : [];
    const leftById = new Map(leftItems.map((item, index) => [getTraceRecordId(item, index), item] as const));
    const rightById = new Map(rightItems.map((item, index) => [getTraceRecordId(item, index), item] as const));
    const ids = Array.from(new Set([...leftById.keys(), ...rightById.keys()])).sort();
    const parts: string[] = [];

    for (const id of ids) {
        const leftItem = leftById.get(id);
        const rightItem = rightById.get(id);
        if (!leftItem) {
            parts.push(`${id}:onlySynced:${computeStableValueFingerprint(rightItem)}`);
        } else if (!rightItem) {
            parts.push(`${id}:onlyCurrent:${computeStableValueFingerprint(leftItem)}`);
        } else if (toStableJson(leftItem) !== toStableJson(rightItem)) {
            const fields = collectChangedTracePaths(leftItem, rightItem)
                .slice(0, MAX_TRACE_DIFF_FIELDS)
                .join('|');
            parts.push(`${id}:fields=${fields};current=${computeStableValueFingerprint(leftItem)};synced=${computeStableValueFingerprint(rightItem)}`);
        }
        if (parts.length >= MAX_TRACE_DIFF_ITEMS) break;
    }

    return parts.join(';');
};

export const buildSyncPayloadDiffTraceExtra = (currentData: AppData, syncedData: AppData): Record<string, string> => {
    const current = sanitizeAppDataForRemote(currentData);
    const synced = sanitizeAppDataForRemote(syncedData);
    // Same #766 economy: the signatures below already answer "did this surface
    // change", so compare those instead of stringifying every surface a second
    // time (both sides were already sanitized here, too).
    const currentSignatures = buildSurfaceSignatures(current);
    const syncedSignatures = buildSurfaceSignatures(synced);
    const changedSurfaces = SYNC_TRACE_SURFACES.filter(
        (surface) => currentSignatures[surface] !== syncedSignatures[surface],
    );
    const extra: Record<string, string> = {
        surfaceDiffs: changedSurfaces.join(',') || 'none',
        ...Object.fromEntries(SYNC_TRACE_SURFACES.map((surface) => [
            `${surface}Changed`,
            String(changedSurfaces.includes(surface)),
        ])),
        ...nameSurfaceSignatures(currentSignatures, 'current'),
        ...nameSurfaceSignatures(syncedSignatures, 'synced'),
    };

    for (const surface of SYNC_TRACE_SURFACES) {
        if (!changedSurfaces.includes(surface)) continue;
        const currentSurface = getSyncTraceSurfaceValue(current, surface);
        const syncedSurface = getSyncTraceSurfaceValue(synced, surface);
        if (surface === 'settings') {
            extra.settingsPaths = collectChangedTracePaths(currentSurface, syncedSurface)
                .slice(0, MAX_TRACE_DIFF_FIELDS)
                .join(',');
            continue;
        }
        extra[`${surface}Sample`] = buildCollectionDiffTraceSample(currentSurface, syncedSurface);
    }

    return extra;
};
