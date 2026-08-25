import { describe, expect, it } from 'vitest';
import {
    normalizeAreaForSyncMerge,
    normalizeAttachmentsForSyncMerge,
    normalizePersonForSyncMerge,
    normalizeProjectForSyncMerge,
    normalizeRevisionMetadata,
    normalizeTaskForSyncMerge,
} from './sync-normalization';
import { normalizeTaskForLoad } from './task-status';
import { SYNC_REPAIR_REV_BY } from './sync-types';
import { MAX_SYNC_REVISION } from './sync-revision';
import type { Area, Attachment, Person, Project, Task } from './types';

/**
 * #766 round 3b: the merge-input normalizers return the INPUT object when
 * normalization changes nothing, so an unchanged entity keeps one identity from
 * the store through the merge and the signature caches can hit across cycles.
 *
 * Two things have to stay true, and both are asserted per entity type below:
 * identity-idempotence (an already-normalized entity comes back by reference),
 * and that every repair class still allocates and still repairs the value — an
 * over-eager "same" check would silently stop repairing data.
 */

const NOW = '2026-08-24T12:00:00.000Z';
// Timezone-proof future/past: isFutureStart compares against local end-of-day.
const FAR_FUTURE = '2099-01-01T09:00:00.000Z';

const baseTask = (overrides: Record<string, unknown> = {}): Task => ({
    id: 'task-1',
    title: 'Write the handoff',
    status: 'next',
    tags: ['#admin'],
    contexts: ['@work'],
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-02T09:00:00.000Z',
    rev: 4,
    revBy: 'device-a',
    ...overrides,
} as unknown as Task);

const baseProject = (overrides: Record<string, unknown> = {}): Project => ({
    id: 'project-1',
    title: 'Ship round 3b',
    status: 'active',
    color: '#3b82f6',
    order: 0,
    tagIds: ['#admin'],
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-02T09:00:00.000Z',
    rev: 2,
    revBy: 'device-a',
    ...overrides,
} as unknown as Project);

const baseArea = (overrides: Record<string, unknown> = {}): Area => ({
    id: 'area-1',
    name: 'Work',
    order: 3,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-02T09:00:00.000Z',
    rev: 1,
    revBy: 'device-a',
    ...overrides,
} as unknown as Area);

const basePerson = (overrides: Record<string, unknown> = {}): Person => ({
    id: 'person-1',
    name: 'Ada',
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-02T09:00:00.000Z',
    rev: 1,
    revBy: 'device-a',
    ...overrides,
} as unknown as Person);

/** The shape an entity has once it has been through a merge — what the store holds. */
const merged = <T extends object>(normalized: T): T => normalizeRevisionMetadata(normalized as never) as T;

describe('identity idempotence — an already-normalized entity comes back by reference', () => {
    it('task: normalizeTaskForLoad', () => {
        const once = normalizeTaskForLoad(baseTask({ recurrence: { rule: 'weekly', byDay: ['MO', 'WE'] } }), NOW);
        expect(normalizeTaskForLoad(once, NOW)).toBe(once);
    });

    it('task: normalizeTaskForSyncMerge, remote and local-cleanup variants', () => {
        const remote = merged(normalizeTaskForSyncMerge(baseTask(), NOW));
        expect(normalizeTaskForSyncMerge(remote, NOW)).toBe(remote);
        expect(normalizeRevisionMetadata(normalizeTaskForSyncMerge(remote, NOW))).toBe(remote);

        const local = merged(normalizeTaskForSyncMerge(baseTask(), NOW, true));
        expect(normalizeTaskForSyncMerge(local, NOW, true)).toBe(local);
    });

    it('task: identity survives recurrence, attachments and checklist payloads', () => {
        const rich = baseTask({
            recurrence: { rule: 'weekly', byDay: ['MO', 'WE'], interval: 2 },
            checklist: [{ id: 'c1', title: 'Draft', isCompleted: false }],
            attachments: [
                { id: 'a1', kind: 'link', title: 'Spec', uri: 'https://x.test', createdAt: NOW, updatedAt: NOW },
                { id: 'a2', kind: 'file', title: 'Notes', uri: 'files/notes.md', createdAt: NOW, updatedAt: NOW },
            ] as Attachment[],
            dueDate: '2026-09-01T17:00:00.000Z',
            relativeStartOffset: { amount: -2, unit: 'day' },
        });
        const once = merged(normalizeTaskForSyncMerge(rich, NOW));
        const twice = normalizeTaskForSyncMerge(once, NOW);
        expect(twice).toBe(once);
        expect(twice.recurrence).toBe(once.recurrence);
        expect(twice.attachments).toBe(once.attachments);
        expect(twice.tags).toBe(once.tags);
    });

    it('project', () => {
        const once = merged(normalizeProjectForSyncMerge(baseProject()));
        expect(normalizeProjectForSyncMerge(once)).toBe(once);
        expect(normalizeProjectForSyncMerge(once, true)).toBe(once);
    });

    it('area', () => {
        const once = merged(normalizeAreaForSyncMerge(baseArea(), NOW));
        expect(normalizeAreaForSyncMerge(once as Area, NOW)).toBe(once);
    });

    it('person', () => {
        const once = merged(normalizePersonForSyncMerge(basePerson(), NOW));
        expect(normalizePersonForSyncMerge(once, NOW)).toBe(once);
    });

    it('section (the revision-metadata-only path)', () => {
        const section = { id: 's1', projectId: 'project-1', title: 'Later', order: 0, createdAt: NOW, updatedAt: NOW, rev: 2, revBy: 'device-a' };
        expect(normalizeRevisionMetadata(section)).toBe(section);
        const withoutRevision = { id: 's2', projectId: 'project-1', title: 'Later', order: 0, createdAt: NOW, updatedAt: NOW };
        expect(normalizeRevisionMetadata(withoutRevision)).toBe(withoutRevision);
    });

    it('attachments array', () => {
        const attachments = [
            { id: 'a1', kind: 'link', title: 'Spec', uri: 'https://x.test', createdAt: NOW, updatedAt: NOW },
            { id: 'a2', kind: 'file', title: 'Notes', uri: 'files/notes.md', cloudKey: undefined, fileHash: undefined, createdAt: NOW, updatedAt: NOW },
        ] as Attachment[];
        expect(normalizeAttachmentsForSyncMerge(attachments)).toBe(attachments);
        expect(normalizeAttachmentsForSyncMerge(undefined)).toBeUndefined();
    });
});

