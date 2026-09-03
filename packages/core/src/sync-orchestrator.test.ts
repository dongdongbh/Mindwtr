import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyncOrchestrator } from './sync-orchestrator';

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

    it('can clear a queued follow-up before the in-flight cycle drains', async () => {
        const calls: string[] = [];
        const orchestrator = createSyncOrchestrator<string, string>({
            runCycle: async (arg) => {
                calls.push(arg);
                if (arg === 'first') {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
                return arg;
            },
        });

        const first = orchestrator.run('first');
        const second = orchestrator.run('second');
        expect(orchestrator.getState()).toEqual({ inFlight: true, queued: true });

        orchestrator.clearFollowUp();
        expect(orchestrator.getState()).toEqual({ inFlight: true, queued: false });

        await expect(first).resolves.toBe('first');
        await expect(second).resolves.toBe('first');
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(calls).toEqual(['first']);
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

    it('delays a queued follow-up by getFollowUpDelayMs instead of re-running immediately', async () => {
        vi.useFakeTimers();
        try {
            const calls: number[] = [];
            const orchestrator = createSyncOrchestrator<undefined, number>({
                getFollowUpDelayMs: () => 5_000,
                runCycle: async (_arg, { requestFollowUp }) => {
                    calls.push(calls.length + 1);
                    if (calls.length === 1) {
                        requestFollowUp();
                    }
                    return calls.length;
                },
            });

            await orchestrator.run(undefined);
            expect(calls).toHaveLength(1);

            await vi.advanceTimersByTimeAsync(4_999);
            expect(calls).toHaveLength(1);

            await vi.advanceTimersByTimeAsync(1);
            expect(calls).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('honors a provider-derived minimum delay requested by the running cycle', async () => {
        vi.useFakeTimers();
        try {
            const calls: number[] = [];
            const orchestrator = createSyncOrchestrator<undefined, number>({
                runCycle: async (_arg, { requestFollowUpAfter }) => {
                    calls.push(calls.length + 1);
                    if (calls.length === 1) requestFollowUpAfter(5_000);
                    return calls.length;
                },
            });

            await orchestrator.run(undefined);
            await vi.advanceTimersByTimeAsync(4_999);
            expect(calls).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(calls).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('hands the requested minimum delay to getFollowUpDelayMs so callers can log the effective wait', async () => {
        vi.useFakeTimers();
        try {
            const seen: Array<[number, number]> = [];
            const orchestrator = createSyncOrchestrator<undefined, void>({
                getFollowUpDelayMs: (lastCycleDurationMs, minimumDelayMs) => {
                    seen.push([lastCycleDurationMs, minimumDelayMs]);
                    return 1_000;
                },
                runCycle: async (_arg, { requestFollowUpAfter }) => {
                    if (seen.length === 0) requestFollowUpAfter(229_000);
                },
            });

            await orchestrator.run(undefined);
            expect(seen).toEqual([[expect.any(Number), 229_000]]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('lets a direct manual run replace the delayed background request', async () => {
        vi.useFakeTimers();
        try {
            const calls: Array<string | undefined> = [];
            const orchestrator = createSyncOrchestrator<string | undefined, number>({
                getFollowUpDelayMs: () => 5_000,
                runCycle: async (arg, { requestFollowUpAfter }) => {
                    calls.push(arg);
                    if (calls.length === 1) {
                        requestFollowUpAfter(5_000, 'background');
                    }
                    return calls.length;
                },
            });

            await orchestrator.run('background');
            expect(calls).toHaveLength(1);

            await orchestrator.run('manual');
            expect(calls).toEqual(['background', 'manual']);

            await vi.advanceTimersByTimeAsync(10_000);
            expect(calls).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
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

    it('does not emit an unhandled rejection when a cycle fails, and still drains afterward', async () => {
        const rejections: unknown[] = [];
        const onRejection = (reason: unknown) => rejections.push(reason);
        process.on('unhandledRejection', onRejection);
        try {
            let calls = 0;
            let drainedCount = 0;
            const orchestrator = createSyncOrchestrator<string | undefined, number>({
                runCycle: async () => {
                    calls += 1;
                    if (calls === 1) {
                        throw new Error('cycle failed');
                    }
                    return calls;
                },
                onDrained: () => {
                    drainedCount += 1;
                },
            });

            // (a) run()'s returned promise rejects with the cause.
            await expect(orchestrator.run('first')).rejects.toThrow('cycle failed');

            // Give the unhandled-rejection detector a couple of macrotask turns to fire.
            await new Promise((resolve) => setTimeout(resolve, 0));
            await new Promise((resolve) => setTimeout(resolve, 0));

            // (b) the discarded derived `.finally()` promise did not surface as unhandled.
            expect(rejections).toHaveLength(0);
            expect(drainedCount).toBe(1);

            // (d) drain proceeds after a failure — a later run still succeeds.
            await expect(orchestrator.run('second')).resolves.toBe(2);
        } finally {
            process.removeListener('unhandledRejection', onRejection);
        }
    });

    it('invokes onQueuedRunError when a queued follow-up cycle rejects', async () => {
        let calls = 0;
        const queuedErrors: unknown[] = [];
        const orchestrator = createSyncOrchestrator<string | undefined, number>({
            runCycle: async () => {
                calls += 1;
                if (calls === 1) {
                    // Queue a follow-up while the first cycle is still running.
                    return new Promise<number>((resolve) => {
                        setTimeout(() => resolve(calls), 10);
                    });
                }
                throw new Error('queued cycle failed');
            },
            onQueuedRunError: (error) => queuedErrors.push(error),
        });

        const first = orchestrator.run('first');
        orchestrator.run('second');
        await expect(first).resolves.toBe(1);

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(queuedErrors).toHaveLength(1);
        expect((queuedErrors[0] as Error).message).toBe('queued cycle failed');
    });
});
