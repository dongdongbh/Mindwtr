import { describe, expect, it, vi } from 'vitest';

import {
    buildTaskFromEmailMessage,
    createEmailCaptureController,
    isTerminalEmailCaptureError,
    toEmailCaptureError,
    type EmailCaptureConfig,
    type EmailCaptureMessage,
    type EmailCapturePollResult,
    type EmailCaptureStatus,
} from './email-capture';

const message = (overrides: Partial<EmailCaptureMessage> = {}): EmailCaptureMessage => ({
    uid: 11,
    messageId: 'id-11@example.com',
    subject: 'Renew passport',
    from: 'Jane Doe <jane@example.com>',
    receivedAt: '2026-07-14T08:30:00Z',
    bodyText: 'Bring the old passport.',
    ...overrides,
});

const pollResult = (overrides: Partial<EmailCapturePollResult> = {}): EmailCapturePollResult => ({
    uidValidity: 7,
    messages: [message()],
    maxFetchedUid: 11,
    hasMore: false,
    ...overrides,
});

const enabledConfig = (): EmailCaptureConfig => ({
    enabled: true,
    host: 'imap.example.com',
    port: 993,
    username: 'user@example.com',
    folder: 'Mindwtr',
    hasPassword: true,
});

type ControllerOverrides = Partial<Parameters<typeof createEmailCaptureController>[0]>;

