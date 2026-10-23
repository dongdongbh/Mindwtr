import { describe, expect, it, vi } from 'vitest';

import {
    UPDATE_REMINDER_RELEASES_API,
    UPDATE_REMINDER_RELEASES_URL,
    buildMobileStartupPromptDescriptors,
    buildUpdateReminderAnnouncement,
    fetchMobileUpdateReminderInfo,
    resolveMobileDonationPromptAllowed,
    resolveMobileUpdateReminderAllowed,
    type MobileStartupPromptInput,
} from './mobile-startup-prompts';
import { LOCAL_USER_PROMPT_STATE_KEY } from './user-prompts';

const reply = (body: unknown, ok = true, status = 200) => vi.fn(async () => ({ ok, status, json: async () => body }));

describe('mobile startup prompt rules', () => {
    it('asks for a donation only in flagged Android and iOS builds outside Expo Go', async () => {
        await expect(resolveMobileDonationPromptAllowed({ platform: 'android', isExpoGo: false, donationPromptEnabled: true })).resolves.toBe(true);
        await expect(resolveMobileDonationPromptAllowed({ platform: 'ios', isExpoGo: false, donationPromptEnabled: true })).resolves.toBe(true);
        await expect(resolveMobileDonationPromptAllowed({ platform: 'android', isExpoGo: false, donationPromptEnabled: false })).resolves.toBe(false);
        await expect(resolveMobileDonationPromptAllowed({ platform: 'android', isExpoGo: true, donationPromptEnabled: true })).resolves.toBe(false);
        await expect(resolveMobileDonationPromptAllowed({ platform: 'web', isExpoGo: false, donationPromptEnabled: true })).resolves.toBe(false);
    });

    it('reminds about updates only on sideloaded Android builds that are not FOSS or Expo Go', async () => {
        const allowed = (overrides: Partial<Parameters<typeof resolveMobileUpdateReminderAllowed>[0]>) => resolveMobileUpdateReminderAllowed({
            platform: 'android', androidInstallerSource: 'sideload', isExpoGo: false, isFossBuild: false, ...overrides,
        });
        await expect(allowed({})).resolves.toBe(true);
        await expect(allowed({ androidInstallerSource: 'play-store' })).resolves.toBe(false);
        await expect(allowed({ androidInstallerSource: 'unknown' })).resolves.toBe(false);
        await expect(allowed({ isFossBuild: true })).resolves.toBe(false);
        await expect(allowed({ isExpoGo: true })).resolves.toBe(false);
        await expect(allowed({ platform: 'ios' })).resolves.toBe(false);
    });

    it('reads the latest GitHub release through the host fetch', async () => {
        const fetcher = reply({ tag_name: ' V1.3.8 ', html_url: ' https://github.com/dongdongbh/Mindwtr/releases/tag/v1.3.8 ', published_at: '2026-10-30T10:00:00Z' });
        await expect(fetchMobileUpdateReminderInfo('1.3.7', fetcher)).resolves.toEqual({
            currentVersion: '1.3.7',
            latestVersion: '1.3.8',
            latestReleasedAt: '2026-10-30T10:00:00Z',
            releaseUrl: 'https://github.com/dongdongbh/Mindwtr/releases/tag/v1.3.8',
            actionLabel: 'Update now',
        });
        expect(fetcher).toHaveBeenCalledWith(UPDATE_REMINDER_RELEASES_API, {
            headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'Mindwtr-App' },
        });
        const stub = reply({ tag_name: 'v1.3.8', html_url: '', published_at: null });
        await expect(fetchMobileUpdateReminderInfo('1.3.7', stub, 'http://127.0.0.1:9/latest')).resolves.toMatchObject({
            latestReleasedAt: null,
            releaseUrl: UPDATE_REMINDER_RELEASES_URL,
        });
        expect(stub).toHaveBeenCalledWith('http://127.0.0.1:9/latest', expect.anything());
    });

    it('refuses a failed reply or a release with no version', async () => {
        await expect(fetchMobileUpdateReminderInfo('1.3.7', reply({}, false, 403))).rejects.toThrow('GitHub API error: 403');
        await expect(fetchMobileUpdateReminderInfo('1.3.7', reply({ tag_name: '  ' }))).rejects.toThrow('GitHub release returned no version');
    });

    it('builds the update reminder from the release', () => {
        expect(buildUpdateReminderAnnouncement({
            currentVersion: '1.3.7', latestVersion: '1.3.8', latestReleasedAt: null, releaseUrl: 'https://example.test/r',
        })).toEqual({
            id: 'update-reminder-1.3.8',
            title: 'Update available',
            body: 'Mindwtr 1.3.8 is available. You are using 1.3.7. Update when you have a minute to keep fixes and improvements current.',
            action: { type: 'url', label: 'View release', url: 'https://example.test/r' },
        });
    });
});

