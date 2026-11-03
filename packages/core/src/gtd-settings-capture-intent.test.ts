import { afterEach, describe, expect, it } from 'vitest';
import { buildGtdSettingsModel } from './gtd-settings-model';
import { getTranslator } from './i18n';
import { openScreenHost, value } from './screen-parity.replay';
import { flushPendingSave, resetForTests } from './store';


const WORDS = {
    label: 'Automation capture',
    description: 'Allow trusted automation apps with your token to queue text to Inbox. Captures appear the next time Mindwtr opens.',
    token: { label: 'Capture token', copyLabel: 'Copy token' },
    messages: {
        copied: 'Capture token copied.',
        copyFailed: "Couldn't copy the capture token.",
        loadFailed: "Couldn't load automation capture settings.",
        updateFailed: "Couldn't update automation capture settings.",
    },
};

const panel = (captureIntent?: { enabled: boolean | null }) => buildGtdSettingsModel({
    settings: {},
    areas: [],
    taskOpenMode: 'automatic',
    ...(captureIntent ? { captureIntent } : {}),
    t: getTranslator('en'),
}).capture.captureIntent;

afterEach(async () => {
    await flushPendingSave();
    resetForTests();
});

describe('GTD › Capture: the automation capture card', () => {
    it('is absent where the device has no capture intent', () => {
        expect(panel()).toBeNull();
    });

    it('shows the switch off and disabled while the config is unread, off when disabled, and the token row only while on', () => {
        const { token: _token, ...card } = WORDS;
        expect(panel({ enabled: null })).toEqual({ ...card, value: false, disabled: true, token: null });
        expect(panel({ enabled: false })).toEqual({ ...card, value: false, disabled: false, token: null });
        expect(panel({ enabled: true })).toEqual({ ...card, value: true, disabled: false, token: WORDS.token });
    });

    it('comes through getGtdSettings, which refuses anything but { enabled } as a boolean or null', async () => {
        const host = await openScreenHost({ data: {}, record: {}, log: [] });
        expect(value(host.getGtdSettings({})).capture.captureIntent).toBeNull();
        expect(value(host.getGtdSettings({ captureIntent: { enabled: true } })).capture.captureIntent).toMatchObject({ value: true, token: WORDS.token });
        expect(value(host.getGtdSettings({ taskOpenMode: null, captureIntent: { enabled: null } })).capture.captureIntent).toMatchObject({ disabled: true });
        for (const captureIntent of [{ enabled: 'yes' }, { enabled: true, token: 'ab'.repeat(32) }, null, true]) {
            expect(host.getGtdSettings({ captureIntent } as never)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
        }
    });
});
