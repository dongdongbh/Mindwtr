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
import { afterEach, describe, expect, it } from 'vitest';
import { mergeAppData, mergeAppDataWithStats, performSyncCycle } from './sync';
import { parseSyncDocument, toRemoteSyncDocument } from './sync-document';
import { purgeExpiredTombstones } from './sync-tombstones';
import { validateMergedSyncData } from './sync-normalization';
import { toStableSyncJson } from './sync-helpers';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import { TASK_SQLITE_COLUMNS, TASK_SYNC_FIELD_SCHEMA, TASK_SYNC_SCHEMA_FIXTURE, taskToSqliteRow } from './task-sync-schema';
import { mapSqliteTaskRow } from './sqlite-adapter';
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
    name: `${id}.pdf`,
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

    const persistTaskPatchAndRead = async (updates: Partial<Task>): Promise<AppData> => {
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
            getData: async () => throughLocalStorage({ ...emptyData(), tasks: [task('field-task')] }),
            saveData: async (data) => { saved = structuredClone(data); },
        });
        await useTaskStore.getState().fetchData({ silent: true });
        await useTaskStore.getState().updateTask('field-task', updates);
        await flushPendingSave();
        if (!saved) throw new Error('The field update did not persist a snapshot');
        return throughLocalStorage(saved);
    };

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
    ]);

    it('leaves a canonical document after every store write action', async () => {
        report('');
        report('### Store write actions on a settled document');
        report('');
        report('| action | pass changes the STORE snapshot? | pass changes the document readLocal returns? | what changed (store) | what changed (readLocal) |');
        report("| --- | --- | --- | --- | --- |");

        const settled = convergeThroughStorage(buildLargeDocument(150));

        const runMutation = async (
            label: string,
            mutate: () => Promise<unknown>,
        ): Promise<{ storeFields: string[]; readFields: string[] }> => {
            let saved: AppData | null = null;
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
            setStorageAdapter({
                getData: async () => structuredClone(settled),
                saveData: async (data: AppData) => {
                    saved = structuredClone(data);
                },
            });
            await (useTaskStore.getState() as unknown as {
                fetchData: (options?: { silent?: boolean }) => Promise<void>;
            }).fetchData({ silent: true });
            await mutate();
            await flushPendingSave();
            if (!saved) throw new Error(`${label}: the store never persisted a snapshot`);
            const written = saved as AppData;
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
        };

        const store = () => useTaskStore.getState() as unknown as Record<string, (...args: never[]) => Promise<unknown>>;
        const call = (name: string, ...args: unknown[]) => store()[name](...(args as never[]));

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

        expect(
            [taskId, deletedTaskId, checklistTaskId, sectionId].every((value) => typeof value === 'string'),
            'fixture must supply a live task, a soft-deleted task, a task with a checklist and a section',
        ).toBe(true);

        /**
         * One invocation per write action, keyed by the action's own name. The
         * restore/purge entries soft-delete first so the action under test has
         * something to act on; the persisted snapshot still covers both writes.
         */
        const WRITE_ACTIONS: Record<string, () => Promise<unknown>> = {
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
            seedGettingStarted: () => call('seedGettingStarted', { language: 'en' }),
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
            const outcome = await runMutation(action, WRITE_ACTIONS[action]);
            if (outcome.storeFields.length > 0 || outcome.readFields.length > 0) {
                notCanonical.push({ action, ...outcome });
            }
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
