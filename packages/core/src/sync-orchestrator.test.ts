import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyncOrchestrator, runPreSyncAttachmentPhase } from './sync-orchestrator';

describe('sync orchestrator', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('re-runs a queued cycle after the in-flight cycle completes', async () => {
        const calls: number[] = [];
        const orchestrator = createSyncOrchestrator<string | undefined, number>({
            runCycle: async (arg) => {
                calls.push(calls.length + 1);
                if (arg === 'initial') {
                    await new Promise((resolve) => setTimeout(resolve, 30));
                }
                return calls.length;
            },
        });

        const first = orchestrator.run('initial');
        const second = orchestrator.run('queued');

        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(firstResult).toBe(1);
        expect(secondResult).toBe(1);

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(calls).toHaveLength(2);
    });

    it('uses the latest queued argument for follow-up runs', async () => {
        const args: Array<string | undefined> = [];
        const orchestrator = createSyncOrchestrator<string | undefined, string>({
            runCycle: async (arg) => {
                args.push(arg);
                if (args.length === 1) {
                    await new Promise((resolve) => setTimeout(resolve, 25));
                }
                return arg ?? 'none';
            },
        });

        const first = orchestrator.run('first');
        const second = orchestrator.run('second');
        const third = orchestrator.run('third');

        await Promise.all([first, second, third]);
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(args).toEqual(['first', 'third']);
    });

    it('supports requesting follow-up from inside a running cycle', async () => {
        let calls = 0;
        const orchestrator = createSyncOrchestrator<string | undefined, number>({
            runCycle: async (_arg, { requestFollowUp }) => {
                calls += 1;
                if (calls === 1) {
                    requestFollowUp();
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                return calls;
            },
        });

        const result = await orchestrator.run(undefined);
        expect(result).toBe(1);

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(calls).toBe(2);
    });

    it('treats synchronous re-entrant calls as queued while the first cycle is in flight', async () => {
        const args: Array<string | undefined> = [];
        const nestedCallStates: Array<{ inFlight: boolean; queued: boolean }> = [];
        const orchestrator = createSyncOrchestrator<string | undefined, string>({
            runCycle: async (arg) => {
                args.push(arg);
                if (arg === 'first') {
                    void orchestrator.run('second');
                    nestedCallStates.push(orchestrator.getState());
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
                return arg ?? 'none';
            },
        });

        const result = await orchestrator.run('first');
        expect(result).toBe('first');
        expect(nestedCallStates).toEqual([{ inFlight: true, queued: true }]);

        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(args).toEqual(['first', 'second']);
    });
});

describe('pre-sync attachment phase', () => {
    it('runs the webdav operation behind a network availability check', async () => {
        const ensureNetworkStillAvailable = vi.fn();
        const webdav = vi.fn(async () => ({ id: 'mutated' }));

        const result = await runPreSyncAttachmentPhase({
            backend: 'webdav',
            data: { id: 'original' },
            ensureNetworkStillAvailable,
            webdav,
        });

        expect(ensureNetworkStillAvailable).toHaveBeenCalledOnce();
        expect(webdav).toHaveBeenCalledWith({ id: 'original' });
        expect(result).toEqual({ data: { id: 'mutated' }, mutated: true, ran: true });
    });

    it('uses boolean mutation results with the original data snapshot', async () => {
        const data = { id: 'original' };
        const file = vi.fn(async () => true);

        const result = await runPreSyncAttachmentPhase({
            backend: 'file',
            data,
            file,
        });

        expect(result).toEqual({ data, mutated: true, ran: true });
    });

    it('selects the cloud operation from the configured provider', async () => {
        const dropbox = vi.fn(async () => false);
        const selfHostedCloud = vi.fn(async () => true);

        const result = await runPreSyncAttachmentPhase({
            backend: 'cloud',
            cloudProvider: 'dropbox',
            data: { id: 'original' },
            dropbox,
            selfHostedCloud,
        });

        expect(dropbox).toHaveBeenCalledOnce();
        expect(selfHostedCloud).not.toHaveBeenCalled();
        expect(result).toEqual({ data: null, mutated: false, ran: true });
    });

    it('skips unsupported or unconfigured backends', async () => {
        await expect(runPreSyncAttachmentPhase({
            backend: 'cloudkit',
            data: { id: 'original' },
        })).resolves.toEqual({ data: null, mutated: false, ran: false });

        await expect(runPreSyncAttachmentPhase({
            backend: 'webdav',
            data: { id: 'original' },
        })).resolves.toEqual({ data: null, mutated: false, ran: false });
    });
});
