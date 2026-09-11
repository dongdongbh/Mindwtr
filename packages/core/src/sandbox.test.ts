import { describe, expect, it, vi } from 'vitest';
import type { AppData, AppSettings } from './types';
import { acquireWorkspaceTransitionLock, createSandboxBootRequest, createSandboxStorage, isWorkspaceTransitionActive, parseSandboxBootRequest, pickSandboxDisplaySettings } from './sandbox';

const fixture = (): AppData => ({
    tasks: [{ id: 'sample', title: 'Fictional task', status: 'inbox', tags: [], contexts: [], createdAt: '2026-09-10T12:00:00Z', updatedAt: '2026-09-10T12:00:00Z' }],
    projects: [], areas: [], sections: [], people: [], settings: {},
});

describe('sandbox workspace isolation', () => {
    it('excludes competing transitions and lets a failed owner release safely for retry', () => {
        expect(isWorkspaceTransitionActive()).toBe(false);
        const release = acquireWorkspaceTransitionLock();
        expect(release).not.toBeNull();
        expect(isWorkspaceTransitionActive()).toBe(true);
        expect(acquireWorkspaceTransitionLock()).toBeNull();
        release!();
        expect(isWorkspaceTransitionActive()).toBe(false);

        const releaseRetry = acquireWorkspaceTransitionLock();
        expect(releaseRetry).not.toBeNull();
        release!();
        expect(isWorkspaceTransitionActive()).toBe(true);
        releaseRetry!();
        expect(isWorkspaceTransitionActive()).toBe(false);
    });

    it('only keeps explicit, validated display preferences', () => {
        const personal = {
            theme: 'dark', language: 'en', dateFormat: 'dmy', calendarSystem: 'gregorian', timeFormat: '24h',
            appearance: { textSize: 'large', density: 'compact', showTaskAge: true, unassignedAreaColor: 'private value' },
            externalCalendars: [{ url: 'https://private.example/calendar', name: 'Private name' }],
            ai: { apiKey: 'secret' }, syncPath: '/private/path', deviceId: 'personal-device',
            gtd: { defaultAreaId: 'personal-area' },
        } as unknown as AppSettings;
        const before = JSON.stringify(personal);
        const display = pickSandboxDisplaySettings(personal);
        expect(display).toMatchObject({ theme: 'dark', language: 'en', dateFormat: 'dmy', appearance: { textSize: 'large', density: 'compact', showTaskAge: true } });
        expect(Object.keys(display).sort()).toEqual(['appearance', 'calendarSystem', 'dateFormat', 'language', 'theme', 'timeFormat']);
        expect(display.appearance).toEqual({ textSize: 'large', density: 'compact', showTaskAge: true });
        expect(JSON.stringify(display)).not.toMatch(/secret|private|personal/i);
        expect(JSON.stringify(personal)).toBe(before);
        expect(pickSandboxDisplaySettings({ theme: 'Private theme', language: 'Private language', appearance: { textSize: 'private' } } as unknown as AppSettings)).toEqual({});
    });

    it('rejects stale, future, malformed and oversized restart handoffs', () => {
        const now = 100_000;
        const raw = createSandboxBootRequest({ language: 'en' }, now);
        expect(parseSandboxBootRequest(raw, now)).toEqual({ language: 'en' });
        expect(parseSandboxBootRequest(raw, now + 60_001)).toBeNull();
        expect(parseSandboxBootRequest(raw, now - 1)).toBeNull();
        for (const invalid of [null, '', 'null', '[]', '{', 'x'.repeat(4097), '{"version":2,"requestedAt":100000,"settings":{}}']) {
            expect(parseSandboxBootRequest(invalid, now)).toBeNull();
        }
        expect(parseSandboxBootRequest('{"version":1,"requestedAt":100000,"settings":{"theme":"dark","syncPath":"secret"}}', now)).toEqual({ theme: 'dark' });
    });

    it('isolates both saved snapshots and reset fixtures from live edits', async () => {
        const seed = fixture();
        const storage = createSandboxStorage(seed);
        seed.tasks[0].title = 'Seed later changed';
        const loaded = await storage.getData();
        expect(loaded.tasks[0].title).toBe('Fictional task');
        loaded.tasks[0].title = 'Edited sample';
        expect((await storage.getData()).tasks[0].title).toBe('Fictional task');
        await storage.saveData(loaded);
        loaded.tasks[0].title = 'Later unsaved edit';
        expect((await storage.getData()).tasks[0].title).toBe('Edited sample');
        const reset = createSandboxStorage(fixture());
        expect((await reset.getData()).tasks[0].title).toBe('Fictional task');
        expect((await storage.getData()).tasks[0].title).toBe('Edited sample');
    });

    it('starts personal and refuses to switch a live runtime storage mode', async () => {
        vi.resetModules();
        const session = await import('./sandbox');
        expect(session.isSandboxMode()).toBe(false);
        session.initializeSandboxRuntime(true);
        session.initializeSandboxRuntime(true);
        expect(session.isSandboxMode()).toBe(true);
        expect(() => session.initializeSandboxRuntime(false)).toThrow('restarting');
        vi.resetModules();
        const restarted = await import('./sandbox');
        restarted.initializeSandboxRuntime(false);
        expect(restarted.isSandboxMode()).toBe(false);
        expect(() => restarted.initializeSandboxRuntime(true)).toThrow('restarting');
    });
});
