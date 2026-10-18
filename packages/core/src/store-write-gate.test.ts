import { describe, expect, it } from 'vitest';

import { createNativeRequestReceipts, resetNativeRequestReceipts } from './native-request-receipts';
import { STORE_NON_COMMAND_KEYS, useTaskStore } from './store';
import { isStoreCommand, runOutsideStoreGate, runStoreCommand, runSyncStoreSave } from './store-write-gate';

describe('store write gate', () => {
    it('lets a sync save run only between commands, and a nested command join its caller', async () => {
        const order: string[] = [];
        let finishOuter!: () => void;
        const outer = runStoreCommand(async () => {
            order.push('outer start');
            await new Promise<void>((resolve) => { finishOuter = resolve; });
            // A sync save is waiting now; a nested command must still join, or the save and this command wait on each other.
            await runStoreCommand(async () => { order.push('nested'); });
            order.push('outer end');
        });
        let late: Promise<void> = Promise.resolve();
        const save = runSyncStoreSave(async () => {
            order.push('save start');
            // A command that arrives while the save holds the gate waits for it.
            late = runStoreCommand(async () => { order.push('late command'); });
            await Promise.resolve();
            order.push('save end');
        });
        finishOuter();
        await Promise.all([outer, save]);
        await late;
        expect(order).toEqual(['outer start', 'nested', 'outer end', 'save start', 'save end', 'late command']);
    });

    it('lets a sync save run while a command waits on the network, and rejoins a nested caller without waiting', async () => {
        const order: string[] = [];
        let release!: () => void;
        const network = new Promise<void>((resolve) => { release = resolve; });
        const command = runStoreCommand(async () => {
            await runOutsideStoreGate(async () => { order.push('network start'); await network; order.push('network end'); });
            order.push('command writes');
        });
        await Promise.resolve();
        await runSyncStoreSave(async () => { order.push('save'); });
        release();
        await command;
        expect(order).toEqual(['network start', 'save', 'network end', 'command writes']);

        // Nested: the caller still holds the gate, so the save waits for it and the inner command rejoins at once.
        const nested: string[] = [];
        let releaseNested!: () => void;
        const nestedNetwork = new Promise<void>((resolve) => { releaseNested = resolve; });
        const outer = runStoreCommand(async () => {
            await runStoreCommand(() => runOutsideStoreGate(async () => { await nestedNetwork; nested.push('inner done'); }));
            nested.push('outer done');
        });
        await Promise.resolve();
        const save = runSyncStoreSave(async () => { nested.push('save'); });
        releaseNested();
        await Promise.all([outer, save]);
        expect(nested).toEqual(['inner done', 'outer done', 'save']);
    });

    it('releases the gate when a sync save throws', async () => {
        await expect(runSyncStoreSave(async () => { throw new Error('refused'); })).rejects.toThrow('refused');
        await expect(runStoreCommand(async () => 'ran')).resolves.toBe('ran');
    });

    it('runs every store function that writes as a gated command', () => {
        const state = useTaskStore.getState() as unknown as Record<string, unknown>;
        const functions = Object.keys(state).filter((key) => typeof state[key] === 'function');
        // The non-commands are reads and view state: none persists a store change.
        expect([...STORE_NON_COMMAND_KEYS].sort()).toEqual(['getDerivedState', 'getFocusStarAction', 'getFocusedCount',
            'lockEditing', 'queryTasks', 'setError', 'setHighlightTask', 'unlockEditing']);
        const ungated = functions.filter((key) => !isStoreCommand(state[key]));
        expect(ungated.sort()).toEqual([...STORE_NON_COMMAND_KEYS].sort());
        // Prepared mutators and App Lock's commit and retry are commands too (review of change 0, P1 3).
        for (const key of ['commitPreparedTaskEdit', 'commitPreparedAppLock', 'retryPreparedAppLockSnapshot', 'cancelTask', 'fetchData']) {
            expect(isStoreCommand(state[key])).toBe(true);
        }
    });

    it('makes a native receipt save wait while a sync save holds the gate', async () => {
        resetNativeRequestReceipts();
        const order: string[] = [];
        const receipts = createNativeRequestReceipts({ save: async () => {
            order.push('receipt save');
            return { ok: true, value: null };
        } });
        let release!: () => void;
        const sync = runSyncStoreSave(async () => {
            order.push('sync save');
            await new Promise<void>((resolve) => { release = resolve; });
            order.push('sync publish');
        });
        await Promise.resolve();
        const command = receipts.run('11111111-2222-4333-8444-555555555555', JSON.stringify(['gateProbe']),
            async () => ({ ok: true, value: 'written' }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        release();
        await sync;
        await expect(command).resolves.toEqual({ ok: true, value: 'written' });
        expect(order).toEqual(['sync save', 'sync publish', 'receipt save']);
    });
});
