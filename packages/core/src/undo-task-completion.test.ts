import { afterEach, describe, expect, it } from 'vitest';

import { formatProcessInboxCommitMessage } from './process-inbox-model';
import { formatSomedaySectionMoved } from './someday-sections-model';
import { flushPendingSave, resetForTests, useTaskStore } from './store';
import { runSyncStoreSave } from './store-write-gate';
import type { Task } from './types';
import { formatTaskMarkedDoneMessage, formatTaskMovedMessage, restoreTaskSnapshot, undoTaskCompletion } from './undo-task-completion';

// The two keys ship with different placeholder conventions ('{title}' vs
// '{{title}}'); the formatters interpret the keys as they are, so both platforms
// get the same text from one home instead of hand-rolling a `.replace` each.
describe('task action toast text', () => {
    const passthrough = (key: string) => key;

    it('falls back to English when the key is missing', () => {
        expect(formatTaskMarkedDoneMessage(passthrough, 'File taxes')).toBe('File taxes marked Done');
        expect(formatTaskMovedMessage(passthrough, 'File taxes', 'waiting'))
            .toBe('File taxes moved to waiting');
    });

    it('fills a translated template and the translated status name', () => {
        const t = (key: string) => (
            key === 'task.markedDone' ? '{title} erledigt'
                : key === 'task.movedToStatus' ? '{{title}} nach {{status}} verschoben'
                    : key === 'status.waiting' ? 'Wartend'
                        : key
        );
        expect(formatTaskMarkedDoneMessage(t, 'Steuern')).toBe('Steuern erledigt');
        expect(formatTaskMovedMessage(t, 'Steuern', 'waiting')).toBe('Steuern nach Wartend verschoben');
    });

    it('inserts a title or section name literally, even with $ replacement patterns', () => {
        // String.replace expands $&, $$ and $1 in a replacement string.
        const title = 'Pay $& and $$ {{status}}';
        expect(formatTaskMarkedDoneMessage(passthrough, title)).toBe(`${title} marked Done`);
        expect(formatTaskMovedMessage(passthrough, title, 'waiting')).toBe(`${title} moved to waiting`);
        expect(formatProcessInboxCommitMessage(passthrough, 'trash', title)).toBe(`${title} moved to Trash`);
        expect(formatSomedaySectionMoved(passthrough, 2, 'Ideas $&')).toBe('Moved to Ideas $& (2)');
    });
});

describe('undo of a processed task after sync changed it', () => {
    afterEach(async () => { await flushPendingSave(); resetForTests(); });
    const AT = new Date(Date.now() - 60_000).toISOString();
    const row = (extra: Partial<Task>): Task => ({
        id: 't1', title: 'Inbox item', status: 'done', tags: [], contexts: [], createdAt: AT, updatedAt: AT,
        rev: 2, revBy: 'this-device', ...extra,
    } as Task);

    it('refuses to restore the fields it saw when another device wrote the task after the decision', async () => {
        useTaskStore.setState({ settings: { deviceId: 'this-device' }, _allTasks: [row({})] });
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        // The decision is done; a sync save publishes the other device's new tag before the Undo is admitted.
        const save = runSyncStoreSave(async () => {
            await held;
            useTaskStore.setState({ _allTasks: [row({ rev: 3, revBy: 'other-device', tags: ['remote'] })] });
        });
        const undo = undoTaskCompletion('t1', 'inbox', false, { restoreUpdates: { title: 'Inbox item', tags: [], status: 'inbox' } });
        const restore = restoreTaskSnapshot('t1', { tags: [] });
        release();
        await save;
        await expect(undo).rejects.toThrow(/^STALE_REVISION/);
        expect(await restore).toMatchObject({ success: false, error: expect.stringMatching(/^STALE_REVISION/) });
        expect(useTaskStore.getState()._tasksById.get('t1')).toMatchObject({ tags: ['remote'], status: 'done' });
    });

    it('restores when only this device wrote the task since', async () => {
        useTaskStore.setState({ settings: { deviceId: 'this-device' }, _allTasks: [row({ tags: ['decided'] })] });
        await undoTaskCompletion('t1', 'inbox', false, { restoreUpdates: { tags: [], status: 'inbox' } });
        expect(useTaskStore.getState()._tasksById.get('t1')).toMatchObject({ tags: [], status: 'inbox' });
    });
});
