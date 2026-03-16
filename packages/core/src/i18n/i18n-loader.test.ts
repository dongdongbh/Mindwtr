import { describe, expect, it } from 'vitest';
import { getTranslationsSync, loadTranslations } from './i18n-loader';

describe('i18n-loader sync fallback', () => {
    it('provides English translations synchronously for first render', () => {
        expect(getTranslationsSync('en')['app.name']).toBe('Mindwtr');
        expect(getTranslationsSync('zh')['nav.inbox']).toBe('Inbox');
    });

    it('loads Dutch overrides on demand', async () => {
        const nl = await loadTranslations('nl');
        expect(nl['settings.language']).toBe('Taal');
        expect(nl['app.name']).toBe('Mindwtr');
    });

    it('loads Traditional Chinese translations on demand', async () => {
        const zhHant = await loadTranslations('zh-Hant');
        expect(zhHant['nav.settings']).toBe('設置');
    });

    it('includes discard-confirmation translations for Chinese locales', async () => {
        const zhHans = await loadTranslations('zh');
        const zhHant = await loadTranslations('zh-Hant');

        expect(zhHans['taskEdit.discardChanges']).toBe('放弃未保存的更改？');
        expect(zhHans['taskEdit.discardChangesDesc']).toBe('如果现在离开，你的更改将会丢失。');
        expect(zhHans['common.discard']).toBe('放弃');

        expect(zhHant['taskEdit.discardChanges']).toBe('放棄未保存的更改？');
        expect(zhHant['taskEdit.discardChangesDesc']).toBe('如果現在離開，你的更改將會丟失。');
        expect(zhHant['common.discard']).toBe('放棄');
    });

    it('loads Traditional Chinese sync settings copy for provider test actions', async () => {
        const zhHant = await loadTranslations('zh-Hant');

        expect(zhHant['settings.cloudBaseUrlHint']).toBe('填寫基礎地址，Mindwtr 會自動加上 /data。');
        expect(zhHant['settings.webdavTestHint']).toBe('僅驗證地址與憑證，不執行資料同步');
        expect(zhHant['settings.cloudTestHint']).toBe('僅驗證地址與令牌，不執行資料同步');
        expect(zhHant['settings.dropboxTestHint']).toBe('驗證 Dropbox 令牌與帳號存取。');
    });

    it('loads mobile calendar and sync-off settings copy through i18n keys', async () => {
        const en = await loadTranslations('en');
        const zhHans = await loadTranslations('zh');
        const zhHant = await loadTranslations('zh-Hant');

        expect(en['settings.deviceCalendars']).toBe('Device calendars');
        expect(en['settings.syncOff']).toBe('Sync is off');

        expect(zhHans['settings.deviceCalendars']).toBe('设备日历');
        expect(zhHans['settings.syncOffDesc']).toBe('您可以随时在此页面重新开启同步。');

        expect(zhHant['settings.deviceCalendars']).toBe('裝置日曆');
        expect(zhHant['settings.syncOff']).toBe('同步已關閉');
    });
});
