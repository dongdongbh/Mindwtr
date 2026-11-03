import { describe, expect, it } from 'vitest';

import {
    getDesktopUpdateTarget,
    isAutoUpdateCheckAllowed,
    isDesktopUpdateReminderAllowed,
    isUpdateReminderVersionTrusted,
} from './desktop-update-targets';
import {
    AUR_BIN_PACKAGE_URL,
    CHOCOLATEY_PACKAGE_URL,
    GITHUB_RELEASES_URL,
    HOMEBREW_CASK_URL,
    MS_STORE_UPDATES_URL,
    WINGET_PACKAGE_URL,
} from './update-service';

describe('desktop update targets', () => {
    it('allows automatic update reminders for user-driven install channels', () => {
        for (const source of [
            'direct',
            'portable',
            'github-release',
            'microsoft-store',
            'winget',
            'chocolatey',
            'homebrew',
            'aur',
            'aur-bin',
            'aur-source',
            'appimage',
            'apt',
            'rpm',
        ] as const) {
            expect(isDesktopUpdateReminderAllowed(source)).toBe(true);
        }
    });

    it('stays quiet on channels that update themselves or have no canonical feed', () => {
        for (const source of ['flatpak', 'snap', 'mac-app-store', 'scoop', 'unknown'] as const) {
            expect(isDesktopUpdateReminderAllowed(source)).toBe(false);
        }
        expect(isDesktopUpdateReminderAllowed(null)).toBe(false);
    });

    it('blocks unsolicited background checks for scoop installs and unresolved sources', () => {
        expect(isAutoUpdateCheckAllowed('scoop')).toBe(false);
        expect(isAutoUpdateCheckAllowed('direct')).toBe(true);
        expect(isAutoUpdateCheckAllowed('winget')).toBe(true);
        expect(isAutoUpdateCheckAllowed('flatpak')).toBe(true);
        expect(isAutoUpdateCheckAllowed('unknown')).toBe(true);


        expect(isAutoUpdateCheckAllowed(null)).toBe(false);
        expect(isAutoUpdateCheckAllowed(undefined)).toBe(false);
    });

    it('routes Microsoft Store update reminders to the Store updates page', () => {
        expect(getDesktopUpdateTarget('microsoft-store')).toEqual({
            label: 'Update in Microsoft Store',
            url: MS_STORE_UPDATES_URL,
        });
    });

    it('routes package-manager reminders to their own channel', () => {
        expect(getDesktopUpdateTarget('winget').url).toBe(WINGET_PACKAGE_URL);
        expect(getDesktopUpdateTarget('homebrew').url).toBe(HOMEBREW_CASK_URL);
        expect(getDesktopUpdateTarget('aur-bin').url).toBe(AUR_BIN_PACKAGE_URL);
        expect(getDesktopUpdateTarget('chocolatey').url).toBe(CHOCOLATEY_PACKAGE_URL);
        expect(getDesktopUpdateTarget('scoop').url).toBe(GITHUB_RELEASES_URL);
    });

    it('only trusts channel-pinned reminders when the channel reported the version', () => {
        expect(isUpdateReminderVersionTrusted('winget', 'winget')).toBe(true);
        expect(isUpdateReminderVersionTrusted('winget', 'github-release')).toBe(false);
        expect(isUpdateReminderVersionTrusted('homebrew', 'github-release')).toBe(false);
        expect(isUpdateReminderVersionTrusted('chocolatey', 'chocolatey')).toBe(true);
        expect(isUpdateReminderVersionTrusted('chocolatey', 'github-release')).toBe(false);
        expect(isUpdateReminderVersionTrusted('aur-source', 'aur')).toBe(true);

        expect(isUpdateReminderVersionTrusted('direct', 'github-release')).toBe(true);
    });
});
