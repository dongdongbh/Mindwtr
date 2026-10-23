import { describe, expect, it, vi } from 'vitest';

import {
    UPDATE_REMINDER_RELEASES_API,
    UPDATE_REMINDER_RELEASES_URL,
    buildUpdateReminderAnnouncement,
    fetchMobileUpdateReminderInfo,
    resolveMobileDonationPromptAllowed,
    resolveMobileUpdateReminderAllowed,
} from './mobile-startup-prompts';

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
