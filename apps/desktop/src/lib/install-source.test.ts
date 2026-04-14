import { describe, expect, it } from 'vitest';
import { normalizeAnalyticsInstallChannel } from './install-source';

describe('normalizeAnalyticsInstallChannel', () => {
    it('maps flatpak installs to flathub for analytics', () => {
        expect(normalizeAnalyticsInstallChannel('flatpak')).toBe('flathub');
        expect(normalizeAnalyticsInstallChannel('flatpak:stable')).toBe('flathub');
        expect(normalizeAnalyticsInstallChannel('flatpak:flathub:stable')).toBe('flathub');
    });

    it('keeps other managed channels stable', () => {
        expect(normalizeAnalyticsInstallChannel('aur')).toBe('aur-source');
        expect(normalizeAnalyticsInstallChannel('aur-bin')).toBe('aur-bin');
        expect(normalizeAnalyticsInstallChannel('aur-source')).toBe('aur-source');
        expect(normalizeAnalyticsInstallChannel('apt')).toBe('apt');
        expect(normalizeAnalyticsInstallChannel('appimage')).toBe('appimage');
        expect(normalizeAnalyticsInstallChannel('portable')).toBe('portable');
    });

    it('normalizes aliases and unknown values', () => {
        expect(normalizeAnalyticsInstallChannel('appstore')).toBe('app-store');
        expect(normalizeAnalyticsInstallChannel('msstore')).toBe('microsoft-store');
        expect(normalizeAnalyticsInstallChannel('')).toBe('unknown');
        expect(normalizeAnalyticsInstallChannel('custom-linux-build')).toBe('unknown');
    });
});
