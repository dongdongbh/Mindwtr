import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ sandbox: false }));
const personalValues = vi.hoisted(() => new Map<string, string>());
const asyncStorage = vi.hoisted(() => ({
    getItem: vi.fn(async (key: string) => personalValues.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { personalValues.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { personalValues.delete(key); }),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }));
vi.mock('@mindwtr/core', () => ({
    isSandboxMode: () => runtime.sandbox,
    LANGUAGE_STORAGE_KEY: 'mindwtr-language',
}));

describe('mobile onboarding hint persistence', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        runtime.sandbox = false;
        personalValues.clear();
        asyncStorage.getItem.mockReset().mockImplementation(async (key: string) => personalValues.get(key) ?? null);
        asyncStorage.setItem.mockReset().mockImplementation(async (key: string, value: string) => {
            personalValues.set(key, value);
        });
        asyncStorage.removeItem.mockReset().mockImplementation(async (key: string) => {
            personalValues.delete(key);
        });
    });

    it('retains dismissal in-session even when storage is unavailable', async () => {
        asyncStorage.setItem.mockRejectedValueOnce(new Error('unavailable'));
        asyncStorage.getItem.mockRejectedValue(new Error('unavailable'));
        const { dismissMobileHint, isMobileHintDismissed } = await import('./onboarding-hints');

        await dismissMobileHint('inbox-project');

        expect(await isMobileHintDismissed('inbox-project')).toBe(true);
        expect(await isMobileHintDismissed('focus')).toBe(false);
    });

    it('does not let a pending read undo an explicit dismissal', async () => {
        let resolve!: (value: string | null) => void;
        asyncStorage.getItem.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
        const { dismissMobileHint, isMobileHintDismissed } = await import('./onboarding-hints');

        const reading = isMobileHintDismissed('focus');
        await dismissMobileHint('focus');
        resolve(null);

        expect(await reading).toBe(true);
        expect(AsyncStorage.setItem).toHaveBeenCalledWith('mindwtr:mobile:onboarding-hint:v1:focus', 'dismissed');
    });

    it('keeps sandbox hint reads and dismissals out of personal storage', async () => {
        personalValues.set('mindwtr:mobile:onboarding-hint:v1:inbox-project', 'dismissed');
        runtime.sandbox = true;
        const sandboxHints = await import('./onboarding-hints');

        expect(await sandboxHints.isMobileHintDismissed('inbox-project')).toBe(false);
        await sandboxHints.dismissMobileHint('focus');
        expect(await sandboxHints.isMobileHintDismissed('focus')).toBe(true);
        expect(asyncStorage.getItem).not.toHaveBeenCalled();
        expect(asyncStorage.setItem).not.toHaveBeenCalled();
        expect(personalValues.get('mindwtr:mobile:onboarding-hint:v1:inbox-project')).toBe('dismissed');

        runtime.sandbox = false;
        vi.resetModules();
        const personalHints = await import('./onboarding-hints');
        expect(await personalHints.isMobileHintDismissed('inbox-project')).toBe(true);
        expect(await personalHints.isMobileHintDismissed('focus')).toBe(false);
        expect(personalValues.has('mindwtr:mobile:onboarding-hint:v1:focus')).toBe(false);
    });
});
