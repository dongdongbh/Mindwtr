/**
 * CONTRACT: local reads are canonical.
 *
 *     pass(readLocal(x)) === readLocal(x)      byte for byte, on the wire
 *
 * `pass` is the whole-document merge the sync cycle runs against an absent
 * remote; `readLocal` is what the storage codecs hand back after a store write
 * has been persisted. The local-only upload fast path skips that merge
 * (`sync-run.ts`, `io.skipEmptyRemoteMerge`), which is sound only while this
 * holds. Break the contract and the fast path publishes a document the next
 * device's full merge would rewrite — one extra remote write per device per
 * local-only upload (discussion #1001).
 *
 * The three things this file pins:
 *   1. the pass is a fixed point on every document shape (Part 1);
 *   2. every store write action lands a document the pass would not change,
 *      both as the store holds it and as the codecs read it back (Part 2) —
 *      and the action list is taken from the store's own action map, so a new
 *      action fails here until it is covered;
 *   3. skipping the merge reports the same sync stats the merge would (Part 3).
 *
 * The pass measured here is exactly what `performSyncCycleUnlocked` runs when
 * `io.readRemote()` answers nothing (`sync.ts` parses `{}` as the remote).
 * Serialization is the repo's own `toRemoteSyncDocument` + `toStableSyncJson`,
 * the pair behind `areRemoteSyncDocumentsEqual` /
 * `computeRemoteSyncDocumentFingerprint`, which is what decides whether the
 * upload writes at all.
 *
 * Timing is printed, never asserted.
 */
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeAppData, mergeAppDataWithStats, performSyncCycle } from './sync';
import { parseSyncDocument, toRemoteSyncDocument } from './sync-document';
import { purgeExpiredTombstones } from './sync-tombstones';
import { normalizeTaskForSyncMerge, validateMergedSyncData } from './sync-normalization';
import { getMergeComparableSignature, normalizeTaskForContentComparison } from './sync-signatures';
import { createNextRecurringTask } from './recurrence';
import { toStableSyncJson } from './sync-helpers';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { createNativeHostContract } from './native-host-contract';
import { prepareChecklistProjectConversion } from './checklist-project-conversion';
import { readAreaDurableData } from './native-host-contract-area-durable';
import { projectAvailabilityWritePlan, projectFileAvailabilityWritePlan } from './store-projects/project-actions';
import { rawReadProjectSnapshot, rawReadRow } from './sqlite-raw-snapshot';
import { loadNativeRequestReceipts, NativeReceiptSqliteAdapter, resetNativeRequestReceipts, taskRevisionOf } from './native-request-receipts';
import { openScratchSqlite } from './screen-parity.replay';
import { createTaskDraft } from './task-draft';
import { prepareProjectToSection } from './project-to-section';
import { DEFAULT_FOCUS_CONTROL_STATE } from './focus-controls';
import { TASK_SQLITE_COLUMNS, TASK_SYNC_FIELD_SCHEMA, TASK_SYNC_SCHEMA_FIXTURE, taskToSqliteRow } from './task-sync-schema';
import { mapSqliteTaskRow, rawReadTaskSnapshot, SqliteAdapter } from './sqlite-adapter';
import { buildBulkTaskTokenUpdates } from './bulk-task-tokens';
import { PROJECT_SQLITE_COLUMNS, projectFromSqliteRow, projectToSqliteRow } from './project-sync-schema';
import { SECTION_SQLITE_COLUMNS, sectionFromSqliteRow, sectionToSqliteRow } from './section-sync-schema';
import { AREA_SQLITE_COLUMNS, areaFromSqliteRow, areaToSqliteRow } from './area-sync-schema';
import { PERSON_SQLITE_COLUMNS, personFromSqliteRow, personToSqliteRow } from './person-sync-schema';
import type { AppData, Area, Attachment, Person, Project, Section, Task } from './types';

/**
 * The 7,000-task fixture and the timing run only happen under the same flag the
 * repo's other perf work uses (performance-large-store.test.ts), so the default
 * suite stays a fast correctness guard. Set MINDWTR_PERF_TEST=1 to reproduce the
 * cost numbers in the report.
 */
const PERF = process.env.MINDWTR_PERF_TEST === '1';
const LARGE_TASK_COUNT = PERF ? 7_000 : 1_500;

const NOW_ISO = '2026-09-02T12:00:00.000Z';
const BASE_ISO = '2026-06-01T09:00:00.000Z';
const REPORT: string[] = [];

/** Perf numbers are meaningless above loadavg ~8; the report carries the number. */
const readLoadAverage = (): string => {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return (require('node:os').loadavg() as number[]).map((value) => value.toFixed(2)).join(' ');
    } catch {
        return 'unknown';
    }
};

const report = (line: string) => {
    REPORT.push(line);
};

// ---------------------------------------------------------------------------
// The pass under measurement
// ---------------------------------------------------------------------------

/**
 * One local-only upload cycle's document work, minus the network and minus the
 * sync bookkeeping settings (`lastSyncAt`, `lastSyncStats`, `lastSyncHistory`).
 * Those are rewritten every cycle by definition and never reach the wire:
 * `sanitizeSettingsForRemote` (sync-helpers.ts:174) builds an allowlisted
 * object that does not carry them.
 */
const runNormalizePass = (local: AppData, nowIso = NOW_ISO): AppData => {
    const localDocument = parseSyncDocument(local, 'local');
    if (!localDocument.ok) throw new Error(`local parse failed: ${localDocument.errors.join('; ')}`);
    const localData = purgeExpiredTombstones(localDocument.data, nowIso).data;

    const remoteDocument = parseSyncDocument({}, 'remote');
    if (!remoteDocument.ok) throw new Error(`remote parse failed: ${remoteDocument.errors.join('; ')}`);
    const remoteData = purgeExpiredTombstones(remoteDocument.data, nowIso).data;

    const merged = mergeAppDataWithStats(localData, remoteData, { nowIso }).data;
    const pruned = purgeExpiredTombstones(merged, nowIso).data;

    const errors = validateMergedSyncData(pruned);
    if (errors.length > 0) throw new Error(`validation failed: ${errors.slice(0, 3).join('; ')}`);
    return pruned;
};

/** The bytes the upload compares and writes. */
const remoteBytes = (data: AppData): string => toStableSyncJson(toRemoteSyncDocument(data));

/**
 * What `io.readLocal()` hands the cycle. Both platforms persist entities as
 * typed SQLite columns and rebuild them through these row codecs — desktop in
 * Rust (`apps/desktop/src-tauri/src/storage.rs:1912`), mobile through the same
 * core codecs — so the in-memory store snapshot is never the document the
 * upload sees. `toBool`/`fromBool` (entity-sync-schema.ts:45) materialize every
 * boolean column as an explicit true/false on the way back out.
 */
const rowRecord = (columns: readonly string[], values: unknown[]): Record<string, unknown> =>
    Object.fromEntries(columns.map((column, index) => [column, values[index]]));

const throughLocalStorage = (data: AppData): AppData => ({
    ...data,
    tasks: data.tasks.map((entry) => mapSqliteTaskRow(rowRecord(TASK_SQLITE_COLUMNS, taskToSqliteRow(entry)))),
    projects: data.projects.map((entry) => projectFromSqliteRow(rowRecord(PROJECT_SQLITE_COLUMNS, projectToSqliteRow(entry)))),
    sections: data.sections.map((entry) => sectionFromSqliteRow(rowRecord(SECTION_SQLITE_COLUMNS, sectionToSqliteRow(entry)))),
    areas: data.areas.map((entry) => areaFromSqliteRow(rowRecord(AREA_SQLITE_COLUMNS, areaToSqliteRow(entry, NOW_ISO)), NOW_ISO)),
    people: (data.people ?? []).map((entry) => personFromSqliteRow(rowRecord(PERSON_SQLITE_COLUMNS, personToSqliteRow(entry, NOW_ISO)), NOW_ISO)),
});

/**
 * The document a device actually holds after a few cycles: every cycle writes
 * the pass output to SQLite and the next cycle reads it back, so the true
 * production input to the pass is a fixed point of `pass . localStorage`.
 */
const convergeThroughStorage = (data: AppData, rounds = 3): AppData => {
    let current = runNormalizePass(data);
    for (let round = 0; round < rounds; round += 1) {
        current = runNormalizePass(throughLocalStorage(current));
    }
    return current;
};

// ---------------------------------------------------------------------------
// Minimal structural diff over the stable-normalized values
// ---------------------------------------------------------------------------

type DiffEntry = { path: string; before: unknown; after: unknown };

const collectDiffs = (before: unknown, after: unknown, path: string, out: DiffEntry[], limit = 8): void => {
    if (out.length >= limit) return;
    if (before === after) return;
    const bothArrays = Array.isArray(before) && Array.isArray(after);
    const bothObjects = !bothArrays
        && before !== null && after !== null
        && typeof before === 'object' && typeof after === 'object';
    if (bothArrays) {
        const left = before as unknown[];
        const right = after as unknown[];
        if (left.length !== right.length) {
            out.push({ path: `${path}.length`, before: left.length, after: right.length });
        }
        for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
            collectDiffs(left[index], right[index], `${path}[${index}]`, out, limit);
        }
        return;
    }
    if (bothObjects) {
        const left = before as Record<string, unknown>;
        const right = after as Record<string, unknown>;
        const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
        for (const key of keys) {
            collectDiffs(left[key], right[key], path ? `${path}.${key}` : key, out, limit);
        }
        return;
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) {
        out.push({ path, before, after });
    }
};

const diffDocuments = (before: AppData, after: AppData, limit = 8): DiffEntry[] => {
    const out: DiffEntry[] = [];
    collectDiffs(
        JSON.parse(remoteBytes(before)),
        JSON.parse(remoteBytes(after)),
        '',
        out,
        limit,
    );
    return out;
};

/** `surface.field: before -> after (xN)`, so a per-entity difference reads as one line. */
const summarizeDiff = (entries: DiffEntry[]): string => {
    if (entries.length === 0) return 'none';
    const buckets = new Map<string, number>();
    for (const entry of entries) {
        const key = `${entry.path.replace(/\[\d+\]/g, '[]')}: ${JSON.stringify(entry.before)} -> ${JSON.stringify(entry.after)}`;
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    return Array.from(buckets.entries())
        .map(([key, count]) => (count > 1 ? `${key} (x${count})` : key))
        .join('; ');
};

/**
 * Settle the document, then run the pass once more on the settled form and
 * report whether the uploaded bytes moved.
 */
const measure = (label: string, raw: AppData): { settled: AppData; identical: boolean } => {
    const settled = runNormalizePass(raw);
    const settledBytes = remoteBytes(settled);
    const again = runNormalizePass(settled);
    const againBytes = remoteBytes(again);
    const identical = settledBytes === againBytes;
    const firstPassDiff = diffDocuments(raw, settled, 5_000);
    report(
        `| ${label} | ${identical ? 'IDENTICAL' : 'CHANGED'} | ${identical ? '-' : summarizeDiff(diffDocuments(settled, again, 5_000))} | ${summarizeDiff(firstPassDiff)} |`,
    );
    return { settled, identical };
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const emptyData = (): AppData => ({
    tasks: [], projects: [], sections: [], areas: [], people: [], settings: {},
});

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
    id,
    title: `Task ${id}`,
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: BASE_ISO,
    updatedAt: BASE_ISO,
    rev: 1,
    revBy: 'device-a',
    ...overrides,
});

const project = (id: string, overrides: Partial<Project> = {}): Project => ({
    id,
    title: `Project ${id}`,
    status: 'active',
    color: '#2563EB',
    order: 0,
    tagIds: [],
    createdAt: BASE_ISO,
    updatedAt: BASE_ISO,
    rev: 1,
    revBy: 'device-a',
    ...overrides,
});

const section = (id: string, projectId: string, overrides: Partial<Section> = {}): Section => ({
    id,
    projectId,
    title: `Section ${id}`,
    order: 0,
    createdAt: BASE_ISO,
    updatedAt: BASE_ISO,
    rev: 1,
    revBy: 'device-a',
    ...overrides,
});

const area = (id: string, overrides: Partial<Area> = {}): Area => ({
    id,
    name: `Area ${id}`,
    order: 0,
    createdAt: BASE_ISO,
    updatedAt: BASE_ISO,
    rev: 1,
    revBy: 'device-a',
    ...overrides,
});

const person = (id: string, overrides: Partial<Person> = {}): Person => ({
    id,
    name: `Person ${id}`,
    createdAt: BASE_ISO,
    updatedAt: BASE_ISO,
    rev: 1,
    revBy: 'device-a',
    ...overrides,
});

const fileAttachment = (id: string, overrides: Partial<Attachment> = {}): Attachment => ({
    id,
    kind: 'file',
    title: `${id}.pdf`,
    uri: `/home/dd/files/${id}.pdf`,
    mimeType: 'application/pdf',
    createdAt: BASE_ISO,
    updatedAt: BASE_ISO,
    ...overrides,
} as Attachment);

const daysAgo = (days: number): string =>
    new Date(Date.parse(NOW_ISO) - days * 24 * 60 * 60 * 1000).toISOString();