describe('repair classes still allocate and still repair', () => {
    it('invalid rev is stripped', () => {
        for (const rev of [-1, 1.5, Number.NaN, '3', null]) {
            const item = { id: 'x', rev } as Record<string, unknown>;
            const normalized = normalizeRevisionMetadata(item);
            expect(normalized).not.toBe(item);
            expect('rev' in normalized).toBe(false);
        }
    });

    it('an out-of-range rev is clamped', () => {
        const item = { id: 'x', rev: MAX_SYNC_REVISION + 1 };
        const normalized = normalizeRevisionMetadata(item);
        expect(normalized).not.toBe(item);
        expect(normalized.rev).toBe(MAX_SYNC_REVISION);
    });

    it('untrimmed or empty revBy is trimmed or stripped', () => {
        const untrimmed = { id: 'x', rev: 1, revBy: '  device-a  ' };
        const trimmed = normalizeRevisionMetadata(untrimmed);
        expect(trimmed).not.toBe(untrimmed);
        expect(trimmed.revBy).toBe('device-a');

        const blank = { id: 'x', rev: 1, revBy: '   ' };
        const stripped = normalizeRevisionMetadata(blank);
        expect(stripped).not.toBe(blank);
        expect('revBy' in stripped).toBe(false);

        const nonString = { id: 'x', rev: 1, revBy: 42 };
        const dropped = normalizeRevisionMetadata(nonString);
        expect(dropped).not.toBe(nonString);
        expect('revBy' in dropped).toBe(false);
    });

    it('purged task tombstone is compacted and rev-bumped when uncompacted', () => {
        const task = baseTask({ purgedAt: '2026-08-03T09:00:00.000Z', deletedAt: '2026-08-03T09:00:00.000Z', title: 'Secret', description: 'Secret notes' });
        const normalized = normalizeTaskForSyncMerge(task, NOW);
        expect(normalized).not.toBe(task);
        expect(normalized.title).toBe('(deleted)');
        expect(normalized.rev).toBe(5);
        expect(normalized.revBy).toBe(SYNC_REPAIR_REV_BY);
        // Converged: a second pass must not bump again (the #766 rewrite loop).
        const twice = normalizeTaskForSyncMerge(normalized, NOW);
        expect(twice.rev).toBe(normalized.rev);
    });

    it('purged project tombstone is compacted and rev-bumped when uncompacted', () => {
        const project = baseProject({ purgedAt: '2026-08-03T09:00:00.000Z', deletedAt: '2026-08-03T09:00:00.000Z', notes: 'Secret' });
        const normalized = normalizeProjectForSyncMerge(project);
        expect(normalized).not.toBe(project);
        expect(normalized.title).toBe('(deleted)');
        expect(normalized.rev).toBe(3);
        expect(normalizeProjectForSyncMerge(normalized).rev).toBe(normalized.rev);
    });

    it('missing createdAt is backfilled', () => {
        const task = baseTask({ createdAt: undefined });
        const normalized = normalizeTaskForLoad(task, NOW);
        expect(normalized).not.toBe(task);
        expect(normalized.createdAt).toBe(NOW);

        const area = baseArea({ createdAt: undefined });
        const normalizedArea = normalizeAreaForSyncMerge(area, NOW);
        expect(normalizedArea).not.toBe(area);
        expect(normalizedArea.createdAt).toBe('2026-08-02T09:00:00.000Z');

        const person = basePerson({ createdAt: undefined, updatedAt: undefined });
        const normalizedPerson = normalizePersonForSyncMerge(person, NOW);
        expect(normalizedPerson).not.toBe(person);
        expect(normalizedPerson.createdAt).toBe(NOW);
    });

    it('done without completedAt gets one, and a non-done completedAt is cleared', () => {
        const done = baseTask({ status: 'done' });
        const normalizedDone = normalizeTaskForLoad(done, NOW);
        expect(normalizedDone).not.toBe(done);
        expect(normalizedDone.completedAt).toBe('2026-08-02T09:00:00.000Z');
        expect(normalizedDone.isFocusedToday).toBe(false);

        const stale = baseTask({ status: 'next', completedAt: '2026-08-02T09:00:00.000Z' });
        const normalizedStale = normalizeTaskForLoad(stale, NOW);
        expect(normalizedStale).not.toBe(stale);
        expect(normalizedStale.completedAt).toBeUndefined();
    });

    it('a focused task with a future start is unfocused', () => {
        const task = baseTask({ isFocusedToday: true, focusOrder: 2, startTime: FAR_FUTURE });
        const normalized = normalizeTaskForLoad(task, NOW);
        expect(normalized).not.toBe(task);
        expect(normalized.isFocusedToday).toBe(false);
        expect(normalized.focusOrder).toBeUndefined();
    });

    it('unnormalized string arrays are filtered', () => {
        const task = baseTask({ tags: ['#admin', 7, null], contexts: ['@work'] });
        const normalized = normalizeTaskForSyncMerge(task, NOW);
        expect(normalized).not.toBe(task);
        expect(normalized.tags).toStrictEqual(['#admin']);
        // The untouched sibling array keeps its identity.
        expect(normalized.contexts).toBe(task.contexts);

        const project = baseProject({ tagIds: [1, '#admin'] });
        const normalizedProject = normalizeProjectForSyncMerge(project);
        expect(normalizedProject).not.toBe(project);
        expect(normalizedProject.tagIds).toStrictEqual(['#admin']);
    });

    it('unsafe attachment fields are sanitized, and clean siblings keep identity', () => {
        const clean = { id: 'a1', kind: 'file', title: 'Ok', uri: 'files/ok.txt', cloudKey: undefined, fileHash: undefined, createdAt: NOW, updatedAt: NOW } as Attachment;
        const dirty = { id: 'a2', kind: 'file', title: 'Bad', uri: '../etc/passwd', cloudKey: 'not a key', fileHash: 'deadbeef', createdAt: NOW, updatedAt: NOW } as Attachment;
        const attachments = [clean, dirty];
        const normalized = normalizeAttachmentsForSyncMerge(attachments);
        expect(normalized).not.toBe(attachments);
        expect(normalized?.[0]).toBe(clean);
        expect(normalized?.[1]).not.toBe(dirty);
        expect(normalized?.[1]).toMatchObject({ uri: '', cloudKey: undefined, fileHash: undefined });
    });

    it('unknown task fields are stripped', () => {
        const task = baseTask({ legacyJunk: 'strip me' });
        const normalized = normalizeTaskForSyncMerge(task, NOW);
        expect(normalized).not.toBe(task);
        expect('legacyJunk' in normalized).toBe(false);
    });

    it('project value repairs still fire', () => {
        const project = baseProject({ status: 'ARCHIVED', color: '   ', isSequential: 1, areaId: '  ', dueDate: '' });
        const normalized = normalizeProjectForSyncMerge(project);
        expect(normalized).not.toBe(project);
        expect(normalized.status).toBe('archived');
        expect(normalized.color).toBe('#6B7280');
        expect(normalized.isSequential).toBe(true);
        expect(normalized.areaId).toBeUndefined();
        expect(normalized.dueDate).toBeUndefined();
    });

    it('area value repairs still fire', () => {
        const area = baseArea({ order: Number.NaN, color: '  ' });
        const normalized = normalizeAreaForSyncMerge(area, NOW);
        expect(normalized).not.toBe(area);
        expect(normalized.order).toBeUndefined();
        expect(normalized.color).toBeUndefined();
    });

    it('person value repairs still fire', () => {
        const person = basePerson({ name: '  Ada  ', note: '  hi  ', referenceLink: '  https://x.test  ' });
        const normalized = normalizePersonForSyncMerge(person, NOW);
        expect(normalized).not.toBe(person);
        expect(normalized.name).toBe('Ada');
        expect(normalized.note).toBe('hi');
        expect(normalized.referenceLink).toBe('https://x.test');
    });
});

