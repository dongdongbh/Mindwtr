import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    getReminderCompletionBlocker,
    REMINDER_COMPLETE_UPDATE,
    resolveNotificationOpenRoute,
    type NotificationOpenRoute,
} from './mobile-notification-open';
import type { Task } from './types';

type Fixture = {
    now: string;
    scenarios: { name: string; tasks: Task[]; payloads: Record<string, unknown>[] }[];
    observations: Record<string, unknown[][][]>;
};

const fixture = JSON.parse(readFileSync(new URL('./notification-open-parity.fixtures.json', import.meta.url), 'utf8')) as Fixture;
const log = (message: string, extra: Record<string, string>) => ['logInfo', `[Local Notifications] ${message}`, extra];


function perform(route: NotificationOpenRoute, tasks: Map<string, Task>, handled: Set<string>): unknown[][] {
    switch (route.type) {
        case 'none':
            return [];
        case 'complete': {
            if (handled.has(route.actionKey)) return [log('Complete action ignored as duplicate', { taskId: route.taskId })];
            handled.add(route.actionKey);
            const blocker = getReminderCompletionBlocker(tasks.get(route.taskId));
            if (blocker) return [log('Complete action dropped', { taskId: route.taskId, reason: blocker })];
            return [log('Complete action applied', { taskId: route.taskId }), ['updateTask', route.taskId, { ...REMINDER_COMPLETE_UPDATE }]];
        }
        case 'review': {
            const { type: _type, ...params } = route;
            return [['push', { pathname: '/review-tab', params }]];
        }
        case 'task':
            return [['setHighlightTask', route.taskId], ['push', { pathname: '/focus', params: { taskId: route.taskId, openToken: route.openToken, taskTab: 'view' } }]];
        case 'project':
            return [['push', { pathname: '/projects-screen', params: { projectId: route.projectId } }]];
        case 'contexts':
            return [['push', { pathname: '/contexts', params: { token: route.token } }]];
        case 'daily-review':
            return [['push', { pathname: '/daily-review', params: { openToken: route.openToken } }]];
        case 'weekly-review':
            return [['push', { pathname: '/weekly-review', params: { openToken: route.openToken } }]];
    }
}

describe('mobile notification open routing', () => {
    it('replays React Native\'s frozen notification opens and actions', () => {
        const now = Date.parse(fixture.now);
        for (const scenario of fixture.scenarios) {
            const tasks = new Map(scenario.tasks.map((task) => [task.id, task]));
            const handled = new Set<string>();
            let sequence = 0;
            const observed = scenario.payloads.map((payload) => perform(
                resolveNotificationOpenRoute(payload, { now: () => now, nextTaskOpenSequence: () => (sequence += 1) }),
                tasks,
                handled,
            ));
            expect({ [scenario.name]: observed }).toEqual({ [scenario.name]: fixture.observations[scenario.name] });
        }
    });

    it('routes each kind of tap', () => {
        const clock = { now: () => 5, nextTaskOpenSequence: () => 1 };
        expect(resolveNotificationOpenRoute({ actionIdentifier: 'Snooze', taskId: 't' }, clock)).toEqual({ type: 'none' });
        expect(resolveNotificationOpenRoute({ actionIdentifier: 'complete', taskId: 't', notificationId: ' task:t ' }, clock))
            .toEqual({ type: 'complete', taskId: 't', actionKey: 'task:t:t:complete' });
        expect(resolveNotificationOpenRoute({ kind: 'project-review', projectId: 'p' }, clock)).toEqual({ type: 'review', openToken: '5', projectId: 'p' });
        expect(resolveNotificationOpenRoute({ taskId: 't' }, clock)).toEqual({ type: 'task', taskId: 't', openToken: 'notification:5:1' });
        expect(resolveNotificationOpenRoute({ notificationId: 'digest:weekly-review' }, clock)).toEqual({ type: 'weekly-review', openToken: 'digest:weekly-review' });
        expect(resolveNotificationOpenRoute(null, clock)).toEqual({ type: 'none' });
    });

    it('completes only a live, actionable task', () => {
        const base = { id: 't', title: 'T', createdAt: '', updatedAt: '' } as Task;
        expect(getReminderCompletionBlocker(undefined)).toBe('task-not-found');
        expect(getReminderCompletionBlocker({ ...base, status: 'next', deletedAt: '2026-09-01T00:00:00.000Z' })).toBe('task-deleted');
        expect(getReminderCompletionBlocker({ ...base, status: 'reference' })).toBe('not-actionable');
        expect(getReminderCompletionBlocker({ ...base, status: 'waiting' })).toBeNull();
    });
});
