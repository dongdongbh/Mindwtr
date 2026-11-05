import { describe, expect, it } from 'vitest';
import {
    buildContextAutomationNotification,
    CONTEXT_AUTOMATION_MAX_STARTS_PER_WINDOW,
    createContextAutomationThrottle,
    defaultContextAutomationText,
} from './context-automation';
import type { Task } from './types';


const task = (id: string, props: Partial<Task> = {}): Task => ({
    id,
    title: `Task ${id}`,
    status: 'next',
    tags: [],
    contexts: ['@home'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...props,
} as Task);

const now = new Date('2026-01-02T12:00:00.000Z');

describe('buildContextAutomationNotification', () => {
    it('posts the next actions for an activated context, with the data that opens it', () => {
        const notification = buildContextAutomationNotification({ action: 'activate', context: '@home' }, {
            tasks: [task('a', { title: 'Water plants' }), task('b', { title: 'Fix sink' }), task('c', { contexts: ['@work'] })],
            projects: [],
            now,
            resolveText: defaultContextAutomationText,
        });
        expect(notification).toEqual({
            title: '2 @home next actions',
            message: '- Fix sink\n- Water plants',
            data: { kind: 'context-automation', context: '@home' },
        });
    });

    it('opens the context as a token when the receiver sent the bare name', () => {


        const notification = buildContextAutomationNotification({ action: 'activate', context: 'home' }, {
            tasks: [task('a', { title: 'Water plants' })],
            projects: [],
            now,
            resolveText: defaultContextAutomationText,
        });
        expect(notification).toMatchObject({ title: '@home next action', data: { kind: 'context-automation', context: '@home' } });
    });

    it('posts nothing for a deactivation or a context without next actions', () => {
        const input = { tasks: [task('a')], projects: [], now, resolveText: defaultContextAutomationText };
        expect(buildContextAutomationNotification({ action: 'deactivate', context: '@home' }, input)).toBeNull();
        expect(buildContextAutomationNotification({ action: 'activate', context: '@work' }, input)).toBeNull();
    });

    it('reads its words through resolveText', () => {
        const notification = buildContextAutomationNotification({ action: 'activate', context: '@home' }, {
            tasks: [task('a', { title: 'Water plants' })],
            projects: [],
            now,
            resolveText: (key, fallback) => (key === 'contextAutomation.oneNextActionTitle' ? 'Acción para {{context}}' : fallback),
        });
        expect(notification?.title).toBe('Acción para @home');
    });
});

describe('createContextAutomationThrottle', () => {
    it('keeps its own dedupe and budget per throttle', () => {
        const first = createContextAutomationThrottle();
        const second = createContextAutomationThrottle();
        const payload = { action: 'activate', context: '@home' } as const;

        expect(first.wasRecentlyHandled(payload, 1_000)).toBe(false);
        expect(first.wasRecentlyHandled(payload, 2_000)).toBe(true);
        expect(second.wasRecentlyHandled(payload, 2_000)).toBe(false);

        for (let index = 0; index < CONTEXT_AUTOMATION_MAX_STARTS_PER_WINDOW; index += 1) {
            second.wasRecentlyHandled({ action: 'activate', context: `@ctx-${index}` }, 3_000 + index);
        }
        expect(second.wasRecentlyHandled({ action: 'activate', context: '@late' }, 4_000)).toBe(true);
    });
});
