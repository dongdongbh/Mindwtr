/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    useStartupPromptQueue,
    type StartupPromptDescriptor,
    type UseStartupPromptQueueOptions,
} from './startup-prompts';

type DescriptorOverrides = Partial<StartupPromptDescriptor> & Pick<StartupPromptDescriptor, 'id' | 'priority'>;

const makeDescriptor = (overrides: DescriptorOverrides): StartupPromptDescriptor => ({
    delayMs: 0,
    isEligible: () => true,
    present: () => true,
    ...overrides,
});

const renderQueue = (options: Partial<UseStartupPromptQueueOptions> & { descriptors: StartupPromptDescriptor[] }) => {
    const props: UseStartupPromptQueueOptions = {
        enabled: true,
        gateOpen: true,
        signals: [],
        ...options,
    };
    return renderHook((next: UseStartupPromptQueueOptions) => useStartupPromptQueue(next), {
        initialProps: props,
    });
};


const flush = async (ms: number) => {
    await act(async () => {
        vi.advanceTimersByTime(ms);
        await Promise.resolve();
        await Promise.resolve();
    });
};

describe('useStartupPromptQueue', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('opens only the highest-priority eligible prompt', async () => {
        const donationPresent = vi.fn(() => true);
        const { result } = renderQueue({
            descriptors: [
                makeDescriptor({ id: 'donation', priority: 10, delayMs: 100, present: donationPresent }),
                makeDescriptor({ id: 'announcement', priority: 30, delayMs: 100 }),
                makeDescriptor({ id: 'update', priority: 20, delayMs: 100 }),
            ],
        });

        await flush(100);

        expect(result.current.openId).toBe('announcement');
        expect(donationPresent).not.toHaveBeenCalled();
    });

    it('never opens more than one prompt at a time', async () => {
        const { result } = renderQueue({
            descriptors: [
                makeDescriptor({ id: 'a', priority: 20, delayMs: 100 }),
                makeDescriptor({ id: 'b', priority: 10, delayMs: 100 }),
            ],
        });

        await flush(100);
        expect(result.current.openId).toBe('a');


        await flush(1000);
        expect(result.current.openId).toBe('a');
    });

    it('opens nothing while the gate is closed, then opens once it opens', async () => {
        const { result, rerender } = renderQueue({
            gateOpen: false,
            descriptors: [makeDescriptor({ id: 'a', priority: 10, delayMs: 100 })],
        });

        await flush(1000);
        expect(result.current.openId).toBeNull();

        rerender({
            enabled: true,
            gateOpen: true,
            signals: [],
            descriptors: [makeDescriptor({ id: 'a', priority: 10, delayMs: 100 })],
        });
        await flush(100);
        expect(result.current.openId).toBe('a');
    });

    it('does not schedule anything while disabled', async () => {
        const present = vi.fn(() => true);
        const { result } = renderQueue({
            enabled: false,
            descriptors: [makeDescriptor({ id: 'a', priority: 10, delayMs: 100, present })],
        });

        await flush(1000);
        expect(result.current.openId).toBeNull();
        expect(present).not.toHaveBeenCalled();
    });

    it('honors the per-prompt delay before opening', async () => {
        const { result } = renderQueue({
            descriptors: [makeDescriptor({ id: 'a', priority: 10, delayMs: 500 })],
        });

        await flush(400);
        expect(result.current.openId).toBeNull();

        await flush(100);
        expect(result.current.openId).toBe('a');
    });

    it('suppresses a prompt for the session after dismissal', async () => {
        const { result } = renderQueue({
            descriptors: [makeDescriptor({ id: 'a', priority: 10, delayMs: 100 })],
        });

        await flush(100);
        expect(result.current.openId).toBe('a');

        act(() => result.current.dismiss('a'));
        expect(result.current.openId).toBeNull();


        await flush(1000);
        expect(result.current.openId).toBeNull();
    });

    it('respects a persistent dismissal expressed through isEligible', async () => {
        const store = new Map<string, string>();
        store.set('dismissed:a', 'yes');
        const { result } = renderQueue({
            descriptors: [
                makeDescriptor({
                    id: 'a',
                    priority: 10,
                    delayMs: 100,
                    isEligible: () => store.get('dismissed:a') !== 'yes',
                }),
            ],
        });

        await flush(1000);
        expect(result.current.openId).toBeNull();
    });

    it('falls through to the next prompt when a higher-priority one declines to open', async () => {
        const { result } = renderQueue({
            descriptors: [
                makeDescriptor({ id: 'update', priority: 20, delayMs: 100, present: () => false }),
                makeDescriptor({ id: 'donation', priority: 10, delayMs: 100 }),
            ],
        });

        await flush(100);
        await flush(100);
        expect(result.current.openId).toBe('donation');
    });

    it('times out a hung present() and falls through to the next prompt', async () => {
        const donationPresent = vi.fn(() => true);
        const { result } = renderQueue({
            descriptors: [
                makeDescriptor({
                    id: 'update',
                    priority: 20,
                    delayMs: 100,
                    presentTimeoutMs: 1000,
                    present: () => new Promise<boolean>(() => {

                    }),
                }),
                makeDescriptor({ id: 'donation', priority: 10, delayMs: 100, present: donationPresent }),
            ],
        });

        await flush(100);
        expect(result.current.openId).toBeNull();

        await flush(1000);
        await flush(100);
        expect(result.current.openId).toBe('donation');
        expect(donationPresent).toHaveBeenCalledTimes(1);
    });

    it('aborts a timed-out present() so late work cannot commit side effects', async () => {
        let resolvePresent: (() => void) | undefined;
        let presentationSignal: AbortSignal | undefined;
        const lateSideEffect = vi.fn();
        const { result } = renderQueue({
            descriptors: [
                makeDescriptor({
                    id: 'update',
                    priority: 20,
                    delayMs: 100,
                    presentTimeoutMs: 1000,
                    present: async (signal) => {
                        presentationSignal = signal;
                        await new Promise<void>((resolve) => {
                            resolvePresent = resolve;
                        });
                        if (signal.aborted) return false;
                        lateSideEffect();
                        return true;
                    },
                }),
                makeDescriptor({ id: 'donation', priority: 10, delayMs: 100 }),
            ],
        });

        await flush(100);
        expect(presentationSignal?.aborted).toBe(false);

        await flush(1000);
        expect(presentationSignal?.aborted).toBe(true);
        await flush(100);
        expect(result.current.openId).toBe('donation');

        await act(async () => {
            resolvePresent?.();
            await Promise.resolve();
        });
        expect(lateSideEffect).not.toHaveBeenCalled();
        expect(result.current.openId).toBe('donation');
    });

    it('does not time out other descriptors that omit presentTimeoutMs', async () => {
        let resolvePresent: ((value: boolean) => void) | undefined;
        const { result } = renderQueue({
            descriptors: [
                makeDescriptor({
                    id: 'slow',
                    priority: 10,
                    delayMs: 100,
                    present: () => new Promise<boolean>((resolve) => {
                        resolvePresent = resolve;
                    }),
                }),
            ],
        });

        await flush(100);
        await flush(5000);
        expect(result.current.openId).toBeNull();

        await act(async () => {
            resolvePresent?.(true);
            await Promise.resolve();
        });
        expect(result.current.openId).toBe('slow');
    });

    it('treats a throwing isEligible as ineligible and retires it', async () => {
        const onLog = vi.fn();
        const { result } = renderQueue({
            onLog,
            descriptors: [
                makeDescriptor({
                    id: 'broken',
                    priority: 20,
                    delayMs: 100,
                    isEligible: () => {
                        throw new Error('boom');
                    },
                }),
                makeDescriptor({ id: 'donation', priority: 10, delayMs: 100 }),
            ],
        });

        await flush(100);
        expect(result.current.openId).toBe('donation');
        expect(onLog).toHaveBeenCalledWith(expect.any(Error), { id: 'broken', phase: 'eligible' });
    });

    it('force-opens a prompt regardless of gate or eligibility', async () => {
        const { result } = renderQueue({
            gateOpen: false,
            descriptors: [makeDescriptor({ id: 'a', priority: 10, isEligible: () => false })],
        });

        act(() => result.current.forceOpen('a'));
        expect(result.current.openId).toBe('a');

        act(() => result.current.closeAll());
        expect(result.current.openId).toBeNull();
    });


    it('does not run onSelect for a prompt that loses selection', async () => {
        const recordUpdateCheck = vi.fn();
        const { result } = renderQueue({
            descriptors: [
                makeDescriptor({
                    id: 'update-reminder',
                    priority: 20,
                    delayMs: 1750,
                    isEligible: () => false,
                    onSelect: recordUpdateCheck,
                }),
                makeDescriptor({ id: 'donation', priority: 10, delayMs: 2000 }),
            ],
        });

        await flush(2000);
        expect(result.current.openId).toBe('donation');
        expect(recordUpdateCheck).not.toHaveBeenCalled();
    });

    it('runs onSelect exactly once, when the prompt wins selection', async () => {
        const recordUpdateCheck = vi.fn();
        const donationPresent = vi.fn(() => true);
        const { result } = renderQueue({
            descriptors: [
                makeDescriptor({
                    id: 'update-reminder',
                    priority: 20,
                    delayMs: 1750,
                    onSelect: recordUpdateCheck,
                    present: () => false,
                }),
                makeDescriptor({ id: 'donation', priority: 10, delayMs: 2000, present: donationPresent }),
            ],
        });


        expect(recordUpdateCheck).toHaveBeenCalledTimes(1);
        expect(donationPresent).not.toHaveBeenCalled();

        await flush(1750);
        await flush(2000);
        expect(result.current.openId).toBe('donation');
        expect(recordUpdateCheck).toHaveBeenCalledTimes(1);
    });
});
