import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runStartupPromptsOnce } from './startup-prompt-run';
import type { StartupPromptDescriptor } from './startup-prompts';

type DescriptorOverrides = Partial<StartupPromptDescriptor> & Pick<StartupPromptDescriptor, 'id' | 'priority'>;

const makeDescriptor = (overrides: DescriptorOverrides): StartupPromptDescriptor => ({
    delayMs: 0,
    isEligible: () => true,
    present: () => true,
    ...overrides,
});

// The native hosts' run of the queue (all inputs known at the start): the same rules as useStartupPromptQueue's tests.
describe('runStartupPromptsOnce', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('opens only the highest-priority eligible prompt', async () => {
        const low = vi.fn(() => true);
        const run = runStartupPromptsOnce([
            makeDescriptor({ id: 'donation', priority: 10, present: low }),
            makeDescriptor({ id: 'onboarding', priority: 40 }),
            makeDescriptor({ id: 'announcement', priority: 30, isEligible: () => false }),
        ]);
        await vi.runAllTimersAsync();
        await expect(run).resolves.toBe('onboarding');
        expect(low).not.toHaveBeenCalled();
    });

    it('honors the per-prompt delay before presenting', async () => {
        const present = vi.fn(() => true);
        const run = runStartupPromptsOnce([makeDescriptor({ id: 'donation', priority: 10, delayMs: 2000, present })]);
        await vi.advanceTimersByTimeAsync(1999);
        expect(present).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await expect(run).resolves.toBe('donation');
    });

    it('falls through to the next prompt when a higher-priority one declines to open', async () => {
        const run = runStartupPromptsOnce([
            makeDescriptor({ id: 'update', priority: 20, present: () => false }),
            makeDescriptor({ id: 'donation', priority: 10 }),
        ]);
        await vi.runAllTimersAsync();
        await expect(run).resolves.toBe('donation');
    });

    it('times out a hung present(), aborts it, and falls through to the next prompt', async () => {
        let signal: AbortSignal | undefined;
        const run = runStartupPromptsOnce([
            makeDescriptor({ id: 'update', priority: 20, presentTimeoutMs: 15_000, present: (next) => { signal = next; return new Promise<boolean>(() => undefined); } }),
            makeDescriptor({ id: 'donation', priority: 10, delayMs: 2000 }),
        ]);
        await vi.advanceTimersByTimeAsync(14_999);
        expect(signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(signal?.aborted).toBe(true);
        await vi.runAllTimersAsync();
        await expect(run).resolves.toBe('donation');
    });

    it('retires a prompt whose isEligible, onSelect or present throws, logs it, and tries the next', async () => {
        const onLog = vi.fn();
        const onError = vi.fn();
        const run = runStartupPromptsOnce([
            makeDescriptor({ id: 'onboarding', priority: 40, isEligible: () => { throw new Error('read'); }, onError }),
            makeDescriptor({ id: 'announcement', priority: 30, onSelect: () => { throw new Error('select'); } }),
            makeDescriptor({ id: 'update', priority: 20, present: () => { throw new Error('present'); } }),
            makeDescriptor({ id: 'donation', priority: 10 }),
        ], { onLog });
        await vi.runAllTimersAsync();
        await expect(run).resolves.toBe('donation');
        expect(onLog.mock.calls.map(([, context]) => context)).toEqual([
            { id: 'onboarding', phase: 'eligible' },
            { id: 'announcement', phase: 'select' },
            { id: 'update', phase: 'present' },
        ]);
        expect(onError).toHaveBeenCalledWith(expect.any(Error), 'eligible');
    });

    it('runs onSelect only for the prompt that wins selection, exactly once', async () => {
        const updateSelect = vi.fn();
        const donationSelect = vi.fn();
        const run = runStartupPromptsOnce([
            makeDescriptor({ id: 'onboarding', priority: 40 }),
            makeDescriptor({ id: 'update', priority: 20, onSelect: updateSelect }),
            makeDescriptor({ id: 'donation', priority: 10, onSelect: donationSelect, present: () => false }),
        ]);
        await vi.runAllTimersAsync();
        await expect(run).resolves.toBe('onboarding');
        expect(updateSelect).not.toHaveBeenCalled();
        expect(donationSelect).not.toHaveBeenCalled();

        const won = runStartupPromptsOnce([makeDescriptor({ id: 'update', priority: 20, onSelect: updateSelect })]);
        await vi.runAllTimersAsync();
        await expect(won).resolves.toBe('update');
        expect(updateSelect).toHaveBeenCalledTimes(1);
    });

    it('goes on to the next prompt after the open one is dismissed, as the hook does', async () => {
        const descriptors = [
            makeDescriptor({ id: 'update', priority: 20 }),
            makeDescriptor({ id: 'donation', priority: 10, delayMs: 2000 }),
        ];
        const first = runStartupPromptsOnce(descriptors);
        await vi.runAllTimersAsync();
        await expect(first).resolves.toBe('update');
        const next = runStartupPromptsOnce(descriptors, { retired: ['update'] });
        await vi.runAllTimersAsync();
        await expect(next).resolves.toBe('donation');
    });

    it('stops when its signal aborts, aborting the prompt being presented', async () => {
        let presentSignal: AbortSignal | undefined;
        const stop = new AbortController();
        const run = runStartupPromptsOnce([
            makeDescriptor({ id: 'update', priority: 20, present: (next) => { presentSignal = next; return new Promise<boolean>(() => undefined); } }),
            makeDescriptor({ id: 'donation', priority: 10 }),
        ], { signal: stop.signal });
        await vi.advanceTimersByTimeAsync(0);
        stop.abort();
        await expect(run).resolves.toBeNull();
        expect(presentSignal?.aborted).toBe(true);
    });

    it('resolves to null when no prompt opens', async () => {
        const run = runStartupPromptsOnce([
            makeDescriptor({ id: 'announcement', priority: 30, isEligible: () => false }),
            makeDescriptor({ id: 'donation', priority: 10, present: () => false }),
        ]);
        await vi.runAllTimersAsync();
        await expect(run).resolves.toBeNull();
    });
});
