import { describe, expect, it } from 'vitest';
import { getStatusColor, type TaskStatus } from '@mindwtr/core';
import { resolveStatusColors } from './use-status-colors';

const STATUSES: TaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'];

describe('resolveStatusColors', () => {
    it('keeps the core light palette for light default themes and missing context', () => {
        for (const status of STATUSES) {
            expect(resolveStatusColors(null)[status]).toEqual(getStatusColor(status));
            expect(resolveStatusColors({ themePreset: 'default', isDark: false })[status]).toEqual(getStatusColor(status));
        }
    });

    it('uses lighter hues on dark default and oled themes', () => {
        const dark = resolveStatusColors({ themePreset: 'default', isDark: true });
        expect(dark.next.text).toBe('#60A5FA');
        expect(dark.next.text).not.toBe(getStatusColor('next').text);
        expect(resolveStatusColors({ themePreset: 'oled', isDark: true })).toEqual(dark);
    });

    it('uses Nord frost/aurora hues on the nord preset', () => {
        const nord = resolveStatusColors({ themePreset: 'nord', isDark: true });
        expect(nord.next.text).toBe('#88C0D0');
        expect(nord.someday.text).toBe('#B48EAD');
        expect(nord.done.text).toBe('#A3BE8C');
    });

    it('uses each new preset theme own accents rather than the generic dark palette', () => {
        const dark = resolveStatusColors({ themePreset: 'default', isDark: true });

        const catppuccin = resolveStatusColors({ themePreset: 'catppuccin-macchiato', isDark: true });
        expect(catppuccin.next.text).toBe('#8aadf4');
        expect(catppuccin.someday.text).toBe('#c6a0f6');
        expect(catppuccin.done.text).toBe('#a6da95');
        expect(catppuccin).not.toEqual(dark);

        const dracula = resolveStatusColors({ themePreset: 'dracula', isDark: true });
        expect(dracula.next.text).toBe('#bd93f9');
        expect(dracula.reference.text).toBe('#8be9fd');
        expect(dracula.done.text).toBe('#50fa7b');
        expect(dracula).not.toEqual(dark);
    });

    it('stays monochrome on eink and earthy on sepia', () => {
        const eink = resolveStatusColors({ themePreset: 'eink', isDark: false });
        for (const status of STATUSES) expect(eink[status].text).toBe('#000000');
        expect(resolveStatusColors({ themePreset: 'sepia', isDark: false }).next.text).toBe('#509550');
    });

    it('provides bg, text, and border for every status in every palette', () => {
        const themes = [
            { themePreset: 'default', isDark: true },
            { themePreset: 'nord', isDark: true },
            { themePreset: 'sepia', isDark: false },
            { themePreset: 'eink', isDark: false },
            { themePreset: 'oled', isDark: true },
            { themePreset: 'catppuccin-macchiato', isDark: true },
            { themePreset: 'dracula', isDark: true },
            { themePreset: 'gruvbox-light', isDark: false },
            { themePreset: 'gruvbox-dark', isDark: true },
        ] as const;
        for (const theme of themes) {
            const palette = resolveStatusColors(theme);
            for (const status of STATUSES) {
                expect(palette[status].bg).toBeTruthy();
                expect(palette[status].text).toBeTruthy();
                expect(palette[status].border).toBeTruthy();
            }
        }
    });
});