describe('the update reminder in the app language', () => {
    it('builds its title, body and action from the app words', () => {
        const words: Record<string, string> = {
            'updateReminder.title': 'Update verfügbar',
            'updateReminder.body': 'Mindwtr {{latestVersion}} ist verfügbar. Du nutzt {{currentVersion}}.',
            'updateReminder.updateNow': 'Jetzt aktualisieren',
            'updateReminder.viewRelease': 'Release ansehen',
        };
        const resolveText = (key: string, fallback: string) => words[key] ?? fallback;
        const info = { currentVersion: '1.3.7', latestVersion: '1.3.8', latestReleasedAt: null, releaseUrl: 'https://example.test/r' };
        expect(buildUpdateReminderAnnouncement({ ...info, actionLabel: 'Update now' }, resolveText)).toEqual({
            id: 'update-reminder-1.3.8',
            title: 'Update verfügbar',
            body: 'Mindwtr 1.3.8 ist verfügbar. Du nutzt 1.3.7.',
            action: { type: 'url', label: 'Jetzt aktualisieren', url: 'https://example.test/r' },
        });
        expect(buildUpdateReminderAnnouncement(info, resolveText).action?.label).toBe('Release ansehen');
        expect(buildUpdateReminderAnnouncement({ ...info, actionLabel: 'Open Play Store' }, resolveText).action?.label).toBe('Open Play Store');
    });
});

describe('buildMobileStartupPromptDescriptors', () => {
    const memoryStorage = () => {
        const values = new Map<string, string>();
        return {
            values,
            getItem: vi.fn(async (key: string) => values.get(key) ?? null),
            setItem: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
        };
    };
    const build = (overrides: Partial<MobileStartupPromptInput> = {}) => {
        const storage = memoryStorage();
        const input: MobileStartupPromptInput = {
            storage,
            dataReady: true,
            canonicalDataReady: true,
            mobileOnboardingDismissed: false,
            visibleDataCount: 0,
            readSyncBackend: async () => 'off',
            onSyncBackendReadError: vi.fn(),
            updateReminderAllowed: true,
            donationPromptAllowed: true,
            promptStateSnapshot: {},
            onUpdateCheckRecordError: vi.fn(),
            fetchUpdateInfo: async () => ({ currentVersion: '1.3.7', latestVersion: '1.3.8', latestReleasedAt: null, releaseUrl: 'u' }),
            onUpdateReminderInfo: vi.fn(),
            getSupportPrompt: () => undefined,
            ...overrides,
        };
        const byId = Object.fromEntries(buildMobileStartupPromptDescriptors(input).map((descriptor) => [descriptor.id, descriptor]));
        return { input, storage, byId };
    };
    const live = () => new AbortController().signal;

    it('keeps RN precedence and delays: onboarding > announcement > update (15 s present timeout) > donation', () => {
        const { byId } = build();
        expect(Object.values(byId).map(({ id, priority, delayMs, presentTimeoutMs }) => [id, priority, delayMs, presentTimeoutMs])).toEqual([
            ['onboarding', 40, 0, undefined],
            ['announcement', 30, 250, undefined],
            ['update-reminder', 20, 1750, 15000],
            ['donation', 10, 2000, undefined],
        ]);
    });

    it('opens onboarding only for an empty, undismissed library with sync off', async () => {
        expect(build({ visibleDataCount: 1 }).byId.onboarding.isEligible()).toBe(false);
        expect(build({ mobileOnboardingDismissed: true }).byId.onboarding.isEligible()).toBe(false);
        await expect(build().byId.onboarding.present(live())).resolves.toBe(true);
        await expect(build({ readSyncBackend: async () => 'webdav' }).byId.onboarding.present(live())).resolves.toBe(false);
        const failed = build({ readSyncBackend: async () => { throw new Error('read'); } });
        await expect(failed.byId.onboarding.present(live())).resolves.toBe(true);
        expect(failed.input.onSyncBackendReadError).toHaveBeenCalled();
    });

    it('never opens onboarding over a failed load: the store is empty but the library may not be', async () => {
        // RN marks data ready after a failed canonical load too (the error screen); seeding Getting Started there could
        // duplicate it and would dismiss the welcome sheet for good.
        const failed = build({ canonicalDataReady: false });
        expect(failed.byId.onboarding.isEligible()).toBe(false);
        await expect(failed.byId.onboarding.present(live())).resolves.toBe(false);
    });

    it('shows no announcement while none is configured', () => {
        expect(build().byId.announcement.isEligible()).toBe(false);
    });

    it('records the update check only when the reminder is selected, and nothing shown after an abort', async () => {
        const { byId, storage } = build();
        expect(byId['update-reminder'].isEligible()).toBe(true);
        expect(build({ updateReminderAllowed: false }).byId['update-reminder'].isEligible()).toBe(false);
        expect(build({ promptStateSnapshot: null }).byId['update-reminder'].isEligible()).toBe(false);
        byId['update-reminder'].onSelect?.();
        await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledTimes(1));
        expect(JSON.parse(storage.values.get(LOCAL_USER_PROMPT_STATE_KEY) ?? '{}').update.lastCheckedAt).toEqual(expect.any(String));

        const aborted = new AbortController();
        aborted.abort();
        const later = build();
        await expect(later.byId['update-reminder'].present(aborted.signal)).resolves.toBe(false);
        expect(later.storage.setItem).not.toHaveBeenCalled();
        expect(later.input.onUpdateReminderInfo).not.toHaveBeenCalled();
    });

    it('asks for a donation only when allowed and the synced ask is not recent', () => {
        expect(build({ donationPromptAllowed: false }).byId.donation.isEligible()).toBe(false);
        expect(build({ donationPromptAllowed: null }).byId.donation.isEligible()).toBe(false);
        const recent = build({ getSupportPrompt: () => ({ lastShownAt: new Date().toISOString() }) as never });
        expect(recent.byId.donation.isEligible()).toBe(false);
    });
});
