import { afterEach, describe, expect, it } from 'vitest';
import { getTranslator } from './i18n';
import { consoleLogger, setLogger, type LogPayload } from './logger';
import { createNativeHostContract, type NativeHostResult } from './native-host-contract';
import { flushPendingSave, resetForTests, setStorageAdapter, useTaskStore } from './store';
import type { AppSettings } from './types';
import { generateUUID } from './uuid';

/** Settings › Data's Diagnostics card (RN's SyncDiagnosticsCard and toggleDebugLogging) through the native host contract. */
const value = <T,>(result: NativeHostResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};

let saved: { settings: AppSettings } | null = null;
async function openHost(settings: AppSettings, language = 'en') {
    await flushPendingSave();
    resetForTests();
    let data = { tasks: [], projects: [], sections: [], areas: [], people: [], settings };
    setStorageAdapter({
        getData: async () => JSON.parse(JSON.stringify(data)),
        saveData: async (next) => {
            data = JSON.parse(JSON.stringify(next));
            saved = data;
        },
    });
    useTaskStore.setState({ error: null, persistenceFailure: null, isLoading: false, editLockCount: 0 } as never);
    await useTaskStore.getState().fetchData({ throwOnError: true });
    await flushPendingSave();
    const host = createNativeHostContract();
    value(await host.setLanguage({ storedLanguage: language, systemLocale: 'en-US' }));
    value(await host.activate({ writeSafetyReady: true }));
    return host;
}

const lines: LogPayload[] = [];
const enabledLines = () => lines.filter((line) => line.message === 'Debug logging enabled');

describe('native host contract: Settings › Data', () => {
    afterEach(() => {
        setLogger(consoleLogger);
        lines.length = 0;
        saved = null;
    });

    it('draws RN\'s Diagnostics card: the switch, and Share and Clear only while logging is on', async () => {
        const host = await openHost({});
        const t = getTranslator('en');
        const off = value(host.getDataSettings());
        expect(off.title).toBe(t('settings.data'));
        expect(off.diagnostics).toEqual({
            title: t('settings.diagnostics'),
            analytics: null,
            debugLogging: { label: t('settings.debugLogging'), description: t('settings.debugLoggingDesc'), value: false, edit: { type: 'debugLogging', value: true } },
            shareLog: null,
            clearLog: null,
            toastTitle: t('settings.debugLogging'),
            logMissing: t('settings.logMissing'),
            shareUnavailable: t('settings.shareUnavailable'),
            logCleared: t('settings.logCleared'),
            logClearFailed: 'Could not clear the log file.',
        });
        const menu = value(host.getSettingsMenu());
        expect(menu.groups.flat().find((row) => row.id === 'data')?.enabled).toBe(true);

        const on = value((await openHost({ diagnostics: { loggingEnabled: true } }, 'zh')).getDataSettings());
        const zh = getTranslator('zh');
        expect(on.diagnostics.debugLogging).toMatchObject({ label: zh('settings.debugLogging'), value: true, edit: { type: 'debugLogging', value: false } });
        expect(on.diagnostics.shareLog).toEqual({ label: zh('settings.shareLog'), description: zh('settings.logFile') });
        expect(on.diagnostics.clearLog).toEqual({ label: zh('settings.clearLog') });
        expect(on.diagnostics.logClearFailed).toBe(zh('settings.logClearFailed'));
        expect(on.diagnostics.logClearFailed).not.toBe('settings.logClearFailed');
    });

    it('turns logging on once, keeps the other diagnostics fields, and stamps RN\'s forced line', async () => {
        const host = await openHost({ diagnostics: { loggingEnabled: false, kept: 'yes' } as AppSettings['diagnostics'] });
        setLogger((payload) => { lines.push(payload); });
        const requestId = generateUUID();
        const edit = value(host.getDataSettings()).diagnostics.debugLogging.edit;
        expect(value(await host.setDataSetting({ requestId, edit }))).toEqual({ changed: true, deviceWrites: [] });
        await flushPendingSave();
        expect(saved?.settings.diagnostics).toEqual({ loggingEnabled: true, kept: 'yes' });
        expect(enabledLines()).toEqual([{ level: 'info', message: 'Debug logging enabled', scope: 'diagnostics', force: true }]);
        // The exact retry and a second switch to on write nothing and log nothing.
        expect(value(await host.setDataSetting({ requestId, edit }))).toEqual({ changed: true, deviceWrites: [] });
        expect(value(await host.setDataSetting({ requestId: generateUUID(), edit }))).toEqual({ changed: false, deviceWrites: [] });
        expect(enabledLines()).toHaveLength(1);
        expect(value(host.getDataSettings()).diagnostics.shareLog).not.toBeNull();

        const offEdit = value(host.getDataSettings()).diagnostics.debugLogging.edit;
        expect(offEdit).toEqual({ type: 'debugLogging', value: false });
        expect(value(await host.setDataSetting({ requestId: generateUUID(), edit: offEdit }))).toEqual({ changed: true, deviceWrites: [] });
        await flushPendingSave();
        expect(saved?.settings.diagnostics).toEqual({ loggingEnabled: false, kept: 'yes' });
        expect(enabledLines()).toHaveLength(1);
        expect(value(host.getDataSettings()).diagnostics.clearLog).toBeNull();
    });

    it('refuses anything but a request UUID and the switch\'s edit', async () => {
        const host = await openHost({});
        for (const input of [
            { requestId: 'nope', edit: { type: 'debugLogging', value: true } },
            { requestId: generateUUID(), edit: { type: 'debugLogging', value: 'yes' } },
            { requestId: generateUUID(), edit: { type: 'analytics', value: true } },
            { requestId: generateUUID(), edit: { type: 'debugLogging', value: true, extra: 1 } },
        ]) {
            const result = await host.setDataSetting(input as never);
            expect(result.ok ? null : result.error.code).toBe('INVALID_INPUT');
        }
        expect(useTaskStore.getState().settings.diagnostics?.loggingEnabled).toBeUndefined();
    });
});