describe('composed merge pipeline reaches an identity fixed point', () => {
    // sync.ts composes normalizeRevisionMetadata AFTER normalizeTaskForSyncMerge.
    // The two must agree on the emitted key set, or an unchanged task oscillates
    // between shapes forever and the signature caches never hit (#766 round 3b
    // review finding: the exhaustive literal materialized rev/revBy as explicit
    // undefined; normalizeRevisionMetadata deleted them right back).
    const composed = (task: Task, preserveLocalCleanupMetadata = false): Task =>
        normalizeRevisionMetadata(normalizeTaskForSyncMerge(task, NOW, preserveLocalCleanupMetadata));

    it('task without rev/revBy converges, both variants', () => {
        const bare = baseTask();
        delete (bare as Record<string, unknown>).rev;
        delete (bare as Record<string, unknown>).revBy;
        const once = composed(bare);
        // normalizeTaskForLoad backfills rev to 0; revBy stays absent.
        expect(once.rev).toBe(0);
        expect('revBy' in once).toBe(false);
        expect(composed(once)).toBe(once);
        expect(composed(once, true)).toBe(once);
    });

    it('task with explicit-undefined revBy (legacy deviceId-less write) converges after one repair', () => {
        const once = composed(baseTask({ revBy: undefined }));
        expect('revBy' in once).toBe(false);
        expect(composed(once)).toBe(once);
    });

    it('task with real rev/revBy converges immediately', () => {
        const once = composed(baseTask());
        expect(composed(once)).toBe(once);
    });

    it('a rev/revBy repair converges after one pass', () => {
        const once = composed(baseTask({ rev: -1, revBy: '   ' }));
        // Invalid rev is coerced to 0 by normalizeTaskForLoad; blank revBy is stripped.
        expect(once.rev).toBe(0);
        expect('revBy' in once).toBe(false);
        expect(composed(once)).toBe(once);
    });

    it('project, area and person converge through the composed pipeline', () => {
        const project = normalizeRevisionMetadata(normalizeProjectForSyncMerge(baseProject()));
        expect(normalizeRevisionMetadata(normalizeProjectForSyncMerge(project))).toBe(project);

        const area = normalizeRevisionMetadata(normalizeAreaForSyncMerge(baseArea(), NOW));
        expect(normalizeRevisionMetadata(normalizeAreaForSyncMerge(area as Area, NOW))).toBe(area);

        const person = normalizeRevisionMetadata(normalizePersonForSyncMerge(basePerson(), NOW));
        expect(normalizeRevisionMetadata(normalizePersonForSyncMerge(person, NOW))).toBe(person);
    });
});