const CONTEXTS = ['@home', '@work', '@errands', '@calls', '@computer'];
const TAGS = ['#admin', '#writing', '#health', '#finance', '#planning'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

/** Realistic large document, modelled on performance-large-store.test.ts. */
const buildLargeDocument = (taskCount: number): AppData => {
    const projectCount = Math.max(40, Math.min(500, Math.floor(taskCount / 40)));
    const projects = Array.from({ length: projectCount }, (_, index) => project(`project-${index}`, {
        order: index,
        status: index % 19 === 0 ? 'waiting' : index % 23 === 0 ? 'someday' : 'active',
        color: ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'][index % 5],
        tagIds: [TAGS[index % TAGS.length]],
        areaId: `area-${index % 5}`,
        areaTitle: `Area area-${index % 5}`,
    }));
    const sections = projects.flatMap((item, index) => [
        section(`section-${item.id}-0`, item.id, { order: 0 }),
        section(`section-${item.id}-1`, item.id, { order: 1 }),
    ].map((entry) => ({ ...entry, order: index % 2 })));
    const areas = Array.from({ length: 5 }, (_, index) => area(`area-${index}`, { order: index }));

    const tasks: Task[] = [];
    for (let index = 0; index < taskCount; index += 1) {
        const owner = projects[index % projectCount];
        const inProject = index % 6 !== 0;
        const status = index % 29 === 0
            ? 'archived'
            : index % 23 === 0
                ? 'reference'
                : index % 11 === 0
                    ? 'done'
                    : index % 7 === 0
                        ? 'waiting'
                        : index % 5 === 0
                            ? 'inbox'
                            : 'next';
        tasks.push(task(`task-${index}`, {
            title: `Synthetic task ${index}`,
            status: status as Task['status'],
            priority: PRIORITIES[index % PRIORITIES.length],
            tags: [TAGS[index % TAGS.length], TAGS[(index + 3) % TAGS.length]],
            contexts: [CONTEXTS[index % CONTEXTS.length]],
            // A task never carries both a project and an area: the store's own
            // container rules forbid it (task-container-rules.ts:74).
            projectId: inProject ? owner.id : undefined,
            sectionId: inProject ? `section-${owner.id}-${index % 2}` : undefined,
            areaId: inProject ? undefined : `area-${index % 5}`,
            isFocusedToday: index % 97 === 0,
            dueDate: index % 3 === 0 ? '2026-06-11T17:00:00.000Z' : undefined,
            completedAt: status === 'done' || status === 'archived' ? '2026-06-02T09:00:00.000Z' : undefined,
            deletedAt: index % 503 === 0 ? daysAgo(10) : undefined,
            order: index,
            orderNum: index,
            updatedAt: `2026-06-${String((index % 27) + 1).padStart(2, '0')}T10:00:00.000Z`,
            checklist: index % 41 === 0
                ? [{ id: `check-${index}`, title: 'First step', isCompleted: index % 2 === 0 }]
                : undefined,
        }));
    }

    return {
        tasks,
        projects,
        sections,
        areas,
        people: [person('person-1'), person('person-2')],
        settings: {
            deviceId: 'measurement-device',
            syncPreferences: { gtd: true, appearance: true, language: true, savedFilters: true },
            syncPreferencesUpdatedAt: { gtd: BASE_ISO, appearance: BASE_ISO, language: BASE_ISO, savedFilters: BASE_ISO },
            theme: 'dark',
            language: 'en',
            gtd: { defaultAreaId: 'area-0' },
        },
    };
};

// ---------------------------------------------------------------------------
// Part 1: documents
// ---------------------------------------------------------------------------

describe('canonical local reads contract', () => {
    afterEach(async () => {
        await flushPendingSave();
        resetForTests();
    });

    it('is byte-identical on a second pass for every document shape', () => {
        report('');
        report('### Documents (pass on a settled document)');
        report('');
        report('| document | second pass | what changed | what the FIRST pass changed |');
        report('| --- | --- | --- | --- |');

        const cases: Array<{ label: string; data: AppData }> = [];

        cases.push({ label: 'empty document', data: emptyData() });

        cases.push({
            label: `${LARGE_TASK_COUNT.toLocaleString('en-US')}-task realistic store`,
            data: buildLargeDocument(LARGE_TASK_COUNT),
        });

        cases.push({
            label: 'tombstone older than 90 days',
            data: {
                ...emptyData(),
                tasks: [task('t-old', { deletedAt: daysAgo(120), updatedAt: daysAgo(120) })],
                projects: [project('p-old', { deletedAt: daysAgo(200), updatedAt: daysAgo(200) })],
                areas: [area('a-old', { deletedAt: daysAgo(400), updatedAt: daysAgo(400) } as Partial<Area>)],
            },
        });

        cases.push({
            label: 'tombstone younger than 90 days',
            data: {
                ...emptyData(),
                tasks: [task('t-young', { deletedAt: daysAgo(10), updatedAt: daysAgo(10) })],
                projects: [project('p-young', { deletedAt: daysAgo(89), updatedAt: daysAgo(89) })],
            },
        });

        cases.push({
            label: 'purgedAt tombstone carrying live fields',
            data: {
                ...emptyData(),
                tasks: [task('t-purged', {
                    title: 'Should be compacted away',
                    description: 'gone',
                    tags: ['#keep'],
                    deletedAt: daysAgo(5),
                    purgedAt: daysAgo(4),
                })],
                projects: [project('p-purged', {
                    title: 'Also compacted',
                    deletedAt: daysAgo(5),
                    purgedAt: daysAgo(4),
                })],
                sections: [section('s-of-purged', 'p-purged')],
            },
        });

        cases.push({
            label: 'future updatedAt (clock ahead by a year)',
            data: {
                ...emptyData(),
                tasks: [task('t-future', { updatedAt: '2027-09-02T12:00:00.000Z' })],
            },
        });

        cases.push({
            label: 'createdAt after updatedAt',
            data: {
                ...emptyData(),
                tasks: [task('t-inverted', { createdAt: '2026-08-01T00:00:00.000Z', updatedAt: BASE_ISO })],
            },
        });

        cases.push({
            label: 'unsorted arrays (reverse id order)',
            data: {
                ...emptyData(),
                tasks: [task('t-9'), task('t-3'), task('t-1'), task('t-7')],
                projects: [project('p-9'), project('p-1')],
            },
        });

        cases.push({
            label: 'explicit undefined vs missing fields',
            data: {
                ...emptyData(),
                tasks: [
                    { ...task('t-explicit'), description: undefined, dueDate: undefined, projectId: undefined },
                    task('t-missing'),
                ],
            },
        });

        cases.push({
            label: 'duplicate ids',
            data: {
                ...emptyData(),
                tasks: [
                    task('t-dup', { title: 'first copy', updatedAt: BASE_ISO }),
                    task('t-dup', { title: 'second copy', updatedAt: '2026-07-01T09:00:00.000Z' }),
                ],
            },
        });

        cases.push({
            label: 'settings groups (all sync groups on)',
            data: {
                ...emptyData(),
                settings: {
                    deviceId: 'device-a',
                    syncPreferences: {
                        gtd: true, appearance: true, language: true,
                        savedFilters: true, externalCalendars: true, ai: true,
                    },
                    syncPreferencesUpdatedAt: {
                        gtd: BASE_ISO, appearance: BASE_ISO, language: BASE_ISO,
                        savedFilters: BASE_ISO, externalCalendars: BASE_ISO, ai: BASE_ISO,
                    },
                    theme: 'dark',
                    language: 'de',
                    weekStart: 1,
                    gtd: { defaultAreaId: undefined },
                    savedFilters: [{ id: 'f-1', name: 'Today', filter: {}, createdAt: BASE_ISO, updatedAt: BASE_ISO }],
                    externalCalendars: [{ id: 'c-1', name: 'Work', url: 'https://example.com/cal.ics', enabled: true }],
                    ai: { provider: 'anthropic', apiKey: 'secret-should-not-travel' },
                } as AppData['settings'],
            },
        });

        cases.push({
            label: 'projects/sections/areas/people/contexts',
            data: {
                ...emptyData(),
                areas: [area('area-1'), area('area-2')],
                projects: [
                    project('proj-1', { areaId: 'area-1', areaTitle: 'Area area-1' }),
                    project('proj-2', { areaId: 'area-2', areaTitle: 'stale title' }),
                ],
                sections: [section('sec-1', 'proj-1'), section('sec-2', 'proj-2')],
                people: [person('pers-1'), person('pers-2', { note: 'note' })],
                tasks: [
                    task('t-a', { projectId: 'proj-1', sectionId: 'sec-1', contexts: ['@home'] }),
                    task('t-b', { areaId: 'area-2', contexts: ['@work'] }),
                ],
            },
        });

        cases.push({
            label: 'dangling containers (deleted project/area)',
            data: {
                ...emptyData(),
                areas: [area('area-gone', { deletedAt: daysAgo(5) } as Partial<Area>)],
                projects: [project('proj-gone', { deletedAt: daysAgo(5) })],
                sections: [section('sec-orphan', 'proj-gone')],
                tasks: [
                    task('t-orphan-project', { projectId: 'proj-gone', sectionId: 'sec-orphan' }),
                    task('t-orphan-area', { areaId: 'area-gone' }),
                    task('t-both', { projectId: 'proj-gone', areaId: 'area-gone' }),
                ],
            },
        });

        cases.push({
            label: 'attachments (live, missing, deleted)',
            data: {
                ...emptyData(),
                projects: [project('proj-att', {
                    attachments: [fileAttachment('att-p1', { cloudKey: 'attachments/att-p1.pdf' })],
                })],
                tasks: [
                    task('t-att-live', {
                        attachments: [fileAttachment('att-1', {
                            cloudKey: 'attachments/att-1.pdf',
                            localStatus: 'available',
                            contentMtimeMs: 1_750_000_000_000,
                            contentSize: 4096,
                            contentRev: 2,
                            fileHash: 'a'.repeat(64),
                        } as Partial<Attachment>)],
                    }),
                    task('t-att-missing', {
                        attachments: [fileAttachment('att-2', {
                            localStatus: 'missing',
                            uri: '',
                        } as Partial<Attachment>)],
                    }),
                    task('t-att-deleted', {
                        attachments: [fileAttachment('att-3', {
                            cloudKey: 'attachments/att-3.pdf',
                            deletedAt: daysAgo(3),
                        } as Partial<Attachment>)],
                    }),
                    task('t-att-old-tombstone', {
                        attachments: [fileAttachment('att-4', {
                            deletedAt: daysAgo(120),
                            updatedAt: daysAgo(120),
                        } as Partial<Attachment>)],
                    }),
                ],
            },
        });

        cases.push({
            label: 'rev/revBy absent everywhere',
            data: {
                ...emptyData(),
                tasks: [
                    { ...task('t-norev'), rev: undefined, revBy: undefined },
                    (() => { const bare = task('t-bare'); delete (bare as Partial<Task>).rev; delete (bare as Partial<Task>).revBy; return bare; })(),
                ],
                projects: [(() => { const bare = project('p-bare'); delete (bare as Partial<Project>).rev; delete (bare as Partial<Project>).revBy; return bare; })()],
            },
        });

        cases.push({
            label: 'rev/revBy present, revBy padded',
            data: {
                ...emptyData(),
                tasks: [
                    task('t-rev', { rev: 42, revBy: 'device-b' }),
                    task('t-padded', { rev: 7, revBy: '  device-c  ' }),
                    task('t-badrev', { rev: -5 as number, revBy: 'device-d' }),
                ],
            },
        });

        const results = cases.map(({ label, data }) => ({ label, ...measure(label, data) }));
        const changed = results.filter((entry) => !entry.identical);
        expect(changed.map((entry) => entry.label)).toEqual([]);
    }, 120_000);

    /** Load `stored` into a fresh store, run `mutate`, and return the snapshot the store saved. */
    const persistAfter = async (stored: AppData, mutate: () => Promise<unknown>): Promise<AppData> => {
        resetForTests();
        useTaskStore.setState({
            tasks: [], projects: [], sections: [], areas: [], people: [], settings: {},
            isLoading: false, error: null,
            _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
            _tasksById: new Map(), _projectsById: new Map(), _sectionsById: new Map(),
            _areasById: new Map(), _peopleById: new Map(),
            lastDataChangeAt: 0,
        });
        let saved: AppData | undefined;
        setStorageAdapter({
            getData: async () => structuredClone(stored),
            saveData: async (data) => { saved = structuredClone(data); },
        });
        await useTaskStore.getState().fetchData({ silent: true });
        await mutate();
        await flushPendingSave();
        if (!saved) throw new Error('The store never persisted a snapshot');
        return saved;
    };

    const persistTaskPatchAndRead = async (updates: Partial<Task>): Promise<AppData> => throughLocalStorage(
        await persistAfter(
            throughLocalStorage({ ...emptyData(), tasks: [task('field-task')] }),
            () => useTaskStore.getState().updateTask('field-task', updates),
        ),
    );

    it('keeps editor updates and Reference moves canonical before and after storage', async () => {
        for (const [label, updates] of [
            ['editor', { title: 'Edited task', dueDate: '2026-09-03', suppressMindwtrReminders: undefined }],
            ['reference', { status: 'reference' as const }],
        ] as const) {
            const written = await persistAfter(
                convergeThroughStorage({ ...emptyData(), tasks: [task('editor-task', { suppressMindwtrReminders: true })] }),
                () => useTaskStore.getState().updateTask('editor-task', updates),
            );
            expect(written.tasks[0].suppressMindwtrReminders, label).toBe(false);
            expect(diffDocuments(written, runNormalizePass(written)), label).toEqual([]);
            const readBack = throughLocalStorage(written);
            expect(readBack.tasks[0].suppressMindwtrReminders, label).toBe(false);
            expect(diffDocuments(readBack, runNormalizePass(readBack)), label).toEqual([]);
        }
    });

    it('reads showFutureRecurrence canonically after a store write without recurrence', async () => {
        const readBack = await persistTaskPatchAndRead({ showFutureRecurrence: true });

        expect(readBack.tasks[0].recurrence).toBeFalsy();
        expect(readBack.tasks[0].showFutureRecurrence).toBeUndefined();
        expect(remoteBytes(readBack)).toBe(remoteBytes(mergeAppData(readBack, emptyData())));
    });

    it('reads each synced task boolean or optional field canonically in isolation', async () => {
        const fields = TASK_SYNC_FIELD_SCHEMA.filter((field) => (
            field.sync === 'content'
            && (field.nullability !== 'required' || field.cloudKit?.kind === 'boolean')
        ));
        // Scoped to `sync: 'content'` fields — the payload shape an ordinary
        // caller (desktop editor, MCP) can set with a single field patch.
        // `archive-metadata`/`revision-metadata`/`tombstone`/`order` fields
        // are never set this way: archive fields flow through the
        // archive/unarchive actions, purgedAt/deletedAt through tombstone
        // compaction (tombstone-compaction.ts), rev/revBy are stamped by
        // applyTaskUpdates itself — each has its own dedicated write path and
        // its own coverage, so patching one in isolation here would assert a
        // write shape that store-tasks.ts never actually produces.
        for (const field of fields) {
            expect(Object.hasOwn(TASK_SYNC_SCHEMA_FIXTURE, field.name), `${field.name}: fixture coverage`).toBe(true);
            const fixtureValue = TASK_SYNC_SCHEMA_FIXTURE[field.name];
            const values = field.cloudKit?.kind === 'boolean' ? [true, false] : [fixtureValue];
            for (const value of values) {
                // Start from a plain task for EACH field/value, never the
                // exhaustive fixture whose recurrence can mask a boolean bug.
                const readBack = await persistTaskPatchAndRead({ [field.name]: value });
                expect(remoteBytes(readBack), `${field.name}=${JSON.stringify(value)}`)
                    .toBe(remoteBytes(mergeAppData(readBack, emptyData())));
            }
        }
    });

    // Every store path that creates a recurring follow-up (single update, batch
    // update, skip) stamps it in stampNewRecurringFollowUp; duplicateTask is the
    // other write that mints a series id.
    it('writes recurring follow-ups the pass keeps, on an unchanged schedule and signature', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(NOW_ISO));
        const sign = (entry: Task) => getMergeComparableSignature(
            normalizeTaskForSyncMerge(entry, NOW_ISO),
            normalizeTaskForContentComparison,
        );
        try {
            for (const action of ['complete', 'batch-complete', 'skip', 'duplicate'] as const) {
                for (const suppressed of [true, false]) {
                    for (const seriesId of ['series-x', undefined]) {
                        for (const rrule of ['FREQ=DAILY', undefined]) {
                            const label = JSON.stringify({ action, suppressed, seriesId, rrule });
                            let source: Task | undefined;
                            const written = await persistAfter(
                                convergeThroughStorage({ ...emptyData(), tasks: [task('series-task', { dueDate: '2026-09-01' })] }),
                                async () => {
                                    const store = useTaskStore.getState();
                                    // What the task editors send: no series stamp in the rrule.
                                    await store.updateTask('series-task', {
                                        recurrence: {
                                            rule: 'daily',
                                            strategy: 'strict',
                                            ...(seriesId ? { seriesId } : {}),
                                            ...(rrule ? { rrule } : {}),
                                        },
                                        ...(suppressed ? { suppressMindwtrReminders: true } : {}),
                                    });
                                    source = useTaskStore.getState()._tasksById.get('series-task');
                                    if (action === 'complete') await store.updateTask('series-task', { status: 'done' });
                                    if (action === 'batch-complete') await store.batchUpdateTasks([{ id: 'series-task', updates: { status: 'done' } }]);
                                    if (action === 'skip') await store.skipRecurringTaskOccurrence('series-task');
                                    if (action === 'duplicate') await store.duplicateTask('series-task');
                                },
                            );

                            // Field by field, over the edited source and the new task.
                            expect(diffDocuments(written, runNormalizePass(written)), label).toEqual([]);
                            const readBack = throughLocalStorage(written);
                            expect(diffDocuments(readBack, runNormalizePass(readBack)), label).toEqual([]);

                            expect(written.tasks, label).toHaveLength(2);
                            const created = written.tasks.find((entry) => entry.id !== 'series-task') as Task;
                            expect(created.recurrence, label).toMatchObject({
                                seriesId: action === 'duplicate' ? created.id : (seriesId ?? 'series-task'),
                            });
                            expect(created.suppressMindwtrReminders, label).toBe(suppressed);
                            if (action === 'duplicate') continue;

                            // The schedule is the one next-instance function's, untouched.
                            const next = createNextRecurringTask(
                                source as Task,
                                NOW_ISO,
                                (source as Task).status,
                                action === 'skip' ? { advanceOne: true } : undefined,
                            ) as Task;
                            expect(created.dueDate, label).toBe('2026-09-02');
                            expect([created.startTime, created.dueDate, created.reviewAt], label)
                                .toEqual([next.startTime, next.dueDate, next.reviewAt]);

                            // The shape before this fix differs in bytes but not in signature.
                            const beforeFix: Task = {
                                ...created,
                                recurrence: next.recurrence,
                                suppressMindwtrReminders: next.suppressMindwtrReminders,
                            };
                            expect(remoteBytes({ ...emptyData(), tasks: [beforeFix] }), label)
                                .not.toBe(remoteBytes({ ...emptyData(), tasks: [created] }));
                            expect(sign(created), label).toBe(sign(beforeFix));
                        }
                    }
                }
            }
        } finally {
            vi.useRealTimers();
        }
    });

    // -----------------------------------------------------------------------
    // Part 2: every store write action, driven off the store's own action map
    // -----------------------------------------------------------------------

    /**
     * Store keys that are functions but never add content to the persisted
     * document: reads, UI-only state, and the two re-persist helpers that write
     * the snapshot the store already holds. Everything else must appear in the
     * coverage map below, or the completeness check fails.
     */
    const NON_WRITING_ACTIONS = new Set([
        'fetchData',
        'getDerivedState',
        'getFocusStarAction',
        'getFocusedCount',
        'queryTasks',
        'setError',
        'setHighlightTask',
        'lockEditing',
        'unlockEditing',
        // Re-enqueue / re-save the existing in-memory snapshot; they produce no
        // content the pass has not already seen through the action that made it.
        'retryPersistence',
        'persistSnapshot',
        // Requeues the raw saved snapshot owned by commitPreparedAppLock after
        // a failed save; the SQLite recovery test checks its exact contents.
        'retryPreparedAppLockSnapshot',
    ]);

    it('leaves a canonical document after every store write action', async () => {
        report('');
        report('### Store write actions on a settled document');
        report('');
        report('| action | pass changes the STORE snapshot? | pass changes the document readLocal returns? | what changed (store) | what changed (readLocal) |');
        report("| --- | --- | --- | --- | --- |");

        const settled = convergeThroughStorage(buildLargeDocument(150));

        type MutationControl = {
            resetBaseline: () => void;
            expectPersisted: (verify: (written: AppData) => void) => void;
        };
        const runMutation = async (
            label: string,
            mutate: (control: MutationControl) => Promise<unknown>,
            fixture: AppData = settled,
            withDurableReceipts = false,
        ): Promise<{ storeFields: string[]; readFields: string[] }> => {
            let saved: AppData | null = null;
            let durable = structuredClone(fixture);
            let verifyPersisted: ((written: AppData) => void) | null = null;
            resetForTests();
            // resetForTests only clears module timers (store.ts); the zustand
            // state itself has to be cleared or one row's writes leak into the next.
            useTaskStore.setState({
                tasks: [], projects: [], sections: [], areas: [], people: [], settings: {},
                isLoading: false, error: null,
                _allTasks: [], _allProjects: [], _allSections: [], _allAreas: [], _allPeople: [],
                _tasksById: new Map(), _projectsById: new Map(), _sectionsById: new Map(),
                _areasById: new Map(), _peopleById: new Map(),
                lastDataChangeAt: 0,
            } as never);
            let sqlite: ReturnType<typeof openScratchSqlite> | null = null;
            let sqliteDir: string | null = null;
            if (withDurableReceipts) {
                sqliteDir = mkdtempSync(join(tmpdir(), 'mindwtr-canonical-receipts-'));
                sqlite = openScratchSqlite(join(sqliteDir, 'mindwtr.sqlite'));
                await new SqliteAdapter(sqlite.client).saveData(durable);
                resetNativeRequestReceipts();
                class TrackedReceiptAdapter extends NativeReceiptSqliteAdapter {
                    async saveData(data: AppData): Promise<void> {
                        await super.saveData(data);
                        saved = structuredClone(data);
                    }
                }
                setStorageAdapter(new TrackedReceiptAdapter(sqlite.client, {
                    rejectConcurrentWrites: label === 'commitPreparedReferenceTasksMove'
                        || label === 'commitPreparedReferenceTasksAddTag' || label === 'commitPreparedReferenceTasksRemoveTag',
                }));
                await loadNativeRequestReceipts(sqlite.client);
            } else setStorageAdapter({
                getData: async () => structuredClone(durable),
                saveData: async (data: AppData) => {
                    saved = structuredClone(data);
                    durable = structuredClone(data);
                },
            });
            try {
                await (useTaskStore.getState() as unknown as {
                    fetchData: (options?: { silent?: boolean }) => Promise<void>;
                }).fetchData({ silent: true });
                await mutate({
                    resetBaseline: () => { saved = null; },
                    expectPersisted: (verify) => { verifyPersisted = verify; },
                });
                await flushPendingSave();
                if (!saved) throw new Error(`${label}: the store never persisted a snapshot`);
                const written = saved as AppData;
                verifyPersisted?.(written);
                const passed = runNormalizePass(written);
                const storeIdentical = remoteBytes(written) === remoteBytes(passed);

                const readBack = throughLocalStorage(written);
                const readBackPassed = runNormalizePass(readBack);
                const readIdentical = remoteBytes(readBack) === remoteBytes(readBackPassed);

                report(
                    `| ${label} | ${storeIdentical ? 'no' : 'YES'} | ${readIdentical ? 'no' : 'YES'} | ${storeIdentical ? '-' : summarizeDiff(diffDocuments(written, passed, 5_000))} | ${readIdentical ? '-' : summarizeDiff(diffDocuments(readBack, readBackPassed, 5_000))} |`,
                );
                resetForTests();
                return {
                    storeFields: [...new Set(
                        diffDocuments(written, passed, 5_000).map((entry) => entry.path.split('.').pop() as string),
                    )].sort(),
                    readFields: [...new Set(
                        diffDocuments(readBack, readBackPassed, 5_000).map((entry) => entry.path.split('.').pop() as string),
                    )].sort(),
                };
            } finally {
                if (sqlite) {
                    await flushPendingSave();
                    resetForTests();
                    resetNativeRequestReceipts();
                    sqlite.close();
                    rmSync(sqliteDir!, { recursive: true, force: true });
                }
            }
        };

        const store = () => useTaskStore.getState() as unknown as Record<string, (...args: never[]) => Promise<unknown>>;
        const call = (name: string, ...args: unknown[]) => store()[name](...(args as never[]));
        const nativeValue = <T,>(outcome: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
            if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
            return outcome.value;
        };
        const nativeHost = async (control: MutationControl) => {
            await flushPendingSave();
            const host = createNativeHostContract();
            nativeValue(await host.activate({ writeSafetyReady: true, recoveryLoad: true }));
            await flushPendingSave();
            control.resetBaseline();
            return host;
        };

        const liveTasks = settled.tasks.filter((entry) => !entry.deletedAt);
        const taskId = liveTasks[1].id;
        const deletedTaskId = settled.tasks.find((entry) => entry.deletedAt)?.id as string;
        const checklistTaskId = liveTasks.find((entry) => (entry.checklist?.length ?? 0) > 0)?.id as string;
        const projectId = settled.projects[0].id;
        const otherProjectId = settled.projects[3].id;
        const sectionId = settled.sections.find((entry) => entry.projectId === projectId)?.id as string;
        const areaId = settled.areas[0].id;
        const personId = (settled.people ?? [])[0].id;
        const projectTaskIds = liveTasks.filter((entry) => entry.projectId === projectId).map((entry) => entry.id);
        const nextTaskIds = liveTasks.filter((entry) => entry.status === 'next').slice(0, 6).map((entry) => entry.id);
        const focusIds = settled.tasks.filter((entry) => entry.isFocusedToday).map((entry) => entry.id);
        const convertedProjectReceipt = async () => {
            const source = await call('addProject', 'Contract conversion source', '#123456', { isSequential: false }) as Project | null;
            const destination = await call('addProject', 'Contract conversion destination', '#123456', { isSequential: false }) as Project | null;
            if (!source || !destination) throw new Error('Conversion fixture projects missing');
            await call('addTask', 'Contract conversion child', { projectId: source.id, status: 'next' });
            const prepared = prepareProjectToSection(useTaskStore.getState(), source.id, destination.id, 'Contract section');
            if (!prepared.ok) throw new Error(`Conversion fixture blocked: ${prepared.reason}`);
            const converted = await useTaskStore.getState().convertProjectToSection(prepared.command);
            if (!converted.success) throw new Error(`Conversion fixture failed: ${converted.reason}`);
            return converted.receipt;
        };
        const checklistConversion = async () => {
            const added = await useTaskStore.getState().addTask('Contract checklist source', {
                status: 'inbox', checklist: [
                    { id: 'contract-open', title: 'Open item', isCompleted: false },
                    { id: 'contract-done', title: 'Checked item', isCompleted: true },
                ],
            });
            const source = added.id ? useTaskStore.getState()._tasksById.get(added.id) : null;
            if (!added.success || !source) throw new Error('Checklist conversion fixture missing');
            const prepared = prepareChecklistProjectConversion(useTaskStore.getState(), source, 'Contract checklist project');
            if (!prepared.success) throw new Error(`Checklist conversion fixture blocked: ${prepared.error}`);
            await flushPendingSave();
            return prepared.command;
        };

        expect(
            [taskId, deletedTaskId, checklistTaskId, sectionId].every((value) => typeof value === 'string'),
            'fixture must supply a live task, a soft-deleted task, a task with a checklist and a section',
        ).toBe(true);

        /**
         * One invocation per write action, keyed by the action's own name. The
         * restore/purge entries soft-delete first so the action under test has
         * something to act on; the persisted snapshot still covers both writes.
         */
        const WRITE_ACTIONS: Record<string, (control: MutationControl) => Promise<unknown>> = {
            addArea: () => call('addArea', 'Contract area'),
            addPerson: () => call('addPerson', 'Contract person'),
            addProject: () => call('addProject', 'Contract project', '#123456'),
            addSection: () => call('addSection', otherProjectId, 'Contract section'),
            addTask: () => call('addTask', 'Contract task'),
            addTasks: () => call('addTasks', [{ title: 'Contract A' }, { title: 'Contract B' }]),
            batchDeleteTasks: () => call('batchDeleteTasks', nextTaskIds.slice(0, 3)),
            batchMoveTasks: () => call('batchMoveTasks', nextTaskIds.slice(0, 3), 'waiting'),
            batchUpdateTasks: () => call('batchUpdateTasks', nextTaskIds.slice(0, 3).map((id) => ({
                id,
                updates: { title: `Contract batch ${id}` },
            }))),
            cancelProject: () => call('cancelProject', projectId),
            cancelTask: () => call('cancelTask', taskId),
            convertChecklistToProject: async (control) => {
                const command = await checklistConversion();
                control.resetBaseline();
                expect(await call('convertChecklistToProject', command)).toMatchObject({ success: true });
                control.expectPersisted((written) => {
                    expect(written.tasks.find((entry) => entry.id === command.source.id)).toEqual(command.retired);
                    expect(written.projects.find((entry) => entry.id === command.project.id)).toEqual(command.project);
                    for (const task of command.tasks) expect(written.tasks.find((entry) => entry.id === task.id)).toEqual(task);
                });
            },
            convertProjectToSection: () => convertedProjectReceipt(),
            commitPreparedAreaCreate: async (control) => {
                const host = await nativeHost(control);
                const request = { requestId: 'a41285b2-c665-4a18-9764-38e321191cde',
                    name: 'Contract prepared area', color: '#3b82f6',
                    expectedAreaId: 'a41285b2-c665-4a18-9764-38e321191cde' };
                const planned = nativeValue(await host.prepareAreaCreate(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.areas.find((entry) => entry.id === request.expectedAreaId))
                        .toEqual(planned.prepared.effect.area.after);
                });
                expect(nativeValue(await host.commitPreparedAreaCreate({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
                expect(useTaskStore.getState()._areasById.get(request.expectedAreaId))
                    .toEqual(planned.prepared.effect.area.after);
            },
            commitPreparedAreaColor: async (control) => {
                const host = await nativeHost(control);
                const options = nativeValue(host.getAreaColorOptions());
                const selected = options.areas.find((entry) => entry.id === areaId);
                expect(selected).toBeDefined();
                if (!selected) return;
                const request = { requestId: '3b33c6cb-5168-4c61-94aa-297a54c88691',
                    areaId, color: '#ef4444',
                    expected: { name: selected.name, color: selected.color, rev: selected.rev,
                        revBy: selected.revBy, updatedAt: selected.updatedAt } };
                const planned = nativeValue(host.prepareAreaColor(request));
                control.expectPersisted((written) => {
                    expect(written.areas.find((entry) => entry.id === areaId))
                        .toEqual(planned.prepared.effect.area.after);
                    for (const { after } of planned.prepared.effect.projects) {
                        expect(written.projects.find((entry) => entry.id === after.id)).toEqual(after);
                    }
                });
                expect(nativeValue(await host.commitPreparedAreaColor({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
            },
            commitPreparedAreaRename: async (control) => {
                const host = await nativeHost(control);
                const options = nativeValue(host.getAreaOrderOptions());
                const selected = options.areas.find((entry) => entry.id === areaId);
                expect(selected).toBeDefined();
                if (!selected) return;
                const request = { requestId: '2bf1993a-20c8-4eae-b747-51db55db67cf',
                    areaId, name: 'Contract prepared Area rename', expected: selected };
                const planned = nativeValue(await host.prepareAreaRename(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    for (const { after } of planned.prepared.effect.areas) {
                        expect(written.areas.find((entry) => entry.id === after.id)).toEqual(after);
                    }
                    for (const { after } of planned.prepared.effect.projects) {
                        expect(written.projects.find((entry) => entry.id === after.id)).toEqual(after);
                    }
                    for (const { after } of planned.prepared.effect.tasks) {
                        expect(written.tasks.find((entry) => entry.id === after.id)).toEqual(after);
                    }
                });
                expect(nativeValue(await host.commitPreparedAreaRename({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
                expect(useTaskStore.getState()._areasById.get(areaId))
                    .toEqual(planned.prepared.effect.areas[0].after);
            },
            commitPreparedAreaOrder: async (control) => {
                const host = await nativeHost(control);
                const options = nativeValue(host.getAreaOrderOptions());
                const request = { requestId: 'db7ea2f4-9847-44fd-84a8-028741379fe2',
                    intent: { kind: 'sortName' as const }, expectedAreas: options.areas };
                const planned = nativeValue(host.prepareAreaOrder(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    for (const { after } of planned.prepared.effect.areas) {
                        expect(written.areas.find((entry) => entry.id === after.id)).toEqual(after);
                    }
                });
                expect(nativeValue(await host.commitPreparedAreaOrder({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
            },
            commitPreparedAreaDelete: async (control) => {
                const host = await nativeHost(control);
                const added = await useTaskStore.getState().addArea('Contract deletable area');
                expect(added).not.toBeNull();
                if (!added) return;
                await flushPendingSave();
                control.resetBaseline();
                const options = nativeValue(host.getAreaDeleteOptions());
                const selected = options.areas.find((entry) => entry.id === added.id);
                expect(selected).toMatchObject({ projectCount: 0, canDelete: true });
                if (!selected) return;
                const { id, projectCount: _projectCount, canDelete: _canDelete, ...expected } = selected;
                const request = { requestId: '81ef3845-e5d8-4966-9a4a-95bb1096c83f',
                    areaId: id, expected };
                const planned = nativeValue(await host.prepareAreaDelete(request));
                control.expectPersisted((written) => {
                    expect(written.areas.find((entry) => entry.id === id))
                        .toEqual(planned.prepared.effect.area.after);
                });
                expect(nativeValue(await host.commitPreparedAreaDelete({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
            },
            commitPreparedTaxonomy: async (control) => {
                const host = await nativeHost(control);
                const name = settled.tasks.find((entry) => entry.tags.length > 0)!.tags[0];
                const options = nativeValue(await host.getTaxonomyOptions({ kind: 'tag', name }));
                const request = { requestId: '6b4399fc-ae38-4a7d-904f-c7413652a096',
                    kind: 'tag' as const, action: 'rename' as const, name,
                    to: '#ContractTaxonomy', expected: options.expected };
                const planned = nativeValue(await host.prepareTaxonomy(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    for (const { after } of planned.prepared.effect.tasks) {
                        expect(written.tasks.find((entry) => entry.id === after.id)).toEqual(after);
                    }
                    for (const { after } of planned.prepared.effect.projects) {
                        expect(written.projects.find((entry) => entry.id === after.id)).toEqual(after);
                    }
                });
                expect(nativeValue(await host.commitPreparedTaxonomy({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
            },
            commitPreparedGeneralPreference: async (control) => {
                const host = await nativeHost(control);
                nativeValue(await host.setLanguage({ storedLanguage: 'fa', systemLocale: 'en-US' }));
                const options = nativeValue(await host.getGeneralPreferenceOptions({}));
                const request = { requestId: '97a7fe31-4444-4000-8000-000000000097',
                    edit: { type: 'calendarSystem' as const,
                        value: options.expected.calendarSystem.value === 'jalali' ? 'gregorian' as const : 'jalali' as const },
                    expected: options.expected.calendarSystem };
                const planned = nativeValue(await host.prepareGeneralPreference(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.settings.calendarSystem).toBe(request.edit.value);
                    expect(written.settings.syncPreferencesUpdatedAt?.language).toBe(planned.prepared.after.stamp);
                    expect(written.tasks).toHaveLength(settled.tasks.length);
                });
                expect(nativeValue(await host.commitPreparedGeneralPreference({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
            },
            commitPreparedGtdWorkflow: async (control) => {
                const host = await nativeHost(control);
                const options = nativeValue(await host.getGtdReviewOptions({}));
                const choice = options.review.dailyFocusStep.edit;
                const request = { requestId: 'e6f4db74-d874-4799-b2b3-849c024d0103',
                    edit: { type: 'dailyReviewFocusStep' as const, value: choice.value },
                    expected: options.expected.dailyReviewFocusStep };
                const planned = nativeValue(await host.prepareGtdWorkflow(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.settings.gtd?.dailyReview?.includeFocusStep).toBe(choice.value);
                    expect(written.settings.syncPreferencesUpdatedAt?.gtd).toBe(planned.prepared.after.stamp);
                    expect(written.tasks).toHaveLength(settled.tasks.length);
                });
                expect(nativeValue(await host.commitPreparedGtdWorkflow({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
            },
            commitPreparedAppLock: async (control) => {
                const host = await nativeHost(control);
                const options = nativeValue(await host.getAppLockOptions({}));
                const request = { requestId: 'cf81c9fb-8e56-4e8b-ab33-538ca8c31b7e',
                    value: !options.value, expected: options.expected };
                const planned = nativeValue(await host.prepareAppLock(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.settings.security?.mobileAppLockEnabled).toBe(request.value);
                    expect(written.tasks).toHaveLength(settled.tasks.length);
                    expect(written.projects).toHaveLength(settled.projects.length);
                });
                expect(nativeValue(await host.commitPreparedAppLock({ request, prepared: planned.prepared })))
                    .toEqual({ changed: true, value: request.value });
            },
            commitPreparedArchivedTaskRestore: async (control) => {
                const host = await nativeHost(control);
                const source = useTaskStore.getState()._tasksById.get('task-29');
                expect(source?.status).toBe('archived');
                if (!source) return;
                const request = { requestId: 'c7485e97-2d70-481f-bd1b-e8224698c741',
                    taskId: source.id, taskRevision: taskRevisionOf(source) };
                const planned = nativeValue(await host.prepareArchivedTaskRestore(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                const restored = planned.prepared.effect.tasks.find((pair) => pair.before.id === source.id)?.after;
                expect(restored?.status).toBe('inbox');
                control.expectPersisted((written) => {
                    expect(written.tasks.find((entry) => entry.id === source.id)).toEqual(restored);
                    expect(written.tasks).toHaveLength(settled.tasks.length);
                    expect(written.projects).toEqual(settled.projects);
                    expect(written.sections).toEqual(settled.sections);
                });
                expect(nativeValue(await host.commitPreparedArchivedTaskRestore({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
            },
            commitPreparedArchivedTasksMutation: async (control) => {
                const host = await nativeHost(control);
                const taskIds = ['task-29', 'task-58'];
                const sources = taskIds.map((id) => {
                    const source = useTaskStore.getState()._tasksById.get(id);
                    expect(source?.status).toBe('archived');
                    if (!source) throw new Error(`Bulk Delete fixture task missing: ${id}`);
                    return source;
                });
                const request = { requestId: '07172a39-547c-4a31-9105-419f8ee756a0', taskIds,
                    taskRevisions: Object.fromEntries(sources.map((row) => [row.id, taskRevisionOf(row)])) };
                const planned = nativeValue(await host.prepareArchivedTasksDelete(request));
                const after = new Map(planned.prepared.after.map((row) => [row.id, row]));
                expect([...after.keys()].sort()).toEqual([...taskIds].sort());
                for (const source of sources) expect(after.get(source.id)).toMatchObject({
                    status: 'archived', deletedAt: planned.prepared.updateAt, rev: (source.rev ?? 0) + 1 });
                const durable = nativeValue(await readAreaDurableData(false, true));
                const before = durable.authority.snapshot;
                control.expectPersisted((written) => {
                    expect(written.tasks).toEqual(before.tasks.map((row) => after.get(row.id) ?? row));
                    expect(written.projects).toEqual(before.projects);
                    expect(written.sections).toEqual(before.sections);
                    expect(written.settings).toEqual(before.settings);
                });
                control.resetBaseline();
                expect(await useTaskStore.getState().commitPreparedArchivedTasksMutation({
                    operation: 'delete', before: planned.prepared.before, after: planned.prepared.after,
                    deviceIdBefore: planned.prepared.deviceIdBefore, deviceIdToInitialize: planned.prepared.deviceIdToInitialize,
                }, durable.authority)).toEqual({ success: true, ids: taskIds, outcome: 'applied' });
            },
            commitPreparedReferenceTasksMove: async (control) => {
                const host = await nativeHost(control);
                const taskIds = ['task-46', 'task-69'];
                const sources = taskIds.map((id) => {
                    const source = useTaskStore.getState()._tasksById.get(id);
                    if (!source || source.status !== 'reference') throw new Error(`Reference Move fixture missing: ${id}`);
                    return source;
                });
                const request = { requestId: 'd41122ed-aef4-4691-8bdd-bcd70104d193', taskIds,
                    taskRevisions: Object.fromEntries(sources.map((source) => [source.id, taskRevisionOf(source)])),
                    status: 'next' as const, params: {} };
                const planned = nativeValue(await host.prepareReferenceTasksMove(request));
                expect(nativeValue(host.validatePreparedReferenceTasksMove({ request, prepared: planned.prepared })))
                    .toEqual({ count: 2, status: 'next' });
                const moved = new Map(planned.prepared.effect.tasks.map((pair) => [pair.after.id, pair.after]));
                expect([...moved.keys()].sort()).toEqual([...taskIds].sort());
                for (const source of sources) {
                    expect(moved.get(source.id)).toMatchObject({ status: 'next', rev: (source.rev ?? 0) + 1 });
                }
                expect(planned.prepared.effect.createdTasks).toEqual([]);
                expect(planned.prepared.effect.projects).toEqual([]);
                expect(planned.prepared.effect.sections).toEqual([]);
                const durable = nativeValue(await readAreaDurableData(false, true));
                const before = durable.authority.snapshot;
                control.expectPersisted((written) => {
                    expect(written.tasks).toEqual(before.tasks.map((row) => moved.get(row.id) ?? row));
                    expect(written.projects).toEqual(before.projects);
                    expect(written.sections).toEqual(before.sections);
                    expect(written.settings).toEqual(before.settings);
                });
                control.resetBaseline();
                expect(await useTaskStore.getState().commitPreparedReferenceTasksMove(planned.prepared, durable.authority))
                    .toEqual({ success: true, ids: taskIds, outcome: 'applied' });
            },
            commitPreparedReferenceTasksAddTag: async (control) => {
                const host = await nativeHost(control);
                const taskIds = ['task-46', 'task-69'];
                const sources = taskIds.map((id) => {
                    const source = useTaskStore.getState()._tasksById.get(id);
                    if (!source || source.status !== 'reference') throw new Error(`Reference Add-tag fixture missing: ${id}`);
                    return source;
                });
                expect(sources[0].tags).toContain('#writing');
                expect(sources[1].tags).not.toContain('#writing');
                const request = { requestId: 'c79d9455-74a4-4cb6-a543-4b5f7a717195', taskIds,
                    taskRevisions: Object.fromEntries(sources.map((source) => [source.id, taskRevisionOf(source)])),
                    tag: ' ###writing ', params: {} };
                const planned = nativeValue(await host.prepareReferenceTasksAddTag(request));
                if (planned.kind !== 'prepared') throw new Error('Reference Add-tag fixture unexpectedly produced a no-op');
                expect(nativeValue(host.validatePreparedReferenceTasksAddTag({ request, prepared: planned.prepared })))
                    .toEqual({ count: 1, changed: true });
                const durable = nativeValue(await readAreaDurableData(false, true));
                const before = durable.authority.snapshot;
                const rawSources = taskIds.map((id) => {
                    const row = before.tasks.find((task) => task.id === id);
                    const raw = row && rawReadTaskSnapshot(row);
                    if (!raw) throw new Error(`Reference Add-tag raw fixture missing: ${id}`);
                    return raw;
                });
                const expectedUpdates = buildBulkTaskTokenUpdates(taskIds,
                    new Map(rawSources.map((row) => [row.id, row])), 'tags', request.tag.trim(), 'add');
                expect(expectedUpdates.map((update) => update.id)).toEqual(['task-69']);
                const tagged = new Map(planned.prepared.effect.tasks.map((pair) => [pair.after.id, pair.after]));
                expect([...tagged.keys()]).toEqual(['task-69']);
                expect(tagged.get('task-69')).toMatchObject({ status: 'reference',
                    tags: expectedUpdates[0].updates.tags, rev: (sources[1].rev ?? 0) + 1 });
                expect(planned.prepared.effect.projects).toEqual([]);
                expect(planned.prepared.effect.sections).toEqual([]);
                control.expectPersisted((written) => {
                    expect(written.tasks).toEqual(before.tasks.map((row) => tagged.get(row.id) ?? row));
                    expect(written.tasks.find((row) => row.id === 'task-46')).toEqual(before.tasks.find((row) => row.id === 'task-46'));
                    expect(written.projects).toEqual(before.projects);
                    expect(written.sections).toEqual(before.sections);
                    expect(written.areas).toEqual(before.areas);
                    expect(written.people).toEqual(before.people);
                    expect(written.settings).toEqual(before.settings);
                });
                control.resetBaseline();
                expect(await useTaskStore.getState().commitPreparedReferenceTasksAddTag(planned.prepared, durable.authority))
                    .toEqual({ success: true, ids: taskIds, outcome: 'applied' });
            },
            commitPreparedReferenceTasksRemoveTag: async (control) => {
                const host = await nativeHost(control);
                const taskIds = ['task-46', 'task-69'];
                const sources = taskIds.map((id) => {
                    const source = useTaskStore.getState()._tasksById.get(id);
                    if (!source || source.status !== 'reference') throw new Error(`Reference Remove-tag fixture missing: ${id}`);
                    return source;
                });
                expect(sources[0].tags).toContain('#writing');
                expect(sources[1].tags).not.toContain('#writing');
                const request = { requestId: 'c79d9455-74a4-4cb6-a543-4b5f7a717196', taskIds,
                    taskRevisions: Object.fromEntries(sources.map((source) => [source.id, taskRevisionOf(source)])),
                    tags: [' ###writing '], params: {} };
                const planned = nativeValue(await host.prepareReferenceTasksRemoveTag(request));
                if (planned.kind !== 'prepared') throw new Error('Reference Remove-tag fixture unexpectedly produced a no-op');
                expect(nativeValue(host.validatePreparedReferenceTasksRemoveTag({ request, prepared: planned.prepared })))
                    .toEqual({ count: 1, changed: true });
                const durable = nativeValue(await readAreaDurableData(false, true));
                const before = durable.authority.snapshot;
                const rawSources = taskIds.map((id) => {
                    const row = before.tasks.find((task) => task.id === id);
                    const raw = row && rawReadTaskSnapshot(row);
                    if (!raw) throw new Error(`Reference Remove-tag raw fixture missing: ${id}`);
                    return raw;
                });
                const expectedUpdates = buildBulkTaskTokenUpdates(taskIds,
                    new Map(rawSources.map((row) => [row.id, row])), 'tags', request.tags, 'remove');
                expect(expectedUpdates.map((update) => update.id)).toEqual(['task-46']);
                const tagged = new Map(planned.prepared.effect.tasks.map((pair) => [pair.after.id, pair.after]));
                expect([...tagged.keys()]).toEqual(['task-46']);
                expect(tagged.get('task-46')).toMatchObject({ status: 'reference',
                    tags: expectedUpdates[0].updates.tags, rev: (sources[0].rev ?? 0) + 1 });
                expect(planned.prepared.effect.projects).toEqual([]);
                expect(planned.prepared.effect.sections).toEqual([]);
                control.expectPersisted((written) => {
                    expect(written.tasks).toEqual(before.tasks.map((row) => tagged.get(row.id) ?? row));
                    expect(written.tasks.find((row) => row.id === 'task-69')).toEqual(before.tasks.find((row) => row.id === 'task-69'));
                    expect(written.projects).toEqual(before.projects);
                    expect(written.sections).toEqual(before.sections);
                    expect(written.areas).toEqual(before.areas);
                    expect(written.people).toEqual(before.people);
                    expect(written.settings).toEqual(before.settings);
                });
                control.resetBaseline();
                expect(await useTaskStore.getState().commitPreparedReferenceTasksRemoveTag(planned.prepared, durable.authority))
                    .toEqual({ success: true, ids: taskIds, outcome: 'applied' });
            },
            commitPreparedArchivedTasksRestore: async (control) => {
                const host = await nativeHost(control);
                const taskIds = ['task-29', 'task-58'];
                const sources = taskIds.map((id) => {
                    const source = useTaskStore.getState()._tasksById.get(id);
                    expect(source?.status).toBe('archived');
                    if (!source) throw new Error(`Bulk Restore fixture task missing: ${id}`);
                    return source;
                });
                const request = { requestId: 'ba3a4597-afce-4606-895d-e74161f3e2f0', taskIds,
                    taskRevisions: Object.fromEntries(sources.map((source) => [source.id, taskRevisionOf(source)])) };
                const planned = nativeValue(await host.prepareArchivedTasksRestore(request));
                const envelope = { request, prepared: planned.prepared };
                expect(nativeValue(host.validatePreparedArchivedTasksRestore(envelope)))
                    .toEqual({ count: 2, status: 'inbox' });
                const restored = new Map(planned.prepared.effect.tasks.map((pair) => [pair.after.id, pair.after]));
                expect([...restored.keys()].sort()).toEqual([...taskIds].sort());
                for (const source of sources) {
                    expect(restored.get(source.id)).toMatchObject({ status: 'inbox', rev: (source.rev ?? 0) + 1 });
                }
                const durable = nativeValue(await readAreaDurableData(false, true));
                const before = durable.authority.snapshot;
                control.expectPersisted((written) => {
                    expect(written.tasks).toEqual(before.tasks.map((row) => restored.get(row.id) ?? row));
                    expect(written.projects).toEqual(before.projects);
                    expect(written.sections).toEqual(before.sections);
                    expect(written.settings).toEqual(before.settings);
                });
                control.resetBaseline();
                expect(await useTaskStore.getState().commitPreparedArchivedTasksRestore(planned.prepared, durable.authority))
                    .toEqual({ success: true, ids: taskIds, outcome: 'applied' });
            },
            commitPreparedPersonCreate: async (control) => {
                const host = await nativeHost(control);
                const request = { requestId: 'd97f91ae-d02d-48a5-90ef-fc26a14343b9',
                    expectedPersonId: 'd97f91ae-d02d-48a5-90ef-fc26a14343b9',
                    name: 'Contract prepared person', note: 'Contract person note',
                    referenceLink: 'https://example.com/contract-person' };
                const planned = nativeValue(host.preparePersonCreate(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.people).toHaveLength((settled.people ?? []).length + 1);
                    expect(written.people?.find((entry) => entry.id === request.expectedPersonId))
                        .toEqual(planned.prepared.effect.person.after);
                });
                expect(nativeValue(await host.commitPreparedPersonCreate({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
                expect(useTaskStore.getState()._peopleById.get(request.expectedPersonId))
                    .toEqual(planned.prepared.effect.person.after);
            },
            commitPreparedPersonEdit: async (control) => {
                const host = await nativeHost(control);
                const options = nativeValue(host.getPersonEditOptions({ personId }));
                const request = { requestId: 'd242af1d-03ec-477b-bc94-a69bef840fc2', personId,
                    expected: options.expected, name: 'Contract prepared Person rename',
                    note: 'Contract edited Person note', referenceLink: 'https://example.com/edited-person' };
                const planned = nativeValue(await host.preparePersonEdit(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    for (const { after } of planned.prepared.effect.people) {
                        expect(written.people?.find((entry) => entry.id === after.id)).toEqual(after);
                    }
                    for (const { after } of planned.prepared.effect.tasks) {
                        expect(written.tasks.find((entry) => entry.id === after.id)).toEqual(after);
                    }
                });
                expect(nativeValue(await host.commitPreparedPersonEdit({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
                expect(useTaskStore.getState()._peopleById.get(personId))
                    .toEqual(planned.prepared.effect.people[0].after);
            },
            commitPreparedPersonDelete: async (control) => {
                const host = await nativeHost(control);
                const options = nativeValue(host.getPersonDeleteOptions({ personId }));
                const tasksBefore = structuredClone(useTaskStore.getState()._allTasks);
                const request = { requestId: '4fe981c0-9ed3-4d62-ad4b-466a32ae7af1',
                    personId, expected: options.expected };
                const planned = nativeValue(host.preparePersonDelete(request));
                control.expectPersisted((written) => {
                    expect(written.people).toHaveLength((settled.people ?? []).length);
                    expect(written.people?.find((entry) => entry.id === personId))
                        .toEqual(planned.prepared.effect.person.after);
                    expect(written.tasks).toEqual(tasksBefore);
                });
                expect(nativeValue(await host.commitPreparedPersonDelete({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
                expect(useTaskStore.getState()._peopleById.get(personId))
                    .toEqual(planned.prepared.effect.person.after);
            },
            commitPreparedBoardTask: async (control) => {
                const host = await nativeHost(control);
                const planned = nativeValue(host.prepareBoardAction({ requestId: 'b4bc3331-c119-421c-965a-1fca51e5484e',
                    action: { type: 'trashTask', taskId } }));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.tasks.find((entry) => entry.id === taskId)).toMatchObject({
                        deletedAt: planned.prepared.after.deletedAt,
                        updatedAt: planned.prepared.after.updatedAt,
                        rev: planned.prepared.after.rev,
                    });
                });
                expect(nativeValue(await host.commitPreparedBoardAction({ request: planned.prepared.request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
                expect(useTaskStore.getState()._tasksById.get(taskId)?.deletedAt).toBe(planned.prepared.after.deletedAt);
            },
            commitPreparedCalendarTask: async (control) => {
                const host = await nativeHost(control);
                const opened = nativeValue(host.openCalendarComposer({ scheduleTaskId: taskId, day: '2030-10-03' }));
                expect(opened.composer).not.toBeNull();
                const planned = nativeValue(await host.prepareCalendarComposerSave({ requestId: '6ed085ea-a209-426b-b35c-23a073214b11',
                    composer: opened.composer!.composer }));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.tasks.find((entry) => entry.id === taskId)).toMatchObject({
                        startTime: planned.prepared.after.startTime,
                        timeEstimate: planned.prepared.after.timeEstimate,
                        updatedAt: planned.prepared.after.updatedAt,
                        rev: planned.prepared.after.rev,
                    });
                });
                expect(nativeValue(await host.commitPreparedCalendarComposerSave({ request: planned.prepared.request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
                expect(useTaskStore.getState()._tasksById.get(taskId)?.startTime).toBe(planned.prepared.after.startTime);
            },
            commitPreparedCalendarCreate: async (control) => {
                const host = await nativeHost(control);
                const opened = nativeValue(host.openCalendarComposer({ day: '2030-10-03', mode: 'new' }));
                expect(opened.composer).not.toBeNull();
                const edited = nativeValue(host.editCalendarComposer({ composer: opened.composer!.composer,
                    edit: { type: 'title', title: 'Contract calendar creation +Calendar Contract Project' } }));
                const planned = nativeValue(await host.prepareCalendarComposerCreate({
                    requestId: '23ff74b8-55b2-4380-8bf2-9db4be1d5bb1', composer: edited.composer,
                }));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                expect(planned.prepared.project).not.toBeNull();
                control.expectPersisted((written) => {
                    expect(written.tasks.find((entry) => entry.id === planned.prepared.task.id)).toMatchObject({
                        id: planned.prepared.task.id, title: planned.prepared.task.title,
                        startTime: planned.prepared.task.startTime, projectId: planned.prepared.project?.id, rev: 1,
                    });
                    expect(written.projects.find((entry) => entry.id === planned.prepared.project?.id)).toMatchObject({
                        id: planned.prepared.project?.id, title: 'Calendar Contract Project', rev: 1,
                    });
                });
                expect(nativeValue(await host.commitPreparedCalendarComposerCreate({ request: planned.prepared.request,
                    prepared: planned.prepared }))).toEqual(planned.prepared.result);
                expect(useTaskStore.getState()._tasksById.get(planned.prepared.task.id)?.title).toBe('Contract calendar creation');
            },
            commitPreparedInboxEffect: async (control) => {
                const host = await nativeHost(control);
                const opening = nativeValue(host.startInboxProcessing());
                expect(opening.view).not.toBeNull();
                const normalized = await useTaskStore.getState().updateTask(opening.view!.taskId, {
                    projectId: undefined, sectionId: undefined, areaId: undefined,
                });
                expect(normalized.success).toBe(true);
                await flushPendingSave();
                control.resetBaseline();
                const started = nativeValue(host.startInboxProcessing());
                expect(started.view).not.toBeNull();
                const request = { sessionId: started.sessionId!, taskId: started.view!.taskId,
                    requestId: '81127b54-36e0-4ce7-805c-9ae5f05908e5' };
                const planned = nativeValue(host.inboxSkipPrepare(request));
                expect(planned.kind).toBe('prepared');
                const after = planned.prepared.effect.tasks.find((row) => row.after.id === request.taskId)?.after;
                expect(after).toBeDefined();
                control.expectPersisted((written) => {
                    expect(written.tasks.find((entry) => entry.id === request.taskId)).toMatchObject({
                        id: request.taskId, title: after?.title, status: after?.status,
                        updatedAt: after?.updatedAt, rev: after?.rev, revBy: after?.revBy,
                    });
                });
                expect(nativeValue(await host.inboxPreparedCommit({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
                expect(useTaskStore.getState()._tasksById.get(request.taskId)?.rev).toBe(after?.rev);
            },
            commitPreparedChecklistEffect: async (control) => {
                const host = await nativeHost(control);
                const model = nativeValue(host.getTaskEditorModel({ id: taskId }));
                const item = { id: 'e814baef-5a87-4d8a-8248-c16573ed873d', title: 'Contract checklist', isCompleted: false };
                const request = { id: taskId, requestId: '10ee2eba-dc80-46c7-9b36-50b58662120a',
                    base: { title: model.draft.title }, patch: { title: 'Contract checklist edit' },
                    scheduleBase: model.scheduleBase,
                    checklist: { base: useTaskStore.getState()._tasksById.get(taskId)?.checklist ?? [], value: [item] } };
                const planned = nativeValue(host.prepareTaskChecklistSave(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                const after = planned.prepared.effect.tasks.find((row) => row.after.id === taskId)?.after;
                control.expectPersisted((written) => {
                    expect(written.tasks.find((entry) => entry.id === taskId)).toMatchObject({
                        title: 'Contract checklist edit', checklist: [item], rev: after?.rev,
                    });
                });
                expect(nativeValue(await host.commitPreparedTaskChecklistWrite({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
                expect(useTaskStore.getState()._tasksById.get(taskId)).toMatchObject({
                    title: 'Contract checklist edit', checklist: [item], rev: after?.rev,
                });
            },
            commitPreparedFocusOrder: async (control) => {
                const host = await nativeHost(control);
                const extra = nextTaskIds.find((id) => !focusIds.includes(id));
                expect(extra).toBeDefined();
                expect((await useTaskStore.getState().updateTask(extra!, { isFocusedToday: true })).success).toBe(true);
                await flushPendingSave();
                control.resetBaseline();
                const options = nativeValue(host.getFocusOrderOptions({ controls: DEFAULT_FOCUS_CONTROL_STATE }));
                const ids = options.rows.map((row) => row.id).reverse();
                expect(ids.length, 'fixture must supply two or more Focus tasks').toBeGreaterThan(1);
                const request = { requestId: 'c3a4f0d2-5b8e-4f1a-9d67-2e0b7c1f4a58',
                    controls: options.controls, ids, expectedOrder: options.expectedOrder };
                const planned = nativeValue(host.prepareFocusOrder(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    ids.forEach((id, index) => {
                        expect(written.tasks.find((entry) => entry.id === id)?.focusOrder).toBe(index);
                    });
                });
                expect(nativeValue(await host.commitPreparedFocusOrder({ request, prepared: planned.prepared })))
                    .toEqual({ ids });
            },
            commitPreparedFocusSavedFilter: async (control) => {
                const host = await nativeHost(control);
                const operation = { type: 'save' as const };
                const controls = { ...DEFAULT_FOCUS_CONTROL_STATE,
                    filters: { ...DEFAULT_FOCUS_CONTROL_STATE.filters, tokens: ['@work'] } };
                const options = nativeValue(host.getFocusSavedFilterOptions({ controls, operation }));
                const request = { requestId: '6d1e9b47-0a3c-4e25-8f19-b5c2d7e8a031', controls: options.controls,
                    operation, name: 'Contract Focus filter', expected: options.expected };
                const planned = nativeValue(host.prepareFocusSavedFilter(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.settings.savedFilters?.find((filter) => filter.id === request.requestId))
                        .toMatchObject({ name: 'Contract Focus filter' });
                });
                expect(nativeValue(await host.commitPreparedFocusSavedFilter({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
            },
            commitPreparedSavedSearchWrite: async (control) => {
                const host = await nativeHost(control);
                const operation = { type: 'save' as const, query: '#contract' };
                const options = nativeValue(host.getSavedSearchWriteOptions({ operation }));
                const request = { requestId: '49b253b9-a22c-43b1-9de6-f568a6250ae9', operation,
                    name: 'Contract search', expected: options.expected };
                const planned = nativeValue(host.prepareSavedSearchWrite(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.settings.savedSearches).toEqual(planned.prepared.after.savedSearches);
                    expect(written.settings.savedSearchesUpdatedAt).toBe(planned.prepared.after.stamp);
                });
                expect(nativeValue(await host.commitPreparedSavedSearchWrite({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
            },
            commitPreparedProjectCreate: async (control) => {
                const host = await nativeHost(control);
                const request = { requestId: 'a18279a3-1920-4453-a715-c123e1595304',
                    title: 'Contract prepared project', areaId: null };
                const planned = nativeValue(host.prepareProjectCreate(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.projects.find((entry) => entry.id === request.requestId)).toEqual(planned.prepared.project);
                });
                expect(nativeValue(await host.commitPreparedProjectCreate({ request, prepared: planned.prepared })))
                    .toEqual({ id: request.requestId, created: true });
                expect(useTaskStore.getState()._projectsById.get(request.requestId)).toEqual(planned.prepared.project);
            },
            commitPreparedProjectAttachmentWrite: async (control) => {
                const host = await nativeHost(control);
                const options = nativeValue(host.getProjectAttachmentEditOptions({ projectId: settled.projects[1].id }));
                const { id, ...expected } = options.project;
                const request = { requestId: '596486b8-859c-4ad0-81a0-1184ed595106', projectId: id,
                    intent: { kind: 'add' as const, text: 'Contract | https://example.org/contract' }, expected };
                const planned = nativeValue(host.prepareProjectAttachmentWrite(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.projects.find((entry) => entry.id === id))
                        .toEqual(planned.prepared.effect.project.after);
                });
                expect(nativeValue(await host.commitPreparedProjectAttachmentWrite({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
            },
            commitPreparedProjectFileAddWrite: async (control) => {
                const host = await nativeHost(control);
                const before = nativeValue(await readAreaDurableData(false, true)).authority.snapshot;
                const options = nativeValue(host.getProjectAttachmentEditOptions({ projectId: settled.projects[1].id }));
                const { id, ...expected } = options.project;
                const request = { requestId: '87191485-2aba-4d0f-85d1-f2f9d791c174', projectId: id, expected,
                    picked: { uri: 'file:///provider/contract.pdf', name: 'contract.pdf', mimeType: 'application/pdf', size: null },
                    measuredSize: 27, managedDirectoryURI: 'file:///documents/attachments/' };
                const planned = nativeValue(await host.prepareProjectFileAddWrite(request));
                if (planned.kind !== 'prepared') throw new Error('Project file Add must prepare a real write');
                expect(planned.prepared.effect.project.after.attachments).toEqual([
                    ...(planned.prepared.scope.project.attachments ?? []), planned.prepared.attachment,
                ]);
                expect(planned.prepared.attachment).toMatchObject({ id: request.requestId, kind: 'file', size: 27,
                    uri: `file:///documents/attachments/${request.requestId}.pdf` });
                control.expectPersisted((written) => {
                    expect(written.projects).toEqual(before.projects.map((row) => row.id === id
                        ? planned.prepared.effect.project.after : row));
                    expect(written.tasks).toEqual(before.tasks);
                    expect(written.sections).toEqual(before.sections);
                    expect(written.settings).toEqual(before.settings);
                });
                control.resetBaseline();
                expect(nativeValue(await host.commitPreparedProjectFileAddWrite({ request, prepared: planned.prepared })))
                    .toEqual({ id, attachmentIds: [request.requestId] });
            },
            commitPreparedProjectFileAvailability: async (control) => {
                const id = settled.projects[1].id;
                const attachment = fileAttachment('5d0f7a1e-3c2b-4e8f-9a61-2b7c4d9e0f13', {
                    uri: 'file:///old/attachments/5d0f7a1e-3c2b-4e8f-9a61-2b7c4d9e0f13.pdf', localStatus: 'missing',
                });
                expect(await call('updateProject', id, { attachments: [attachment] })).toMatchObject({ success: true });
                await nativeHost(control);
                const durable = nativeValue(await readAreaDurableData(false, true));
                const before = durable.authority.snapshot;
                const row = before.projects.find((entry) => entry.id === id)!;
                const source = rawReadProjectSnapshot(row)!;
                const deviceId = before.settings.deviceId ?? null;
                const planned = projectFileAvailabilityWritePlan(source, [...rawReadRow(row, projectToSqliteRow(row)).row],
                    attachment.id, 'file:///current/attachments/5d0f7a1e-3c2b-4e8f-9a61-2b7c4d9e0f13.pdf',
                    deviceId, null, NOW_ISO);
                if (!planned) throw new Error('Prepared Project file availability must prepare a real write');
                control.expectPersisted((written) => {
                    expect(written.projects).toEqual(before.projects.map((entry) => entry.id === id ? planned.after : entry));
                    expect(written.tasks).toEqual(before.tasks);
                    expect(written.sections).toEqual(before.sections);
                    expect(written.settings).toEqual(before.settings);
                });
                control.resetBaseline();
                expect(await useTaskStore.getState().commitPreparedProjectFileAvailability(planned, durable.authority))
                    .toEqual({ success: true, id, outcome: 'applied' });
            },
            commitSelectedProjectAvailability: async (control) => {
                const id = settled.projects[1].id;
                const attachment = fileAttachment('86a0cbe9-4d30-498e-8d82-7721769a8299', {
                    uri: 'file:///old/attachments/86a0cbe9-4d30-498e-8d82-7721769a8299.pdf', localStatus: 'missing',
                });
                expect(await call('updateProject', id, { attachments: [attachment] })).toMatchObject({ success: true });
                await nativeHost(control);
                const durable = nativeValue(await readAreaDurableData(false, true));
                const before = durable.authority.snapshot;
                const row = before.projects.find((entry) => entry.id === id)!;
                const source = rawReadProjectSnapshot(row)!;
                const deviceId = before.settings.deviceId ?? null;
                const planned = projectAvailabilityWritePlan(source, [...rawReadRow(row, projectToSqliteRow(row)).row],
                    attachment.id, 'file:///current/attachments/86a0cbe9-4d30-498e-8d82-7721769a8299.pdf',
                    deviceId, null, NOW_ISO);
                if (!planned) throw new Error('Selected Project availability must prepare a real write');
                control.expectPersisted((written) => {
                    expect(written.projects).toEqual(before.projects.map((entry) => entry.id === id ? planned.after : entry));
                    expect(written.tasks).toEqual(before.tasks);
                    expect(written.sections).toEqual(before.sections);
                    expect(written.settings).toEqual(before.settings);
                });
                control.resetBaseline();
                expect(await useTaskStore.getState().commitSelectedProjectAvailability(planned, durable.authority))
                    .toEqual({ success: true, id, outcome: 'applied' });
            },
            commitPreparedProjectFileRemoveWrite: async (control) => {
                const projectId = settled.projects[1].id;
                const attachment = fileAttachment('contract-project-file');
                expect(await call('updateProject', projectId, { attachments: [attachment] })).toMatchObject({ success: true });
                const host = await nativeHost(control);
                const before = nativeValue(await readAreaDurableData(false, true)).authority.snapshot;
                const options = nativeValue(host.getProjectAttachmentEditOptions({ projectId }));
                const { id, ...expected } = options.project;
                const request = { requestId: '42532daa-9a6d-48f7-8b34-1c07eb266e5a', projectId: id,
                    intent: { kind: 'remove' as const, attachmentId: attachment.id }, expected };
                const planned = nativeValue(host.prepareProjectFileRemoveWrite(request));
                if (planned.kind !== 'prepared') throw new Error('Project file Remove must prepare a real write');
                expect(planned.prepared.effect.project.after.attachments).toEqual([
                    { ...attachment, deletedAt: planned.prepared.updateAt, updatedAt: planned.prepared.updateAt },
                ]);
                control.expectPersisted((written) => {
                    expect(written.projects).toEqual(before.projects.map((row) => row.id === id
                        ? planned.prepared.effect.project.after : row));
                    expect(written.tasks).toEqual(before.tasks);
                    expect(written.sections).toEqual(before.sections);
                    expect(written.settings).toEqual(before.settings);
                });
                control.resetBaseline();
                expect(nativeValue(await host.commitPreparedProjectFileRemoveWrite({ request, prepared: planned.prepared })))
                    .toEqual({ id, attachmentIds: [attachment.id] });
            },
            commitPreparedProjectFocus: async (control) => {
                const host = await nativeHost(control);
                const options = nativeValue(host.getProjectFocusOptions({ projectId: settled.projects[1].id }));
                const { id, ...expected } = options.project;
                const request = { requestId: '513f638c-d2c5-4693-80f3-9bdb6cfd8259', projectId: id,
                    focused: !expected.isFocused, expected };
                const planned = nativeValue(host.prepareProjectFocus(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.projects.find((entry) => entry.id === id))
                        .toEqual(planned.prepared.effect.project.after);
                });
                expect(nativeValue(await host.commitPreparedProjectFocus({ request, prepared: planned.prepared })))
                    .toEqual({ id, focused: request.focused });
                expect(useTaskStore.getState()._projectsById.get(id))
                    .toEqual(planned.prepared.effect.project.after);
            },
            commitPreparedProjectRename: async (control) => {
                const host = await nativeHost(control);
                const options = nativeValue(host.getProjectRenameOptions({ projectId: settled.projects[1].id }));
                const { id, ...expected } = options.project;
                const request = { requestId: 'b0e4f0ea-0674-438f-9d91-29c7b9c69719', projectId: id,
                    title: '  Contract renamed project  ', expected };
                const planned = nativeValue(host.prepareProjectRename(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.projects.find((entry) => entry.id === id))
                        .toEqual(planned.prepared.effect.project.after);
                });
                expect(nativeValue(await host.commitPreparedProjectRename({ request, prepared: planned.prepared })))
                    .toEqual({ id, title: 'Contract renamed project' });
                expect(useTaskStore.getState()._projectsById.get(id))
                    .toEqual(planned.prepared.effect.project.after);
            },
            commitPreparedProjectFlow: async (control) => {
                const host = await nativeHost(control);
                const options = nativeValue(host.getProjectFlowOptions({ projectId: settled.projects[1].id }));
                const { id, ...expected } = options.project;
                const request = { requestId: '39e8c6d4-d313-44d4-b1e3-80bbeb15e28a', projectId: id,
                    action: { kind: 'toggleType' as const }, expected };
                const planned = nativeValue(host.prepareProjectFlow(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.projects.find((entry) => entry.id === id))
                        .toEqual(planned.prepared.effect.project.after);
                });
                expect(nativeValue(await host.commitPreparedProjectFlow({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
                expect(useTaskStore.getState()._projectsById.get(id))
                    .toEqual(planned.prepared.effect.project.after);
            },
            commitPreparedProjectNotesWrite: async (control) => {
                const host = await nativeHost(control);
                const options = nativeValue(host.getProjectNotesEditOptions({ projectId: settled.projects[1].id }));
                const { id, ...expected } = options.project;
                const request = { requestId: 'bf72ce5a-3b79-4479-af72-87a8bfd40228', projectId: id,
                    text: 'Contract notes\n\n- Keep raw Markdown', expected };
                const planned = nativeValue(host.prepareProjectNotesWrite(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.projects.find((entry) => entry.id === id))
                        .toEqual(planned.prepared.effect.project.after);
                });
                expect(nativeValue(await host.commitPreparedProjectNotesWrite({ request, prepared: planned.prepared })))
                    .toEqual({ id, supportNotes: request.text });
                expect(useTaskStore.getState()._projectsById.get(id))
                    .toEqual(planned.prepared.effect.project.after);
            },
            commitPreparedProjectTaskSort: async (control) => {
                const host = await nativeHost(control);
                const options = nativeValue(host.getProjectTaskSortOptions({ projectId: settled.projects[1].id }));
                const { id, ...expected } = options.project;
                const request = { requestId: '65b6a58a-e179-42d6-85ab-216da678a940', projectId: id,
                    sortBy: 'title' as const, expected };
                const planned = nativeValue(host.prepareProjectTaskSort(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.projects.find((entry) => entry.id === id))
                        .toEqual(planned.prepared.effect.project.after);
                });
                expect(nativeValue(await host.commitPreparedProjectTaskSort({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
                expect(useTaskStore.getState()._projectsById.get(id))
                    .toEqual(planned.prepared.effect.project.after);
            },
            commitPreparedProjectTagsWrite: async (control) => {
                const host = await nativeHost(control);
                const options = nativeValue(host.getProjectTagsEditOptions({ projectId: settled.projects[1].id }));
                const { id, ...expected } = options.project;
                const request = { requestId: '7bd4eac2-8670-41b9-a3b9-f35ae022a8d5', projectId: id,
                    intent: { kind: 'add' as const, input: '  ContractTag  ' }, expected };
                const planned = nativeValue(host.prepareProjectTagsWrite(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                expect(planned.prepared.result.tagIds).toContain('#ContractTag');
                control.expectPersisted((written) => {
                    expect(written.projects.find((entry) => entry.id === id))
                        .toEqual(planned.prepared.effect.project.after);
                });
                expect(nativeValue(await host.commitPreparedProjectTagsWrite({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
                expect(useTaskStore.getState()._projectsById.get(id))
                    .toEqual(planned.prepared.effect.project.after);
            },
            commitPreparedProjectDuplicate: async (control) => {
                const host = await nativeHost(control);
                const detail = nativeValue(host.getProjectDetail({ projectId, offset: 0, limit: 50 }));
                const request = { requestId: 'e271e152-5674-4a6a-a8d9-b8bca8c62152', projectId,
                    projectRevision: detail.projectRevision };
                const planned = nativeValue(host.prepareProjectDuplicate(request));
                control.expectPersisted((written) => {
                    expect(written.projects.find((entry) => entry.id === planned.prepared.result.id))
                        .toEqual(planned.prepared.effect.project);
                    for (const row of planned.prepared.effect.sections) {
                        expect(written.sections.find((entry) => entry.id === row.id)).toEqual(row);
                    }
                    for (const row of planned.prepared.effect.tasks) {
                        expect(written.tasks.find((entry) => entry.id === row.id)).toEqual(row);
                    }
                });
                expect(nativeValue(await host.commitPreparedProjectDuplicate({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
            },
            commitPreparedProjectLifecycle: async (control) => {
                const host = await nativeHost(control);
                const detail = nativeValue(host.getProjectDetail({ projectId, offset: 0, limit: 50 }));
                const request = { requestId: 'aede1553-95af-4f8c-bd21-c1c5a4a63153', projectId,
                    projectRevision: detail.projectRevision, action: 'complete' as const };
                const deletion = { request, prepared: nativeValue(host.prepareProjectLifecycle(request)).prepared };
                const planned = { prepared: deletion.prepared };
                control.expectPersisted((written) => {
                    expect(written.projects.find((entry) => entry.id === projectId)).toEqual(planned.prepared.effect.project.after);
                    for (const pair of planned.prepared.effect.sections) {
                        expect(written.sections.find((entry) => entry.id === pair.after.id)).toEqual(pair.after);
                    }
                    for (const pair of planned.prepared.effect.tasks) {
                        expect(written.tasks.find((entry) => entry.id === pair.after.id)).toEqual(pair.after);
                    }
                });
                expect(nativeValue(await host.commitPreparedProjectLifecycle(deletion))).toEqual(planned.prepared.result);
            },
            commitPreparedProjectDelete: async (control) => {
                const host = await nativeHost(control);
                const detail = nativeValue(host.getProjectDetail({ projectId, offset: 0, limit: 50 }));
                const request = { requestId: 'aede1551-95af-4f8c-bd21-c1c5a4a63151', projectId,
                    projectRevision: detail.projectRevision };
                const deletion = { request, prepared: nativeValue(host.prepareProjectDelete(request)).prepared };
                const planned = { prepared: deletion.prepared };
                control.expectPersisted((written) => {
                    expect(written.projects.find((entry) => entry.id === projectId)).toEqual(planned.prepared.effect.project.after);
                    for (const pair of planned.prepared.effect.sections) {
                        expect(written.sections.find((entry) => entry.id === pair.after.id)).toEqual(pair.after);
                    }
                    for (const pair of planned.prepared.effect.tasks) {
                        expect(written.tasks.find((entry) => entry.id === pair.after.id)).toEqual(pair.after);
                    }
                });
                expect(nativeValue(await host.commitPreparedProjectDelete(deletion))).toEqual(planned.prepared.result);
            },
            commitPreparedProjectDeleteUndo: async (control) => {
                const host = await nativeHost(control);
                const detail = nativeValue(host.getProjectDetail({ projectId, offset: 0, limit: 50 }));
                const request = { requestId: 'aede1551-95af-4f8c-bd21-c1c5a4a63151', projectId,
                    projectRevision: detail.projectRevision };
                const deletion = { request, prepared: nativeValue(host.prepareProjectDelete(request)).prepared };
                nativeValue(await host.commitPreparedProjectDelete(deletion));
                await flushPendingSave(); control.resetBaseline();
                const undoRequest = { requestId: 'bdd31551-95af-4f8c-bd21-c1c5a4a63151', deleteRequestId: request.requestId };
                const planned = nativeValue(host.prepareProjectDeleteUndo({ request: undoRequest, delete: deletion }));
                control.expectPersisted((written) => {
                    expect(written.projects.find((entry) => entry.id === projectId)).toEqual(planned.prepared.effect.project.after);
                    for (const pair of planned.prepared.effect.sections) {
                        expect(written.sections.find((entry) => entry.id === pair.after.id)).toEqual(pair.after);
                    }
                    for (const pair of planned.prepared.effect.tasks) {
                        expect(written.tasks.find((entry) => entry.id === pair.after.id)).toEqual(pair.after);
                    }
                });
                expect(nativeValue(await host.commitPreparedProjectDeleteUndo({ request: undoRequest, prepared: planned.prepared })))
                    .toEqual({ id: projectId });
            },
            commitPreparedTrashProjectRestore: async (control) => {
                await call('deleteProject', projectId);
                const host = await nativeHost(control);
                const trash = nativeValue(host.getTrashView({ offset: 0, limit: 50 }));
                const row = trash.items.find((entry) => entry.type === 'project' && entry.id === projectId);
                if (!row || row.type !== 'project') throw new Error('Deleted Project missing from Trash');
                const request = { requestId: '5bebf523-dd4e-40dc-9fce-37e456295d49', projectId,
                    projectRevision: row.projectRevision };
                const planned = nativeValue(host.prepareTrashProjectRestore(request));
                control.expectPersisted((written) => {
                    expect(written.projects.find((entry) => entry.id === projectId))
                        .toEqual(planned.prepared.effect.project.after);
                    for (const pair of planned.prepared.effect.sections) {
                        expect(written.sections.find((entry) => entry.id === pair.after.id)).toEqual(pair.after);
                    }
                    for (const pair of planned.prepared.effect.tasks) {
                        expect(written.tasks.find((entry) => entry.id === pair.after.id)).toEqual(pair.after);
                    }
                });
                expect(nativeValue(await host.commitPreparedTrashProjectRestore({ request, prepared: planned.prepared })))
                    .toEqual({ id: projectId });
            },
            commitPreparedProjectStatus: async (control) => {
                const host = await nativeHost(control);
                const options = nativeValue(host.getProjectStatusOptions({ projectId: settled.projects[1].id }));
                const { id, ...expected } = options.project;
                const request = { requestId: 'ae568b39-8e6e-48ac-a94d-b19aa42ab5f2', projectId: id,
                    status: 'waiting' as const, expected };
                const planned = nativeValue(host.prepareProjectStatus(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.projects.find((entry) => entry.id === id))
                        .toEqual(planned.prepared.effect.project.after);
                });
                expect(nativeValue(await host.commitPreparedProjectStatus({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
                expect(useTaskStore.getState()._projectsById.get(id))
                    .toEqual(planned.prepared.effect.project.after);
            },
            commitPreparedProjectDate: async (control) => {
                const host = await nativeHost(control);
                const options = nativeValue(host.getProjectDateOptions({ projectId: settled.projects[1].id,
                    field: 'dueDate' }));
                const { id, ...expected } = options.project;
                const request = { requestId: 'b972f527-3258-4f0d-ac51-3e67fa12ad8a', projectId: id,
                    field: 'dueDate' as const, value: '2028-02-29', expected };
                const planned = nativeValue(host.prepareProjectDate(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.projects.find((entry) => entry.id === id))
                        .toEqual(planned.prepared.effect.project.after);
                });
                expect(nativeValue(await host.commitPreparedProjectDate({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
                expect(useTaskStore.getState()._projectsById.get(id))
                    .toEqual(planned.prepared.effect.project.after);
            },
            commitPreparedProjectArea: async (control) => {
                const host = await nativeHost(control);
                const options = nativeValue(host.getProjectAreaOptions({ projectId: settled.projects[1].id }));
                const { id, ...expected } = options.project;
                const destination = options.areas.find((entry) => entry.id !== expected.areaId);
                if (!destination) throw new Error('fixture needs a different live Area');
                const request = { requestId: 'f3dd566a-5c5e-4126-9ee4-48de195f268b', projectId: id,
                    areaId: destination.id, selectedArea: { id: destination.id, name: destination.label }, expected };
                const planned = nativeValue(host.prepareProjectArea(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.projects.find((entry) => entry.id === id))
                        .toEqual(planned.prepared.effect.project.after);
                });
                expect(nativeValue(await host.commitPreparedProjectArea({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
                expect(useTaskStore.getState()._projectsById.get(id))
                    .toEqual(planned.prepared.effect.project.after);
            },
            commitPreparedProjectSectionCreate: async (control) => {
                const host = await nativeHost(control);
                const projectId = settled.projects[1].id;
                const request = { requestId: '76b4be99-66ce-4aba-bc70-2201b98fc45c',
                    projectId, title: 'Contract Section' };
                const planned = nativeValue(host.prepareProjectSectionCreate(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.sections.find((entry) => entry.id === request.requestId))
                        .toEqual(planned.prepared.section);
                });
                expect(nativeValue(await host.commitPreparedProjectSectionCreate({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
                expect(useTaskStore.getState()._sectionsById.get(request.requestId))
                    .toEqual(planned.prepared.section);
            },
            commitPreparedProjectSectionRename: async (control) => {
                const host = await nativeHost(control);
                const projectId = settled.projects[1].id;
                const sectionId = settled.sections.find((entry) => entry.projectId === projectId && !entry.deletedAt)?.id;
                if (!sectionId) throw new Error('fixture needs a live Section for rename');
                const options = nativeValue(host.getProjectSectionRenameOptions({ projectId, sectionId }));
                const request = { requestId: 'a89a720c-7a85-43a4-a4c0-8c26060ddabb', projectId,
                    sectionId, title: 'Contract renamed Section', expected: options.token };
                const planned = nativeValue(host.prepareProjectSectionRename(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.sections.find((entry) => entry.id === sectionId))
                        .toEqual(planned.prepared.effect.section.after);
                });
                expect(nativeValue(await host.commitPreparedProjectSectionRename({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
                expect(useTaskStore.getState()._sectionsById.get(sectionId))
                    .toEqual(planned.prepared.effect.section.after);
            },
            commitPreparedProjectSectionOrder: async (control) => {
                const host = await nativeHost(control);
                const projectId = settled.projects[1].id;
                const options = nativeValue(host.getProjectSectionOrderOptions({ projectId }));
                const movable = options.sections.find((entry) => entry.canMoveDown);
                if (!movable) throw new Error('fixture needs a movable live Section');
                const request = { requestId: '74254ef4-eb51-44b3-bdee-875731937ed6', projectId,
                    sectionId: movable.id, direction: 'down' as const, expectedSections: options.token };
                const planned = nativeValue(host.prepareProjectSectionOrder(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    for (const { after } of planned.prepared.effect.sections) {
                        expect(written.sections.find((entry) => entry.id === after.id)).toEqual(after);
                    }
                });
                expect(nativeValue(await host.commitPreparedProjectSectionOrder({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
                for (const { after } of planned.prepared.effect.sections) {
                    expect(useTaskStore.getState()._sectionsById.get(after.id)).toEqual(after);
                }
            },
            commitPreparedProjectTaskOrder: async (control) => {
                const host = await nativeHost(control);
                const projectId = settled.projects[1].id;
                const view = nativeValue(host.getProjectTaskOrderView({ projectId, offset: 0, limit: 100,
                    showCompleted: true, filters: {} }));
                const moved = view.items.find((item) => item.type === 'task');
                const target = view.items.find((item) => item.type === 'section'
                    && item.sectionId && item.sectionId !== (moved?.type === 'task' ? moved.sectionId : null));
                if (!moved || moved.type !== 'task' || !target || target.type !== 'section' || !view.orderToken)
                    throw new Error('fixture needs a task and another live Project Section');
                const request = { requestId: 'ed1be6f1-6652-40a5-9053-d045c460cbf9', projectId,
                    taskId: moved.row.id, after: { type: 'section' as const, id: target.id },
                    showCompleted: true, filters: {}, expectedOrder: view.orderToken };
                const planned = nativeValue(host.prepareProjectTaskOrder(request));
                if (planned.kind !== 'prepared') throw new Error('fixture move must change Project task order');
                control.expectPersisted((written) => {
                    for (const { after } of planned.prepared.effect.tasks) {
                        expect(written.tasks.find((entry) => entry.id === after.id)).toEqual(after);
                    }
                });
                expect(nativeValue(await host.commitPreparedProjectTaskOrder({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
            },
            commitPreparedProjectSectionDelete: async (control) => {
                const host = await nativeHost(control);
                const projectId = settled.projects[1].id;
                const sectionId = settled.sections.find((entry) => entry.projectId === projectId && !entry.deletedAt)?.id;
                if (!sectionId) throw new Error('fixture needs a live Section for delete');
                const options = nativeValue(host.getProjectSectionDeleteOptions({ projectId, sectionId }));
                const request = { requestId: '7585364e-8643-4298-97b8-c6c08793997a', projectId,
                    sectionId, expected: options.token };
                const planned = nativeValue(host.prepareProjectSectionDelete(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.sections.find((entry) => entry.id === sectionId))
                        .toEqual(planned.prepared.effect.section.after);
                    for (const { after } of planned.prepared.effect.tasks) {
                        expect(written.tasks.find((entry) => entry.id === after.id)).toEqual(after);
                    }
                });
                expect(nativeValue(await host.commitPreparedProjectSectionDelete({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
                expect(useTaskStore.getState()._sectionsById.get(sectionId))
                    .toEqual(planned.prepared.effect.section.after);
            },
            commitPreparedCapture: async (control) => {
                const host = await nativeHost(control);
                const options = nativeValue(host.openQuickCapture()).options;
                const planned = nativeValue(host.prepareQuickCapture({ text: 'Contract native capture', options,
                    captureId: '02d590b2-3689-41fc-8d72-997b1d49a3ab' }));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.tasks.find((entry) => entry.id === planned.prepared.task.id)).toMatchObject({
                        id: planned.prepared.task.id,
                        title: 'Contract native capture',
                        rev: planned.prepared.task.rev,
                    });
                });
                expect(nativeValue(await host.commitPreparedQuickCapture({ request: planned.prepared.request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
                expect(useTaskStore.getState()._tasksById.get(planned.prepared.task.id)?.title).toBe('Contract native capture');
            },
            commitPreparedTaskEdit: async (control) => {
                const host = await nativeHost(control);
                const model = nativeValue(host.getTaskEditorModel({ id: taskId }));
                const request = { id: taskId, base: { title: model.draft.title, dueDate: model.draft.dueDate },
                    patch: { title: 'Contract prepared edit', dueDate: '2030-10-04' }, scheduleBase: model.scheduleBase };
                const prepared = nativeValue(host.prepareTaskDraftSave(request));
                control.expectPersisted((written) => {
                    const row = written.tasks.find((entry) => entry.id === taskId);
                    expect(row).toMatchObject({ title: request.patch.title, dueDate: request.patch.dueDate });
                    expect(row?.rev).toBeGreaterThan(prepared.before.rev ?? 0);
                });
                expect(nativeValue(await host.commitPreparedTaskDraftSave({ request: prepared.request, prepared })).id).toBe(taskId);
                expect(useTaskStore.getState()._tasksById.get(taskId)?.title).toBe('Contract prepared edit');
                expect(useTaskStore.getState()._tasksById.get(taskId)?.dueDate).toBe(request.patch.dueDate);
            },
            commitPreparedTaskDraftV2: async (control) => {
                const host = await nativeHost(control);
                const model = nativeValue(host.getTaskEditorModel({ id: taskId }));
                const request = { id: taskId,
                    base: { title: model.draft.title, location: model.draft.location, assignedTo: model.draft.assignedTo },
                    patch: { title: 'Contract durable draft', location: 'Contract desk', assignedTo: 'Contract person' },
                    scheduleBase: model.scheduleBase };
                const planned = nativeValue(await host.prepareTaskDraftSaveV2(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.tasks.find((entry) => entry.id === taskId)).toEqual(planned.prepared.effect.task.after);
                });
                expect(nativeValue(await host.commitPreparedTaskDraftSave({ request, prepared: planned.prepared })))
                    .toEqual({ id: taskId, draft: createTaskDraft(planned.prepared.effect.task.after) });
                expect(useTaskStore.getState()._tasksById.get(taskId)?.title).toBe('Contract durable draft');
                expect(useTaskStore.getState()._tasksById.get(taskId)?.location).toBe('Contract desk');
                expect(useTaskStore.getState()._tasksById.get(taskId)?.assignedTo).toBe('Contract person');
            },
            commitPreparedTaskFocus: async (control) => {
                const host = await nativeHost(control);
                const options = liveTasks.map((entry) => host.getTaskFocusOptions({ taskId: entry.id }))
                    .find((entry) => entry.ok && entry.value.canChange && entry.value.action.canToggle);
                expect(options?.ok).toBe(true);
                if (!options?.ok) return;
                const { id, ...expected } = options.value.task;
                const request = { requestId: 'e82c7810-84f4-4555-bbd2-4871927cac4f', taskId: id,
                    focused: !expected.isFocusedToday, expected };
                const planned = nativeValue(host.prepareTaskFocus(request));
                expect(planned.kind).toBe('prepared');
                if (planned.kind !== 'prepared') return;
                control.expectPersisted((written) => {
                    expect(written.tasks.find((entry) => entry.id === id))
                        .toEqual(planned.prepared.effect.task.after);
                });
                expect(nativeValue(await host.commitPreparedTaskFocus({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
            },
            commitPreparedTaskPromotion: async (control) => {
                const host = await nativeHost(control);
                const source = useTaskStore.getState()._tasksById.get(taskId);
                if (!source) throw new Error('fixture needs a saved promotion source Task');
                const request = { requestId: '2ed8eb7f-7541-445c-aada-c071a1dbf139', taskId,
                    taskRevision: taskRevisionOf(source), title: 'Contract promoted project' };
                const planned = nativeValue(host.prepareTaskPromotion(request));
                expect(planned.kind).toBe('prepared');
                expect(planned.prepared.result).toEqual({ id: request.requestId, reused: false });
                expect(planned.prepared.projects).toHaveLength(1);
                control.expectPersisted((written) => {
                    expect(written.tasks.find((entry) => entry.id === taskId))
                        .toEqual(planned.prepared.tasks[0].after);
                    expect(written.tasks).toHaveLength(settled.tasks.length);
                    expect(written.projects.filter((entry) => entry.id === request.requestId))
                        .toEqual([planned.prepared.projects[0].after]);
                });
                expect(nativeValue(await host.commitPreparedTaskPromotion({ request, prepared: planned.prepared })))
                    .toEqual(planned.prepared.result);
                expect(useTaskStore.getState()._tasksById.get(taskId))
                    .toEqual(planned.prepared.tasks[0].after);
                expect(useTaskStore.getState()._projectsById.get(request.requestId))
                    .toEqual(planned.prepared.projects[0].after);
            },
            convertTaskToSection: () => call('convertTaskToSection', projectTaskIds[0]),
            deleteArea: () => call('deleteArea', areaId),
            deleteContext: () => call('deleteContext', '@home'),
            deletePerson: () => call('deletePerson', personId),
            deleteProject: () => call('deleteProject', projectId),
            deleteSection: () => call('deleteSection', sectionId),
            deleteTag: () => call('deleteTag', '#admin'),
            deleteTask: () => call('deleteTask', taskId),
            duplicateProject: () => call('duplicateProject', projectId),
            duplicateTask: () => call('duplicateTask', taskId),
            moveTask: () => call('moveTask', taskId, 'waiting'),
            promoteTaskToProject: () => call('promoteTaskToProject', taskId),
            undoChecklistToProject: async (control) => {
                const command = await checklistConversion();
                expect(await call('convertChecklistToProject', command)).toMatchObject({ success: true });
                control.resetBaseline();
                expect(await call('undoChecklistToProject', command)).toMatchObject({ success: true });
                control.expectPersisted((written) => {
                    const source = written.tasks.find((entry) => entry.id === command.source.id);
                    expect(source?.deletedAt).toBeUndefined();
                    expect(source?.checklist).toEqual(command.source.checklist);
                    expect(written.projects.find((entry) => entry.id === command.project.id)?.deletedAt).toBeTruthy();
                    for (const task of command.tasks) expect(written.tasks.find((entry) => entry.id === task.id)?.deletedAt).toBeTruthy();
                });
            },
            undoProjectToSection: async () => call('undoProjectToSection', await convertedProjectReceipt()),
            purgeDeletedProjects: async () => {
                await call('deleteProject', projectId);
                await call('purgeDeletedProjects');
            },
            purgeDeletedTasks: () => call('purgeDeletedTasks'),
            purgeProject: async () => {
                await call('deleteProject', projectId);
                await call('purgeProject', projectId);
            },
            purgeTask: () => call('purgeTask', deletedTaskId),
            purgeTasks: () => call('purgeTasks', [deletedTaskId]),
            renameContext: () => call('renameContext', '@home', '@garage'),
            renamePerson: () => call('renamePerson', personId, 'Contract renamed', { updateTasks: true }),
            renameTag: () => call('renameTag', '#admin', '#contract'),
            reorderAreas: () => call('reorderAreas', settled.areas.map((entry) => entry.id).reverse()),
            reorderBoardTasks: () => call('reorderBoardTasks', 'next', [...nextTaskIds].reverse()),
            reorderFocusedTasks: () => call('reorderFocusedTasks', [...focusIds].reverse()),
            reorderProjectTasks: () => call('reorderProjectTasks', projectId, [...projectTaskIds].reverse()),
            reorderProjects: () => call('reorderProjects', settled.projects
                .filter((entry) => entry.areaId === areaId)
                .map((entry) => entry.id)
                .reverse(), areaId),
            reorderSections: () => call('reorderSections', projectId, settled.sections
                .filter((entry) => entry.projectId === projectId)
                .map((entry) => entry.id)
                .reverse()),
            resetTaskChecklist: () => call('resetTaskChecklist', checklistTaskId),
            restoreArea: async () => {
                await call('deleteArea', areaId);
                await call('restoreArea', areaId);
            },
            restorePerson: async () => {
                await call('deletePerson', personId);
                await call('restorePerson', personId);
            },
            restoreProject: async () => {
                await call('deleteProject', projectId);
                await call('restoreProject', projectId);
            },
            restoreTask: () => call('restoreTask', deletedTaskId),
            restoreTasks: () => call('restoreTasks', [deletedTaskId]),
            runArchiveRetention: async (control) => {
                const first = Date.now();
                vi.useFakeTimers({ toFake: ['Date'] });
                try {
                    vi.setSystemTime(new Date(first));
                    expect(await call('setArchiveRetentionDays', 1)).toMatchObject({ success: true });
                    await flushPendingSave();
                    control.resetBaseline();
                    vi.setSystemTime(new Date(first + 2 * 24 * 60 * 60 * 1000));
                    expect(await call('runArchiveRetention')).toMatchObject({ success: true });
                    control.expectPersisted((written) => {
                        expect(written.tasks.some((entry) => entry.purgedAt)).toBe(true);
                    });
                } finally {
                    vi.useRealTimers();
                }
            },
            seedGettingStarted: () => call('seedGettingStarted', { language: 'en' }),
            setArchiveRetentionDays: async (control) => {
                expect(await call('setArchiveRetentionDays', 30)).toMatchObject({ success: true });
                control.expectPersisted((written) => {
                    expect(written.settings.gtd?.archiveRetentionDays).toBe(30);
                });
            },
            skipRecurringTaskOccurrence: async () => {
                await call('updateTask', taskId, { recurrence: { rule: 'daily', strategy: 'strict', rrule: 'FREQ=DAILY' }, dueDate: '2026-09-01' });
                expect(await call('skipRecurringTaskOccurrence', taskId)).toMatchObject({ success: true });
            },
            toggleProjectFocus: () => call('toggleProjectFocus', otherProjectId),
            updateArea: () => call('updateArea', areaId, { name: 'Contract area name' }),
            updatePerson: () => call('updatePerson', personId, { name: 'Contract person name' }),
            updateProject: () => call('updateProject', projectId, { title: 'Contract project name' }),
            updateSection: () => call('updateSection', sectionId, { title: 'Contract section name' }),
            updateSettings: () => call('updateSettings', { theme: 'light' }),
            updateTask: () => call('updateTask', taskId, { title: 'Contract task name' }),
        };

        // The action list is the store's, not this file's: a new write action
        // fails here until it is either covered above or declared non-writing.
        const storeActionNames = Object.entries(useTaskStore.getState() as Record<string, unknown>)
            .filter(([, value]) => typeof value === 'function')
            .map(([name]) => name)
            .sort();
        const accountedFor = [...Object.keys(WRITE_ACTIONS), ...NON_WRITING_ACTIONS].sort();
        expect(storeActionNames, 'every store action must be covered or declared non-writing').toEqual(accountedFor);

        const notCanonical: Array<{ action: string; storeFields: string[]; readFields: string[] }> = [];
        for (const action of Object.keys(WRITE_ACTIONS).sort()) {
            const outcome = await runMutation(action, WRITE_ACTIONS[action], settled,
                action === 'commitPreparedReferenceTasksMove' || action === 'commitPreparedReferenceTasksAddTag' || action === 'commitPreparedReferenceTasksRemoveTag');
            if (outcome.storeFields.length > 0 || outcome.readFields.length > 0) {
                notCanonical.push({ action, ...outcome });
            }
        }
        const archivedBulkUndo = await runMutation('native prepared Archive bulk Delete Undo', async (control) => {
            const host = await nativeHost(control);
            const taskIds = ['task-29', 'task-58'];
            const request = { requestId: 'ee03cb67-dd20-4a88-a302-47bd9910b903', taskIds,
                taskRevisions: Object.fromEntries(taskIds.map((id) => {
                    const source = useTaskStore.getState()._tasksById.get(id);
                    if (!source || source.status !== 'archived') throw new Error(`Bulk Undo fixture missing: ${id}`);
                    return [id, taskRevisionOf(source)];
                })) };
            const deletion = { request, prepared: nativeValue(await host.prepareArchivedTasksDelete(request)).prepared };
            expect(nativeValue(await host.commitPreparedArchivedTasksDelete(deletion))).toEqual(deletion.prepared.result);
            await flushPendingSave();
            const undoRequest = { requestId: 'ff03cb67-dd20-4a88-a302-47bd9910b904', deleteRequestId: request.requestId };
            const undo = { request: undoRequest,
                prepared: nativeValue(await host.prepareArchivedTasksDeleteUndo({ request: undoRequest, delete: deletion })).prepared };
            const durable = nativeValue(await readAreaDurableData(false, true));
            const before = durable.authority.snapshot;
            const after = new Map(undo.prepared.after.map((row) => [row.id, row]));
            for (const row of undo.prepared.after) {
                expect(row.status).toBe('archived'); expect(row.deletedAt).toBeUndefined();
                expect(row.rev).toBe((undo.prepared.before.find((old) => old.id === row.id)?.rev ?? 0) + 1);
            }
            control.resetBaseline();
            control.expectPersisted((written) => {
                expect(written.tasks).toEqual(before.tasks.map((row) => after.get(row.id) ?? row));
                expect(written.projects).toEqual(before.projects);
                expect(written.sections).toEqual(before.sections);
                expect(written.settings).toEqual(before.settings);
            });
            expect(nativeValue(await host.commitPreparedArchivedTasksDeleteUndo(undo))).toEqual({ count: 2 });
        });
        if (archivedBulkUndo.storeFields.length > 0 || archivedBulkUndo.readFields.length > 0) {
            notCanonical.push({ action: 'native prepared Archive bulk Delete Undo', ...archivedBulkUndo });
        }
        const referenceNext = await runMutation('native prepared Reference leading Next', async (control) => {
            await call('updateTask', 'task-66', { status: 'reference', isFocusedToday: false });
            const host = await nativeHost(control);
            const source = useTaskStore.getState()._tasksById.get('task-66');
            if (!source || source.status !== 'reference') throw new Error('Reference Next fixture must be a live Reference row');
            const request = { requestId: '2f0e9b35-afcd-4710-8847-9c4219ad0187', source: 'reference' as const,
                status: 'next' as const, id: source.id, taskRevision: taskRevisionOf(source) };
            const planned = nativeValue(await host.prepareDoneTaskStatus(request));
            expect(planned.kind).toBe('prepared');
            if (planned.kind !== 'prepared') throw new Error('Reference Next must prepare a real write');
            expect(planned.prepared.kind).toBe('referenceNext');
            expect(nativeValue(host.validatePreparedDoneTaskStatus({ request, prepared: planned.prepared }))).toEqual({ id: source.id });
            const after = planned.prepared.checklist.effect.tasks[0].after;
            expect(after).toMatchObject({ id: source.id, status: 'next', rev: (source.rev ?? 0) + 1 });
            const before = nativeValue(await readAreaDurableData(false, true)).authority.snapshot;
            control.expectPersisted((written) => {
                expect(written.tasks).toEqual(before.tasks.map((row) => row.id === source.id ? after : row));
                expect(written.projects).toEqual(before.projects);
                expect(written.sections).toEqual(before.sections);
                expect(written.areas).toEqual(before.areas);
                expect(written.people).toEqual(before.people);
                expect(written.settings).toEqual(before.settings);
            });
            control.resetBaseline();
            expect(nativeValue(await host.commitPreparedDoneTaskStatus({ request, prepared: planned.prepared }))).toEqual({ id: source.id });
            expect(useTaskStore.getState()._tasksById.get(source.id)).toEqual(after);
        });
        if (referenceNext.storeFields.length > 0 || referenceNext.readFields.length > 0) {
            notCanonical.push({ action: 'native prepared Reference leading Next', ...referenceNext });
        }
        for (const operation of ['status', 'completion', 'undo'] as const) {
            const name = `native prepared Reference menu ${operation}`;
            // Reference status edits clear scheduling/recurrence. Normal load
            // still accepts a saved legacy Reference row that carries them.
            const fixture = convergeThroughStorage({ ...settled, tasks: settled.tasks.map((row) => row.id === 'task-66'
                ? { ...row, status: 'reference', isFocusedToday: false, projectId: undefined, sectionId: undefined,
                    ...(operation === 'status' ? {} : { recurrence: { rule: 'daily', strategy: 'strict', seriesId: row.id },
                        dueDate: '2026-09-01', showFutureRecurrence: true }) } : row) });
            const referenceMenu = await runMutation(name, async (control) => {
                const host = await nativeHost(control);
                const source = useTaskStore.getState()._tasksById.get('task-66');
                if (!source || source.status !== 'reference') throw new Error('Reference menu fixture must be writable');
                const request = { requestId: '2f0e9b35-afcd-4710-8847-9c4219ad0188', source: 'reference' as const,
                    id: source.id, taskRevision: taskRevisionOf(source) };
                const completion = operation !== 'status' ? { request,
                    prepared: nativeValue(await host.prepareTaskCompletion(request)).prepared } : null;
                const statusRequest = { ...request, status: 'waiting' as const };
                const status = operation === 'status' ? nativeValue(await host.prepareDoneTaskStatus(statusRequest)) : null;
                if (status && status.kind !== 'prepared') throw new Error('Reference menu move must prepare');
                if (operation === 'undo') {
                    nativeValue(await host.commitPreparedTaskCompletion(completion!)); await flushPendingSave();
                }
                const undoRequest = { requestId: '2f0e9b35-afcd-4710-8847-9c4219ad0189', completionRequestId: request.requestId };
                const undo = operation === 'undo' ? nativeValue(await host.prepareTaskCompletionUndo({ request: undoRequest, completion: completion! })).prepared : null;
                const effect = undo ? undo.effect : completion ? completion.prepared.checklist.effect : status!.prepared.checklist.effect;
                expect(effect.tasks.length).toBe(operation === 'status' ? 1 : 2);
                expect(effect.projects).toEqual([]); expect(effect.sections).toEqual([]);
                const before = nativeValue(await readAreaDurableData(false, true)).authority.snapshot;
                const affected = new Map(effect.tasks.map((row) => [row.after.id, row.after]));
                control.resetBaseline();
                control.expectPersisted((written) => {
                    expect(written.tasks).toEqual([...before.tasks.map((row) => affected.get(row.id) ?? row),
                        ...effect.tasks.filter((row) => row.before === null).map((row) => row.after)]);
                    expect(written.projects).toEqual(before.projects); expect(written.sections).toEqual(before.sections);
                    expect(written.areas).toEqual(before.areas); expect(written.people).toEqual(before.people);
                    expect(written.settings).toEqual(before.settings);
                });
                if (undo) expect(nativeValue(await host.commitPreparedTaskCompletionUndo({ request: undoRequest, prepared: undo }))).toEqual(undo.result);
                else if (completion) expect(nativeValue(await host.commitPreparedTaskCompletion(completion))).toEqual(completion.prepared.result);
                else expect(nativeValue(await host.commitPreparedDoneTaskStatus({ request: statusRequest, prepared: status!.prepared }))).toEqual({ id: source.id });
                expect(useTaskStore.getState()._tasksById.get(source.id)).toEqual(affected.get(source.id));
            }, fixture);
            if (referenceMenu.storeFields.length > 0 || referenceMenu.readFields.length > 0) notCanonical.push({ action: name, ...referenceMenu });
        }
        for (const action of ['choose', 'add', 'completeProject'] as const) {
            const name = `native prepared Reference project next action ${action}`;
            const parentId = 'prompt191-parent'; const sourceId = 'prompt191-source'; const candidateId = 'prompt191-candidate';
            const fixture = convergeThroughStorage({ ...settled,
                projects: [...settled.projects, project(parentId)],
                tasks: [...settled.tasks, task(sourceId, { status: 'reference', projectId: parentId, sectionId: undefined,
                    isFocusedToday: false, recurrence: undefined, startTime: undefined, dueDate: undefined }),
                    task(candidateId, { status: 'waiting', projectId: parentId, sectionId: undefined,
                        isFocusedToday: false, recurrence: undefined, startTime: undefined, dueDate: undefined })] });
            const result = await runMutation(name, async control => {
                const host = await nativeHost(control); const source = useTaskStore.getState()._tasksById.get(sourceId)!;
                const completionRequest = { id: sourceId, source: 'reference' as const,
                    requestId: '2f0e9b35-afcd-4710-8847-9c4219ad0193', taskRevision: taskRevisionOf(source) };
                const completion = { request: completionRequest, prepared: nativeValue(await host.prepareTaskCompletion(completionRequest)).prepared };
                nativeValue(await host.commitPreparedTaskCompletion(completion)); await flushPendingSave();
                const origin = { kind: 'completion' as const, envelope: completion };
                const options = nativeValue(await host.getReferenceProjectNextActionOptions({ origin, params: { offset: 0, revision: null } }));
                if (!options) throw new Error('Project next action fixture must have a real prompt');
                const base = { requestId: '2f0e9b35-afcd-4710-8847-9c4219ad0194', origin: options.origin, promptRevision: options.promptRevision };
                const request = action === 'choose' ? { ...base, action, candidateId,
                    candidateRevision: taskRevisionOf(useTaskStore.getState()._tasksById.get(candidateId)!) }
                    : action === 'add' ? { ...base, action, text: 'Canonical next action', openAfterSave: true }
                        : { ...base, action };
                const prepared = nativeValue(await host.prepareReferenceProjectNextAction({ request, origin })).prepared;
                const envelope = { request, prepared }; expect(nativeValue(host.validatePreparedReferenceProjectNextAction(envelope))).toEqual(prepared.result);
                const before = nativeValue(await readAreaDurableData(false, true)).authority.snapshot;
                const op = prepared.operation;
                const taskEffects = op.kind === 'choose' ? op.effect.tasks : op.kind === 'add' ? [{ before: null, after: op.task }] : op.lifecycle.effect.tasks;
                const projectEffects = op.kind === 'completeProject' ? [op.lifecycle.effect.project] : [];
                const sectionEffects = op.kind === 'completeProject' ? op.lifecycle.effect.sections : [];
                control.resetBaseline(); control.expectPersisted(written => {
                    const tasks = new Map(taskEffects.map(row => [row.after.id, row.after]));
                    expect(written.tasks).toEqual([...before.tasks.map(row => tasks.get(row.id) ?? row), ...taskEffects.filter(row => row.before === null).map(row => row.after)]);
                    expect(written.projects).toEqual(before.projects.map(row => projectEffects.find(effect => effect.after.id === row.id)?.after ?? row));
                    expect(written.sections).toEqual(before.sections?.map(row => sectionEffects.find(effect => effect.after.id === row.id)?.after ?? row));
                    expect(written.areas).toEqual(before.areas); expect(written.people).toEqual(before.people); expect(written.settings).toEqual(before.settings);
                });
                expect(nativeValue(await host.commitPreparedReferenceProjectNextAction(envelope))).toEqual(prepared.result);
                if (op.kind === 'choose') expect(useTaskStore.getState()._tasksById.get(candidateId)?.rev).toBe(op.effect.tasks[0].after.rev);
                if (op.kind === 'add') expect(useTaskStore.getState()._tasksById.get(op.task.id)).toEqual(op.task);
                if (op.kind === 'completeProject') expect(useTaskStore.getState()._projectsById.get(parentId)?.status).toBe('archived');
            }, fixture, true);
            if (result.storeFields.length || result.readFields.length) notCanonical.push({ action: name, ...result });
        }
        const referenceDestinationFixture = convergeThroughStorage({ ...settled, tasks: settled.tasks.map(row => row.id === 'task-66'
            ? { ...row, status: 'reference', isFocusedToday: false, projectId: undefined, sectionId: undefined } : row) });
        const referenceDestination = await runMutation('native prepared Reference destination', async control => {
            const host = await nativeHost(control); const source = useTaskStore.getState()._tasksById.get('task-66');
            const target = useTaskStore.getState().projects.find(row => !row.deletedAt && row.status !== 'archived');
            if (!source || source.status !== 'reference' || !target) throw new Error('Reference destination fixture must be writable');
            const request = { requestId: '2f0e9b35-afcd-4710-8847-9c4219ad0191', source: 'reference' as const,
                id: source.id, taskRevision: taskRevisionOf(source), destination: { kind: 'project' as const, id: target.id } };
            const planned = nativeValue(await host.prepareReferenceTaskDestination(request));
            const envelope = { request, prepared: planned.prepared }; const effect = planned.prepared.checklist.effect;
            expect(nativeValue(host.validatePreparedReferenceTaskDestination(envelope))).toEqual({ id: source.id });
            expect(effect.tasks).toHaveLength(1); expect(effect.projects).toEqual([]); expect(effect.sections).toEqual([]);
            expect(effect.tasks[0].after).toMatchObject({ status: 'reference', projectId: target.id, rev: (source.rev ?? 0) + 1 });
            expect(effect.tasks[0].after.order).toBe(source.order); expect(effect.tasks[0].after.orderNum).toBe(source.orderNum);
            const before = nativeValue(await readAreaDurableData(false, true)).authority.snapshot;
            control.resetBaseline(); control.expectPersisted(written => {
                expect(written.tasks).toEqual(before.tasks.map(row => row.id === source.id ? effect.tasks[0].after : row));
                expect(written.projects).toEqual(before.projects); expect(written.sections).toEqual(before.sections);
                expect(written.areas).toEqual(before.areas); expect(written.people).toEqual(before.people); expect(written.settings).toEqual(before.settings);
            });
            expect(nativeValue(await host.commitPreparedReferenceTaskDestination(envelope))).toEqual({ id: source.id });
            expect(useTaskStore.getState()._tasksById.get(source.id)).toEqual(effect.tasks[0].after);
        }, referenceDestinationFixture);
        if (referenceDestination.storeFields.length > 0 || referenceDestination.readFields.length > 0)
            notCanonical.push({ action: 'native prepared Reference destination', ...referenceDestination });
        const referenceBackdateFixture = convergeThroughStorage({ ...settled, tasks: settled.tasks.map((row) => row.id === 'task-66'
            ? { ...row, status: 'reference', isFocusedToday: false, projectId: undefined, sectionId: undefined,
                recurrence: { rule: 'daily', strategy: 'after-completion', seriesId: row.id }, dueDate: '2026-09-01', showFutureRecurrence: true } : row) });
        const referenceBackdate = await runMutation('native prepared Reference backdated completion', async (control) => {
            const host = await nativeHost(control); const source = useTaskStore.getState()._tasksById.get('task-66');
            if (!source || source.status !== 'reference') throw new Error('Reference backdate fixture must be writable');
            const request = { requestId: '2f0e9b35-afcd-4710-8847-9c4219ad0190', source: 'reference' as const,
                id: source.id, taskRevision: taskRevisionOf(source), completedAt: '2026-10-01T09:12:34.789Z', timeSpentText: null };
            const planned = nativeValue(await host.prepareReferenceTaskBackdate(request));
            const envelope = { request, prepared: planned.prepared }; const effect = planned.prepared.checklist.effect;
            expect(nativeValue(host.validatePreparedReferenceTaskBackdate(envelope))).toEqual({ id: source.id });
            expect(effect.tasks).toHaveLength(2); expect(effect.projects).toEqual([]); expect(effect.sections).toEqual([]);
            const affected = new Map(effect.tasks.map(row => [row.after.id, row.after]));
            expect(affected.get(source.id)).toMatchObject({ status: 'done', completedAt: request.completedAt, rev: (source.rev ?? 0) + 1 });
            const before = nativeValue(await readAreaDurableData(false, true)).authority.snapshot;
            control.resetBaseline(); control.expectPersisted(written => {
                expect(written.tasks).toEqual([...before.tasks.map(row => affected.get(row.id) ?? row),
                    ...effect.tasks.filter(row => row.before === null).map(row => row.after)]);
                expect(written.projects).toEqual(before.projects); expect(written.sections).toEqual(before.sections);
                expect(written.areas).toEqual(before.areas); expect(written.people).toEqual(before.people); expect(written.settings).toEqual(before.settings);
            });
            expect(nativeValue(await host.commitPreparedReferenceTaskBackdate(envelope))).toEqual({ id: source.id });
            expect(useTaskStore.getState()._tasksById.get(source.id)).toEqual(affected.get(source.id));
        }, referenceBackdateFixture);
        if (referenceBackdate.storeFields.length > 0 || referenceBackdate.readFields.length > 0)
            notCanonical.push({ action: 'native prepared Reference backdated completion', ...referenceBackdate });
        const doneBulkMove = await runMutation('native prepared Done bulk Move status', async (control) => {
            // Normal load archives the fixture's historical completions. Make
            // two real recent Done rows through RN before resetting baseline.
            await call('batchMoveTasks', ['task-66', 'task-132'], 'done');
            const host = await nativeHost(control);
            const sources = useTaskStore.getState()._allTasks.filter((row) => row.status === 'done' && !row.deletedAt && !row.projectId).slice(0, 2);
            expect(sources).toHaveLength(2);
            const taskIds = sources.map((row) => row.id);
            const request = { requestId: '2f0e9b35-afcd-4710-8847-9c4219ad0183', source: 'done' as const, status: 'next' as const,
                taskIds, taskRevisions: Object.fromEntries(sources.map((row) => [row.id, taskRevisionOf(row)])) };
            const planned = nativeValue(await host.prepareArchivedTasksRestore(request));
            const envelope = { request, prepared: planned.prepared };
            expect(nativeValue(host.validatePreparedArchivedTasksRestore(envelope))).toEqual({ count: 2, status: 'next' });
            const changed = new Map(planned.prepared.effect.tasks.map((pair) => [pair.after.id, pair.after]));
            expect([...changed.keys()].sort()).toEqual([...taskIds].sort());
            for (const source of sources) expect(changed.get(source.id)).toMatchObject({ status: 'next', rev: (source.rev ?? 0) + 1 });
            const durable = nativeValue(await readAreaDurableData(false, true));
            const before = durable.authority.snapshot;
            control.expectPersisted((written) => {
                expect(written.tasks).toEqual(before.tasks.map((row) => changed.get(row.id) ?? row));
                expect(written.projects).toEqual(before.projects);
                expect(written.sections).toEqual(before.sections);
                expect(written.settings).toEqual(before.settings);
            });
            control.resetBaseline();
            expect(await useTaskStore.getState().commitPreparedArchivedTasksRestore(planned.prepared, durable.authority))
                .toEqual({ success: true, ids: taskIds, outcome: 'applied' });
        });
        if (doneBulkMove.storeFields.length > 0 || doneBulkMove.readFields.length > 0) {
            notCanonical.push({ action: 'native prepared Done bulk Move status', ...doneBulkMove });
        }
        const doneBulkTag = await runMutation('native prepared Done bulk Add tag', async (control) => {
            await call('batchMoveTasks', ['task-66', 'task-132'], 'done');
            await call('batchUpdateTasks', [{ id: 'task-66', updates: { tags: ['#task184'] } }]);
            const host = await nativeHost(control);
            const sources = ['task-66', 'task-132'].map((id) => useTaskStore.getState()._tasksById.get(id)!);
            expect(sources.every((row) => row.status === 'done' && !row.deletedAt)).toBe(true);
            const taskIds = sources.map((row) => row.id);
            const request = { requestId: '2f0e9b35-afcd-4710-8847-9c4219ad0184', source: 'done' as const, action: 'addTag' as const,
                tag: '#task184', taskIds, taskRevisions: Object.fromEntries(sources.map((row) => [row.id, taskRevisionOf(row)])) };
            const planned = nativeValue(await host.prepareArchivedTasksRestore(request));
            expect(planned.kind).toBe('prepared');
            if (planned.kind !== 'prepared') throw new Error('The mixed changed Add tag case must write');
            expect(nativeValue(host.validatePreparedArchivedTasksRestore({ request, prepared: planned.prepared }))).toEqual({ count: 1, changed: true });
            const changed = new Map(planned.prepared.effect.tasks.map((pair) => [pair.after.id, pair.after]));
            expect([...changed.keys()]).toEqual(['task-132']);
            expect(changed.get('task-132')).toMatchObject({ status: 'done', tags: expect.arrayContaining(['#task184']), rev: (sources[1].rev ?? 0) + 1 });
            const durable = nativeValue(await readAreaDurableData(false, true)); const before = durable.authority.snapshot;
            control.expectPersisted((written) => {
                expect(written.tasks).toEqual(before.tasks.map((row) => changed.get(row.id) ?? row));
                expect(written.tasks.find((row) => row.id === 'task-66')?.rev).toBe(sources[0].rev);
                expect(written.projects).toEqual(before.projects); expect(written.sections).toEqual(before.sections); expect(written.settings).toEqual(before.settings);
            });
            control.resetBaseline();
            expect(await useTaskStore.getState().commitPreparedArchivedTasksRestore(planned.prepared, durable.authority))
                .toEqual({ success: true, ids: taskIds, outcome: 'applied' });
        });
        if (doneBulkTag.storeFields.length > 0 || doneBulkTag.readFields.length > 0) {
            notCanonical.push({ action: 'native prepared Done bulk Add tag', ...doneBulkTag });
        }
        const doneBulkRemoveTag = await runMutation('native prepared Done bulk Remove tag', async (control) => {
            await call('batchMoveTasks', ['task-66', 'task-132'], 'done');
            await call('batchUpdateTasks', [{ id: 'task-66', updates: { tags: ['#task185', '#keep'] } }]);
            const host = await nativeHost(control);
            const sources = ['task-66', 'task-132'].map((id) => useTaskStore.getState()._tasksById.get(id)!);
            expect(sources.every((row) => row.status === 'done' && !row.deletedAt)).toBe(true);
            const taskIds = sources.map((row) => row.id);
            const request = { requestId: '2f0e9b35-afcd-4710-8847-9c4219ad0185', source: 'done' as const, action: 'removeTag' as const,
                tags: ['#task185'], taskIds, taskRevisions: Object.fromEntries(sources.map((row) => [row.id, taskRevisionOf(row)])) };
            const planned = nativeValue(await host.prepareArchivedTasksRestore(request));
            expect(planned.kind).toBe('prepared');
            if (planned.kind !== 'prepared') throw new Error('The mixed carrier Remove tag case must write');
            expect(nativeValue(host.validatePreparedArchivedTasksRestore({ request, prepared: planned.prepared }))).toEqual({ count: 1, changed: true });
            const changed = new Map(planned.prepared.effect.tasks.map((pair) => [pair.after.id, pair.after]));
            expect([...changed.keys()]).toEqual(['task-66']);
            expect(changed.get('task-66')).toMatchObject({ status: 'done', tags: ['#keep'], rev: (sources[0].rev ?? 0) + 1 });
            const durable = nativeValue(await readAreaDurableData(false, true)); const before = durable.authority.snapshot;
            control.expectPersisted((written) => {
                expect(written.tasks).toEqual(before.tasks.map((row) => changed.get(row.id) ?? row));
                expect(written.tasks.find((row) => row.id === 'task-132')?.rev).toBe(sources[1].rev);
                expect(written.projects).toEqual(before.projects); expect(written.sections).toEqual(before.sections); expect(written.settings).toEqual(before.settings);
            });
            control.resetBaseline();
            expect(await useTaskStore.getState().commitPreparedArchivedTasksRestore(planned.prepared, durable.authority))
                .toEqual({ success: true, ids: taskIds, outcome: 'applied' });
        });
        if (doneBulkRemoveTag.storeFields.length > 0 || doneBulkRemoveTag.readFields.length > 0) {
            notCanonical.push({ action: 'native prepared Done bulk Remove tag', ...doneBulkRemoveTag });
        }
        const preparedTheme = await runMutation('native prepared General Theme', async (control) => {
            const host = await nativeHost(control);
            const options = nativeValue(await host.getGeneralPreferenceOptions({}));
            const request = { requestId: 'ddcf0526-c537-4ec9-82d9-46acf9e73001',
                edit: { type: 'theme' as const, value: 'material3-dark' as const },
                expected: options.expected.theme };
            const planned = nativeValue(await host.prepareGeneralPreference(request));
            expect(planned.kind).toBe('prepared');
            if (planned.kind !== 'prepared') return;
            control.expectPersisted((written) => {
                expect(written.settings.theme).toBe('material3-dark');
                expect(written.settings.syncPreferencesUpdatedAt?.appearance).toBe(planned.prepared.after.stamp);
                expect(written.tasks).toHaveLength(settled.tasks.length);
            });
            expect(nativeValue(await host.commitPreparedGeneralPreference({ request, prepared: planned.prepared })))
                .toEqual(planned.prepared.result);
        });
        if (preparedTheme.storeFields.length > 0 || preparedTheme.readFields.length > 0) {
            notCanonical.push({ action: 'native prepared General Theme', ...preparedTheme });
        }
        const preparedLanguage = await runMutation('native prepared General Language', async (control) => {
            const host = await nativeHost(control);
            const options = nativeValue(await host.getGeneralPreferenceOptions({}));
            const request = { requestId: '8534a711-ce76-4f07-8934-6a359bc9ca07',
                edit: { type: 'language' as const, value: 'fa' as const },
                expected: options.expected.language };
            const planned = nativeValue(await host.prepareGeneralPreference(request));
            expect(planned.kind).toBe('prepared');
            if (planned.kind !== 'prepared') return;
            control.expectPersisted((written) => {
                expect(written.settings.language).toBe('fa');
                expect(written.settings.syncPreferencesUpdatedAt?.language).toBe(planned.prepared.after.stamp);
                expect(written.tasks).toHaveLength(settled.tasks.length);
            });
            expect(nativeValue(await host.commitPreparedGeneralPreference({ request, prepared: planned.prepared })))
                .toEqual(planned.prepared.result);
        });
        if (preparedLanguage.storeFields.length > 0 || preparedLanguage.readFields.length > 0) {
            notCanonical.push({ action: 'native prepared General Language', ...preparedLanguage });
        }
        const restoredArea = await runMutation('native prepared Area restore', async (control) => {
            const host = await nativeHost(control);
            await call('deleteArea', areaId);
            await flushPendingSave();
            control.resetBaseline();
            const request = { requestId: '1a7fe74c-2403-414a-8160-9dc33458b76f',
                name: settled.areas[0].name, color: '#ef4444', expectedAreaId: areaId };
            const planned = nativeValue(await host.prepareAreaCreate(request));
            expect(planned.kind).toBe('prepared');
            if (planned.kind !== 'prepared') return;
            expect(planned.prepared.kind).toBe('restored');
            control.expectPersisted((written) => {
                expect(written.areas).toHaveLength(settled.areas.length);
                expect(written.areas.find((entry) => entry.id === areaId))
                    .toEqual(planned.prepared.effect.area.after);
                expect(written.areas.find((entry) => entry.id === areaId)?.deletedAt).toBeUndefined();
            });
            expect(nativeValue(await host.commitPreparedAreaCreate({ request, prepared: planned.prepared })))
                .toEqual(planned.prepared.result);
            expect(useTaskStore.getState()._areasById.get(areaId))
                .toEqual(planned.prepared.effect.area.after);
        });
        if (restoredArea.storeFields.length > 0 || restoredArea.readFields.length > 0) {
            notCanonical.push({ action: 'native prepared Area restore', ...restoredArea });
        }
        // Mind Sweep intentionally reuses the existing prepared-capture store
        // writer, but its literal-title preparation is a distinct native route.
        const sweep = await runMutation('native Mind Sweep add', async (control) => {
            const host = await nativeHost(control);
            const planned = nativeValue(host.prepareMindSweepAdd({
                requestId: '4ed085ea-a209-426b-b35c-23a073214b11', title: '  Contract +literal /due:tomorrow  ',
            }));
            control.expectPersisted((written) => {
                expect(written.tasks.find((entry) => entry.id === planned.prepared.task.id)).toMatchObject({
                    id: planned.prepared.task.id, title: 'Contract +literal /due:tomorrow',
                    status: 'inbox', rev: planned.prepared.task.rev,
                });
                expect(written.projects).toHaveLength(settled.projects.length);
            });
            expect(nativeValue(await host.commitPreparedMindSweepAdd({ request: planned.prepared.request,
                prepared: planned.prepared }))).toEqual(planned.prepared.result);
            expect(useTaskStore.getState()._tasksById.get(planned.prepared.task.id)?.title)
                .toBe('Contract +literal /due:tomorrow');
        });
        if (sweep.storeFields.length > 0 || sweep.readFields.length > 0) {
            notCanonical.push({ action: 'native Mind Sweep add', ...sweep });
        }

        // THE CONTRACT. Every write action leaves a document the pass would not
        // change — as the store holds it (the reconcile path can upload that
        // side) and as the codecs read it back (the ordinary upload path).
        //
        // Every write action must leave the persisted document canonical. A new
        // exception here is a bug to fix in the write path, not an entry to add.
        expect(notCanonical).toEqual([]);
    }, 300_000);

    // -----------------------------------------------------------------------
    // Part 3: the steady state, the stats parity, and the cost
    // -----------------------------------------------------------------------

    it('reads back a document the pass would not change: settled -> local storage -> pass', () => {
        report('');
        report('### Steady state (what the sync cycle actually reads each cycle)');
        report('');
        report('| document | readLocal bytes == last uploaded bytes? | what the pass would still redo |');
        report('| --- | --- | --- |');

        for (const size of [400, LARGE_TASK_COUNT]) {
            // The document this device holds after its cycles have settled.
            const uploaded = convergeThroughStorage(buildLargeDocument(size));
            // What the next cycle reads back off disk.
            const readLocal = throughLocalStorage(uploaded);
            const passed = runNormalizePass(readLocal);

            const passIsNoOp = remoteBytes(readLocal) === remoteBytes(uploaded);
            report(
                `| ${size.toLocaleString('en-US')}-task settled store | ${passIsNoOp ? 'yes' : 'NO'} | ${summarizeDiff(diffDocuments(readLocal, passed, 50_000))} |`,
            );

            // THE CONTRACT, on the document a real cycle reads: the pass is not
            // merely stable, it is the identity. This is what lets the local-only
            // upload fast path skip it. Before the codec fix the storage layer
            // re-materialized showFutureRecurrence as `false` on every task and
            // the pass stripped it again, every cycle.
            expect(remoteBytes(passed)).toBe(remoteBytes(uploaded));
            expect(summarizeDiff(diffDocuments(readLocal, passed, 50_000))).toBe('none');
            expect(passIsNoOp).toBe(true);
        }
    }, 120_000);

    it('reports the same merge stats whether the empty-remote merge ran or was skipped', async () => {
        // The skip hands back hand-built stats (createLocalOnlyMergeStats in
        // sync.ts) instead of the merge's own. They have to agree, or a sync
        // history entry means something different depending on which path ran.
        const canonical = convergeThroughStorage(buildLargeDocument(150));
        const runCycle = async (skip: boolean) => {
            let written: AppData | null = null;
            const result = await performSyncCycle({
                readLocal: async () => structuredClone(canonical),
                readRemote: async () => null,
                writeLocal: async (data) => { written = data; },
                writeRemote: async () => {},
                skipEmptyRemoteMerge: skip ? () => true : undefined,
                now: () => NOW_ISO,
            });
            return { result, written: written as AppData | null };
        };

        const skipped = await runCycle(true);
        const merged = await runCycle(false);

        expect(skipped.result.status).toBe(merged.result.status);
        expect(skipped.result.data.settings.lastSyncStats)
            .toEqual(merged.result.data.settings.lastSyncStats);
        // And the document itself: same bytes on the wire either way.
        expect(remoteBytes(skipped.result.data)).toBe(remoteBytes(merged.result.data));
    }, 120_000);

    it.skipIf(!PERF)('records the cost of the pass on the 7,000-task fixture', () => {
        const raw = buildLargeDocument(7_000);
        const settled = convergeThroughStorage(raw);
        const readLocal = throughLocalStorage(settled);
        const emptyRemote = (parseSyncDocument({}, 'remote') as { data: AppData }).data;

        // Best of N, not a single run: the fastest run is the one least
        // disturbed by other load, which is how performance-large-store.test.ts
        // measures. The loadavg at measurement time is printed with the table.
        const best = (label: string, run: () => unknown, attempts = 7): number => {
            let bestMs = Number.POSITIVE_INFINITY;
            for (let attempt = 0; attempt < attempts; attempt += 1) {
                const startedAt = performance.now();
                run();
                bestMs = Math.min(bestMs, performance.now() - startedAt);
            }
            expect(bestMs, label).toBeGreaterThan(0);
            return bestMs;
        };

        const passMs = best('normalize pass', () => runNormalizePass(readLocal));
        const mergeMs = best('merge', () => mergeAppDataWithStats(readLocal, emptyRemote, { nowIso: NOW_ISO }));
        const serializeMs = best('serialize', () => remoteBytes(settled));
        const bytes = remoteBytes(settled).length;

        expect(remoteBytes(runNormalizePass(readLocal))).toBe(remoteBytes(settled));

        report('');
        report(`### Cost on the 7,000-task fixture (best of 7 runs, loadavg ${readLoadAverage()})`);
        report('');
        report('| step | ms |');
        report('| --- | --- |');
        report(`| whole normalize pass (parse + purge + merge + purge + validate) | ${passMs.toFixed(1)} |`);
        // This is the line the fast path removes; the serialize below it is paid
        // either way, by the upload itself.
        report(`| mergeAppDataWithStats alone (skipped by the local-only upload fast path) | ${mergeMs.toFixed(1)} |`);
        report(`| stable-serialize the remote document (${(bytes / 1024 / 1024).toFixed(2)} MiB) | ${serializeMs.toFixed(1)} |`);
    }, 300_000);

    it('prints the measurement report', () => {
        // eslint-disable-next-line no-console
        console.log(['', '=== CANONICAL LOCAL READS CONTRACT ===', ...REPORT, ''].join('\n'));
        expect(REPORT.length).toBeGreaterThan(0);
    });
});
