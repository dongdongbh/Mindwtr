import { describe, expect, it } from 'vitest';
import { hasMixedEnglishText, hasTranslatableEnglishText } from './locale-quality';
import { en } from './locales/en';
import { koOverrides } from './locales/ko';

describe('mixed-English locale quality', () => {
    it.each([
        'settings.mcpTitle',
        'settings.material3ThemeDesc',
        'settings.calendarSystemDesc',
        'settings.aiBaseUrlHint',
        'settings.syncMobile.dropboxOauthRequiresADevelopmentReleaseBuildExpoGoUses',
        'quickAdd.help',
        'quickAdd.bulkImportTextFile',
        'settings.webdavHint',
        'settings.invalidUrlHttp',
        'settings.backupMobile.mindwtrCsvAreasWillBeCreated',
        'settings.backupMobile.mindwtrCsvSectionsWillBeCreated',
        'settings.aiExtraBodyParamsHint',
        'settings.naturalLanguageDatesDesc',
        'obsidian.taskNotesDetectedHint',
        'search.helpOperators',
        'settings.linuxUpdateHint',
        'settings.syncMobile.oauthWithDropboxAppFolderAccessMindwtrSyncsAppsMindwtr',
        'settings.localApiTokenDesc',
        'settings.networkProxyInvalid',
        'settings.cloudRememberTokenHint',
        'settings.obsidianDataviewMetadataHint',
        'settings.obsidianMissingMarker',
    ])('preserves required technical text but detects untranslated prose in %s', (key) => {
        expect(hasMixedEnglishText('ko', key, koOverrides[key], en[key])).toBe(false);
        expect(hasMixedEnglishText('ko', key, `${koOverrides[key]} Please configure this setting.`, en[key])).toBe(true);
    });

    it('keeps English words detectable outside their documented syntax key', () => {
        for (const value of ['상태 status', '항목 Area', '영역 Section', '날짜 tomorrow', '인증 Authorization', '명령 /* focus']) {
            expect(hasMixedEnglishText('ko', 'common.save', value, en['common.save']), value).toBe(true);
        }
        expect(hasMixedEnglishText('ko', 'obsidian.taskNotesDetectedHint', '상태 statuses', en['obsidian.taskNotesDetectedHint'])).toBe(true);
        expect(hasMixedEnglishText('ko', 'quickAdd.help', '집중 focus', en['quickAdd.help'])).toBe(true);
        expect(hasMixedEnglishText('ko', 'settings.aiExtraBodyParamsHint', '잘못된 "English sentence"', en['settings.aiExtraBodyParamsHint'])).toBe(true);
        expect(hasMixedEnglishText('ko', 'settings.aiExtraBodyParamsHint', '고급 설정. thinking is disabled', en['settings.aiExtraBodyParamsHint'])).toBe(true);
    });

    it('accepts reviewed mirrors only when they exactly match the English value', () => {
        expect(hasMixedEnglishText('ko', 'settings.eink', 'E-Ink', 'E-Ink')).toBe(false);
        expect(hasMixedEnglishText('ko', 'settings.eink', 'E-Ink 테마', 'E-Ink')).toBe(true);
        expect(hasMixedEnglishText('ko', 'settings.eink', 'E-Ink please', 'E-Ink')).toBe(true);
        expect(hasMixedEnglishText('ko', 'common.save', 'E-Ink', 'E-Ink')).toBe(true);
    });

    it('does not excuse English sentences that contain approved brands and acronyms', () => {
        expect(hasTranslatableEnglishText('The MCP server could not start.')).toBe(true);
        expect(hasTranslatableEnglishText('Use Android and Google Play to update.')).toBe(true);
        expect(hasTranslatableEnglishText('Focus')).toBe(true);
        expect(hasTranslatableEnglishText('Thinking')).toBe(true);
        expect(hasTranslatableEnglishText('Window decorations')).toBe(true);
    });
});