describe('value parity — a stripped or added key counts as a change', () => {
    it('a key the normalizer adds as explicit undefined is not "unchanged"', () => {
        // baseTask has no `attachments` key at all; the merge normalizer emits one.
        const task = baseTask();
        const normalized = normalizeTaskForSyncMerge(task, NOW);
        expect(normalized).not.toBe(task);
        expect('attachments' in normalized).toBe(true);
        expect(normalized.attachments).toBeUndefined();
    });

    it('normalized messy input keeps its exact emitted shape', () => {
        const normalized = normalizeTaskForSyncMerge(
            baseTask({ tags: ['#a', 3], isFocusedToday: 1, showFutureRecurrence: 1, pushCount: 'nope', order: 4 }),
            NOW,
        );
        expect(normalized).toStrictEqual({
            id: 'task-1',
            title: 'Write the handoff',
            status: 'next',
            priority: undefined,
            energyLevel: undefined,
            assignedTo: undefined,
            taskMode: undefined,
            startTime: undefined,
            relativeStartOffset: undefined,
            dueDate: undefined,
            recurrence: undefined,
            pushCount: 0,
            tags: ['#a'],
            contexts: ['@work'],
            checklist: undefined,
            description: undefined,
            textDirection: undefined,
            attachments: undefined,
            location: undefined,
            projectId: undefined,
            sectionId: undefined,
            areaId: undefined,
            isFocusedToday: true,
            timeEstimate: undefined,
            timeSpentMinutes: undefined,
            showFutureRecurrence: undefined,
            suppressMindwtrReminders: false,
            repeatReminderMinutes: undefined,
            reviewAt: undefined,
            completedAt: undefined,
            statusBeforeProjectArchive: undefined,
            completedAtBeforeProjectArchive: undefined,
            isFocusedTodayBeforeProjectArchive: undefined,
            projectArchivedAt: undefined,
            rev: 4,
            revBy: 'device-a',
            createdAt: '2026-08-01T09:00:00.000Z',
            updatedAt: '2026-08-02T09:00:00.000Z',
            deletedAt: undefined,
            purgedAt: undefined,
            order: 4,
            orderNum: 4,
            boardOrder: undefined,
            focusOrder: undefined,
        });
    });
});
