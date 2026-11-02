import { describe, expect, it } from 'vitest';
import { normalizeTaskForSyncMerge } from './sync-normalization';
import { mergeAppDataWithStats } from './sync';
import { createMockTask, mockAppData } from './sync-test-utils';
import { normalizeTaskForContentComparison, toComparableSignature } from './sync-signatures';
import { createTaskDraft, taskDraftToUpdatePatch, setTaskDraftField } from './task-draft';
import { applyTaskUpdates, normalizeTaskUpdate } from './store-helpers';
import { buildProcessInboxUndoRestoreUpdates } from './process-inbox-model';
import { TASK_SQLITE_COLUMNS, taskFromSqliteRow, taskToSqliteRow } from './task-sync-schema';

const NOW = '2026-10-24T12:00:00.000Z';
const task = (lead?: number) => ({ ...createMockTask('advance', NOW), startTime: '2026-10-25T15:00:00.000Z', startReminderLeadMinutes: lead });
const signature = (lead?: number) => toComparableSignature(normalizeTaskForContentComparison(task(lead)));

describe('start advance reminder data lifecycle', () => {
    it('preserves configured and explicitly cleared values through JSON and SQLite codecs', () => {
        for (const lead of [undefined, 0, 5, 15, 30, 60]) {
            const source = task(lead);
            const cells = taskToSqliteRow(source);
            const row = Object.fromEntries(TASK_SQLITE_COLUMNS.map((column, index) => [column, cells[index]]));
            const loaded = normalizeTaskForSyncMerge(taskFromSqliteRow(row), NOW);
            expect(loaded.startReminderLeadMinutes).toBe(lead);
            const jsonLoaded = normalizeTaskForSyncMerge(JSON.parse(JSON.stringify(loaded)), NOW);
            expect(jsonLoaded).toEqual(loaded);
            expect(normalizeTaskForSyncMerge(jsonLoaded, NOW)).toEqual(jsonLoaded);
        }
        expect(signature(0)).toBe(signature());
        expect(signature(15)).not.toBe(signature());
    });

    it('drops malformed imported offsets and keeps the maximum bounded', () => {
        for (const lead of [-1, 1, 1.5, 61, 1440, Infinity, NaN]) {
            expect(normalizeTaskForSyncMerge(task(lead), NOW).startReminderLeadMinutes).toBeUndefined();
            expect(taskFromSqliteRow({ ...task(), startReminderLeadMinutes: lead }).startReminderLeadMinutes).toBeUndefined();
        }
    });

    it('keeps the option across an old-client winner and converges without repeated diffs', () => {
        const configured = mockAppData([{ ...task(15), rev: 1 }]);
        const old = mockAppData([{ ...createMockTask('advance', NOW), title: 'Old client edit', rev: 2 }]);
        const first = mergeAppDataWithStats(configured, old, { nowIso: NOW });
        expect(first.data.tasks[0].title).toBe('Old client edit');
        expect(first.data.tasks[0].startReminderLeadMinutes).toBe(15);
        expect(mergeAppDataWithStats(old, configured, { nowIso: NOW }).data).toEqual(first.data);
        const aligned = JSON.parse(JSON.stringify(first.data));
        const second = mergeAppDataWithStats(first.data, aligned, { nowIso: NOW });
        expect(second.data).toEqual(first.data);
        expect(second.stats.tasks.conflicts).toBe(0);
        expect(mergeAppDataWithStats(first.data, old, { nowIso: NOW }).data).toEqual(first.data);
    });

    it('preserves absent reference metadata but explicitly clears on conversion and snapshot restore', () => {
        const existing = { ...task(), status: 'reference' as const };
        expect(applyTaskUpdates(existing, { tags: ['#changed'] }, NOW).updatedTask.startReminderLeadMinutes).toBeUndefined();
        const configured = { ...existing, startReminderLeadMinutes: 15 };
        expect(applyTaskUpdates(configured, { tags: ['#changed'] }, NOW).updatedTask.startReminderLeadMinutes).toBe(0);
        const converted = applyTaskUpdates(task(15), { status: 'reference' }, NOW).updatedTask;
        expect(converted.startReminderLeadMinutes).toBe(0);
        const peer = mockAppData([{ ...task(15), rev: 1 }]);
        const merged = mergeAppDataWithStats(peer, mockAppData([{ ...converted, rev: 2 }]), { nowIso: NOW }).data;
        expect(merged.tasks[0].startReminderLeadMinutes).toBe(0);
        expect(normalizeTaskUpdate(task(), { startReminderLeadMinutes: undefined }).startReminderLeadMinutes).toBeUndefined();
        const restored = normalizeTaskUpdate(task(15), buildProcessInboxUndoRestoreUpdates(task()));
        expect(restored.startReminderLeadMinutes).toBe(0);
        expect(normalizeTaskUpdate(task(), buildProcessInboxUndoRestoreUpdates(task(15))).startReminderLeadMinutes).toBe(15);
    });

    it('persists explicit Off through merge and draft editing without erasing hidden options', () => {
        const original = task(15);
        const draft = createTaskDraft(original);
        const legacy = { ...draft, startReminderLeadMinutes: undefined };
        expect(taskDraftToUpdatePatch(legacy, original)?.startReminderLeadMinutes).toBeUndefined();
        const clear = taskDraftToUpdatePatch(setTaskDraftField(draft, 'startReminderLeadMinutes', 0), original)!;
        expect(clear.startReminderLeadMinutes).toBe(0);
        expect(normalizeTaskUpdate(original, { startReminderLeadMinutes: undefined }).startReminderLeadMinutes).toBe(0);
        const cleared = mockAppData([{ ...original, ...clear, rev: 2 }]);
        const merged = mergeAppDataWithStats(mockAppData([{ ...original, rev: 1 }]), cleared, { nowIso: NOW }).data;
        expect(merged.tasks[0].startReminderLeadMinutes).toBe(0);
        expect(normalizeTaskForSyncMerge(JSON.parse(JSON.stringify(merged.tasks[0])), NOW).startReminderLeadMinutes).toBe(0);
        const dateOnly = taskDraftToUpdatePatch(setTaskDraftField(draft, 'startTime', '2026-10-25'), original)!;
        expect(normalizeTaskUpdate(original, dateOnly).startReminderLeadMinutes).toBeUndefined();
        expect({ ...original, ...dateOnly }.startReminderLeadMinutes).toBe(15);
    });
});
