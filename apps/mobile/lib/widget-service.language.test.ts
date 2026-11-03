import { loadTranslations, type AppData } from '@mindwtr/core';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { resetMobileWidgetRenderCache, updateMobileWidgetFromData } from './widget-service';

const mocks = vi.hoisted(() => ({ setPayload: vi.fn(), storedLanguage: null as string | null }));

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { version: '1.0.0' } } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: async (key: string) => (key === 'mindwtr-language' ? mocks.storedLanguage : null),
        setItem: async () => undefined,
    },
}));

vi.mock('@mindwtr/core', async (importOriginal) => ({
    ...await importOriginal<typeof import('@mindwtr/core')>(),
    getSystemDefaultLanguage: () => 'es',
}));
vi.mock('../modules/android-widget', () => ({
    getWidgetListSelections: () => [],
    isSupported: () => true,
    setPayload: mocks.setPayload,
    updateWidgets: () => undefined,
}));
vi.mock('react-native-widgetkit', () => ({}));
vi.mock('./app-log', () => ({ logError: vi.fn(), logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock('./system-color-scheme', () => ({ getSystemColorSchemeForWidget: () => 'light' }));

const data: AppData = { tasks: [], projects: [], sections: [], areas: [], settings: {} };

describe('widget language', () => {
    beforeAll(async () => {
        await loadTranslations('es');
    });

    it('publishes in the language the app shows when none was ever chosen', async () => {
        mocks.storedLanguage = null;
        resetMobileWidgetRenderCache();
        await updateMobileWidgetFromData(data);
        const payload = JSON.parse(mocks.setPayload.mock.calls.at(-1)![0]);
        expect(payload.inboxLabel).toBe('Bandeja de entrada');
        expect(payload.headerTitle).toBe('Hoy');
    });

    it('keeps a stored language ahead of the device language', async () => {
        mocks.storedLanguage = 'en';
        resetMobileWidgetRenderCache();
        await updateMobileWidgetFromData(data);
        expect(JSON.parse(mocks.setPayload.mock.calls.at(-1)![0]).inboxLabel).toBe('Inbox');
    });
});