const createController = (overrides: ControllerOverrides = {}) => {
    const calls: string[] = [];
    const statuses: EmailCaptureStatus[] = [];
    const scheduled: number[] = [];
    const deps = {
        getConfig: vi.fn(async () => enabledConfig()),
        poll: vi.fn(async () => pollResult()),
        commit: vi.fn(async () => {
            calls.push('commit');
        }),
        addTasks: vi.fn(async () => {
            calls.push('addTasks');
            return { success: true };
        }),
        flushPendingSave: vi.fn(async () => {
            calls.push('flush');
        }),
        reportError: vi.fn(),
        onStatusChange: (status: EmailCaptureStatus) => statuses.push(status),
        setTimer: ((_handler: () => void, delay: number) => {
            scheduled.push(delay);
            return 0 as unknown as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout,
        clearTimer: (() => { }) as typeof clearTimeout,
        ...overrides,
    };
    const controller = createEmailCaptureController(deps);
    return { controller, deps, calls, statuses, scheduled };
};

describe('buildTaskFromEmailMessage', () => {
    it('maps subject to title and sender plus body to description', () => {
        const result = buildTaskFromEmailMessage(message());
        expect(result.title).toBe('Renew passport');
        expect(result.description).toBe('From: Jane Doe <jane@example.com>\n\nBring the old passport.');
    });

    it('falls back to the first body line when the subject is empty', () => {
        const result = buildTaskFromEmailMessage(message({
            subject: '  ',
            bodyText: '\n  Call the embassy about visa timing.\nSecond line.',
        }));
        expect(result.title).toBe('Call the embassy about visa timing.');
    });

    it('truncates very long body-derived titles', () => {
        const longLine = 'a'.repeat(140);
        const result = buildTaskFromEmailMessage(message({ subject: '', bodyText: longLine }));
        expect(result.title).toHaveLength(101);
        expect(result.title.endsWith('…')).toBe(true);
    });

    it('keeps a usable title when subject and body are empty', () => {
        const noContent = buildTaskFromEmailMessage(message({ subject: '', bodyText: '', from: '' }));
        expect(noContent.title).toBe('Email');
        expect(noContent.description).toBeUndefined();

        const fromOnly = buildTaskFromEmailMessage(message({ subject: '', bodyText: '' }));
        expect(fromOnly.title).toBe('Jane Doe <jane@example.com>');
    });
});

describe('toEmailCaptureError', () => {
    it('preserves structured backend errors and classifies terminal kinds', () => {
        const auth = toEmailCaptureError({ kind: 'auth', message: 'Login failed' });
        expect(auth).toEqual({ kind: 'auth', message: 'Login failed' });
        expect(isTerminalEmailCaptureError(auth)).toBe(true);
        expect(isTerminalEmailCaptureError({ kind: 'network', message: 'timeout' })).toBe(false);
    });

    it('normalizes unknown error shapes', () => {
        expect(toEmailCaptureError(new Error('boom'))).toEqual({ kind: 'other', message: 'boom' });
        expect(toEmailCaptureError('plain')).toEqual({ kind: 'other', message: 'plain' });
        expect(toEmailCaptureError({ kind: 'weird', message: 'm' })).toEqual({ kind: 'other', message: 'm' });
    });
});

describe('createEmailCaptureController', () => {
    it('adds inbox tasks, flushes persistence, then commits the watermark', async () => {
        const { controller, deps, calls } = createController();
        await controller.pollNow();

        expect(deps.addTasks).toHaveBeenCalledWith([
            {
                title: 'Renew passport',
                initialProps: {
                    status: 'inbox',
                    description: 'From: Jane Doe <jane@example.com>\n\nBring the old passport.',
                },
                captureId: expect.any(String),
            },
        ]);
        expect(calls).toEqual(['addTasks', 'flush', 'commit']);
        expect(deps.commit).toHaveBeenCalledWith({
            uidValidity: 7,
            lastSeenUid: 11,
            messageIds: ['id-11@example.com'],
        });
    });


    const capturedItems = (addTasks: unknown): Array<Record<string, unknown>> =>
        (addTasks as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Array<Record<string, unknown>>;

    const capturedIds = (addTasks: unknown): Array<unknown> =>
        capturedItems(addTasks).map((item) => item.captureId);


    it('passes a stable capture id derived from the Message-ID', async () => {
        const first = createController();
        await first.controller.pollNow();
        const second = createController();
        await second.controller.pollNow();

        const [firstId] = capturedIds(first.deps.addTasks);
        const [secondId] = capturedIds(second.deps.addTasks);
        expect(firstId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
        expect(secondId).toBe(firstId);
    });

    it('gives different messages different capture ids', async () => {
        const { controller, deps } = createController({
            poll: vi.fn(async () => pollResult({
                messages: [message(), message({ uid: 12, messageId: 'id-12@example.com' })],
                maxFetchedUid: 12,
            })),
        });
        await controller.pollNow();

        const [firstId, secondId] = capturedIds(deps.addTasks);
        expect(firstId).toBeDefined();
        expect(secondId).toBeDefined();
        expect(secondId).not.toBe(firstId);
    });

    it('uses no capture id for the uid fallback Message-ID', async () => {
        const { controller, deps } = createController({
            poll: vi.fn(async () => pollResult({ messages: [message({ messageId: 'uid:7:11' })] })),
        });
        await controller.pollNow();

        const items = capturedItems(deps.addTasks);
        expect(items[0]).not.toHaveProperty('captureId');
    });

    it('still commits the watermark when every message was already seen', async () => {
        const { controller, deps } = createController({
            poll: vi.fn(async () => pollResult({ messages: [], maxFetchedUid: 42 })),
        });
        await controller.pollNow();

        expect(deps.addTasks).not.toHaveBeenCalled();
        expect(deps.commit).toHaveBeenCalledWith({ uidValidity: 7, lastSeenUid: 42, messageIds: [] });
    });

    it('drains a backlog across bounded rounds in one cycle', async () => {
        const poll = vi.fn()
            .mockResolvedValueOnce(pollResult({ hasMore: true }))
            .mockResolvedValueOnce(pollResult({
                messages: [message({ uid: 12, messageId: 'id-12@example.com' })],
                maxFetchedUid: 12,
                hasMore: false,
            }));
        const { controller, deps } = createController({ poll });
        await controller.pollNow();

        expect(poll).toHaveBeenCalledTimes(2);
        expect(deps.addTasks).toHaveBeenCalledTimes(2);
        expect(deps.commit).toHaveBeenCalledTimes(2);
    });

    it('skips polling while capture is disabled', async () => {
        const poll = vi.fn();
        const { controller } = createController({
            poll,
            getConfig: vi.fn(async () => ({ ...enabledConfig(), enabled: false })),
        });
        await controller.pollNow();
        expect(poll).not.toHaveBeenCalled();
    });

    it('stops after an auth failure until the config changes', async () => {
        const poll = vi.fn().mockRejectedValue({ kind: 'auth', message: 'Login failed' });
        const onTerminalError = vi.fn();
        const { controller, scheduled, statuses } = createController({ poll, onTerminalError });

        await controller.pollNow();
        expect(statuses[statuses.length - 1]?.terminal).toBe(true);
        expect(onTerminalError).toHaveBeenCalledWith({ kind: 'auth', message: 'Login failed' });
        expect(scheduled).toEqual([]);

        await controller.pollNow();
        expect(poll).toHaveBeenCalledTimes(1);

        controller.handleConfigChanged();
        expect(statuses[statuses.length - 1]?.terminal).toBe(false);
        expect(scheduled).toEqual([1_000]);
    });

    it('keeps polling on transient network failures', async () => {
        const poll = vi.fn().mockRejectedValue({ kind: 'network', message: 'timeout' });
        const { controller, scheduled, statuses } = createController({ poll, intervalMs: 60_000 });

        await controller.pollNow();
        expect(statuses[statuses.length - 1]?.terminal).toBe(false);
        expect(statuses[statuses.length - 1]?.lastError).toEqual({ kind: 'network', message: 'timeout' });
        expect(scheduled).toEqual([60_000]);
    });

    it('does not advance the watermark when adding tasks fails', async () => {
        const { controller, deps } = createController({
            addTasks: vi.fn(async () => ({ success: false, error: 'storage full' })),
        });
        await controller.pollNow();
        expect(deps.commit).not.toHaveBeenCalled();
    });
});
