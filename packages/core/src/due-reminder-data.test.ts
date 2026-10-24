import { describe, expect, it } from 'vitest';
import { normalizeTaskForSyncMerge } from './sync-normalization';
import { mergeAppDataWithStats } from './sync';
import { createMockTask, mockAppData } from './sync-test-utils';
import { normalizeTaskForContentComparison, toComparableSignature } from './sync-signatures';
import { createTaskDraft, taskDraftToUpdatePatch, setTaskDraftField } from './task-draft';
import { normalizeTaskUpdate } from './store-helpers';
import { TASK_SQLITE_COLUMNS, taskFromSqliteRow, taskToSqliteRow } from './task-sync-schema';

const NOW = '2026-10-24T12:00:00.000Z';
const task = (lead?: number) => ({ ...createMockTask('advance', NOW), dueDate: '2026-10-25T15:00:00.000Z', dueReminderLeadMinutes: lead });
const signature = (lead?: number) => toComparableSignature(normalizeTaskForContentComparison(task(lead)));

describe('due advance reminder data lifecycle', () => {
    it('preserves configured and explicitly cleared values through JSON and SQLite codecs', () => {
        for (const lead of [undefined, 0, 5, 1440, 10080]) {
            const source = task(lead);
            const cells = taskToSqliteRow(source);
            const row = Object.fromEntries(TASK_SQLITE_COLUMNS.map((column, index) => [column, cells[index]]));
            const loaded = normalizeTaskForSyncMerge(taskFromSqliteRow(row), NOW);
            expect(loaded.dueReminderLeadMinutes).toBe(lead);
            const jsonLoaded = normalizeTaskForSyncMerge(JSON.parse(JSON.stringify(loaded)), NOW);
            expect(jsonLoaded).toEqual(loaded);
            expect(normalizeTaskForSyncMerge(jsonLoaded, NOW)).toEqual(jsonLoaded);
        }
        expect(signature(0)).toBe(signature());
        expect(signature(15)).not.toBe(signature());
    });

    it('drops malformed imported offsets and keeps the maximum bounded', () => {
        for (const lead of [-1, 1.5, 10081, Infinity, NaN]) {
            expect(normalizeTaskForSyncMerge(task(lead), NOW).dueReminderLeadMinutes).toBeUndefined();
            expect(taskFromSqliteRow({ ...task(), dueReminderLeadMinutes: lead }).dueReminderLeadMinutes).toBeUndefined();
        }
    });

    it('keeps the option across an old-client winner and converges without repeated diffs', () => {
        const configured = mockAppData([{ ...task(15), rev: 1 }]);
        const old = mockAppData([{ ...createMockTask('advance', NOW), title: 'Old client edit', rev: 2 }]);
        const first = mergeAppDataWithStats(configured, old, { nowIso: NOW });
        expect(first.data.tasks[0].title).toBe('Old client edit');
        expect(first.data.tasks[0].dueReminderLeadMinutes).toBe(15);
        expect(mergeAppDataWithStats(old, configured, { nowIso: NOW }).data).toEqual(first.data);
        const aligned = JSON.parse(JSON.stringify(first.data));
        const second = mergeAppDataWithStats(first.data, aligned, { nowIso: NOW });
        expect(second.data).toEqual(first.data);
        expect(second.stats.tasks.conflicts).toBe(0);
        expect(mergeAppDataWithStats(first.data, old, { nowIso: NOW }).data).toEqual(first.data);
    });

    it('persists explicit Off through merge and draft editing without erasing hidden options', () => {
        const original = task(15);
        const draft = createTaskDraft(original);
        const legacy = { ...draft, dueReminderLeadMinutes: undefined };
        expect(taskDraftToUpdatePatch(legacy, original)?.dueReminderLeadMinutes).toBeUndefined();
        const clear = taskDraftToUpdatePatch(setTaskDraftField(draft, 'dueReminderLeadMinutes', 0), original)!;
        expect(clear.dueReminderLeadMinutes).toBe(0);
        expect(normalizeTaskUpdate(original, { dueReminderLeadMinutes: undefined }).dueReminderLeadMinutes).toBe(0);
        const cleared = mockAppData([{ ...original, ...clear, rev: 2 }]);
        const merged = mergeAppDataWithStats(mockAppData([{ ...original, rev: 1 }]), cleared, { nowIso: NOW }).data;
        expect(merged.tasks[0].dueReminderLeadMinutes).toBe(0);
        expect(normalizeTaskForSyncMerge(JSON.parse(JSON.stringify(merged.tasks[0])), NOW).dueReminderLeadMinutes).toBe(0);
        const dateOnly = taskDraftToUpdatePatch(setTaskDraftField(draft, 'dueDate', '2026-10-25'), original)!;
        expect(normalizeTaskUpdate(original, dateOnly).dueReminderLeadMinutes).toBeUndefined();
        expect({ ...original, ...dateOnly }.dueReminderLeadMinutes).toBe(15);
    });
});
