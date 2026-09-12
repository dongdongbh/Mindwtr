import { describe, expect, it } from 'vitest';

import { getEnglishI18nValue, getTranslationsSync, loadTranslations, type Language } from '@mindwtr/core';

import {
    labelKeyOverrides,
    SETTINGS_LABEL_KEYS,
    type SettingsLabels,
} from './labels';

function i18nKeyFor(key: keyof SettingsLabels): string {
    return labelKeyOverrides[key] ?? `settings.${key}`;
}

async function buildLabels(language: Language): Promise<SettingsLabels> {
    await loadTranslations(language);
    const translations = getTranslationsSync(language);
    const result = {} as SettingsLabels;
    for (const key of SETTINGS_LABEL_KEYS) {
        const i18nKey = i18nKeyFor(key);
        result[key] = translations[i18nKey] ?? i18nKey;
    }
    return result;
}

// These were the specific desktop settings labels a user reported still
// showing Simplified characters in the zh-Hant UI. The fix moved every
// settings string into core's locale files, where locale-parity.test.ts now
// enforces full zh/zh-Hant coverage; this keeps a direct regression check on
// the originally reported keys since parity alone wouldn't catch Simplified
// text quietly shipping inside the zh-Hant file.
const reportedZhHantLabels = {
    searchPlaceholder: '搜索設置…',
    lookAndFeel: '外觀與風格',
    input: '輸入',
    windowBehavior: '窗口行為',
    textSizeDesc: '調整桌面應用的介面文字。',
    showTaskAge: '顯示任務年齡',
    showTaskAgeDesc: '在任務元數據中顯示任務創建距今多久。',
    defaultScheduleTime: '默認安排時間',
    defaultScheduleTimeDesc: '可選。選擇日期後自動填入開始、截止和回顧時間。留空則保持僅日期。',
    undoNotifications: '撤銷通知',
    undoNotificationsDesc: '在將任務標記為已完成或刪除後顯示可撤銷提示。',
    launchAtStartup: '開機自動啟動',
    launchAtStartupDesc: '登錄這台電腦時自動啟動 Mindwtr。',
    localApiServer: '啟用本地 API 伺服器',
    localApiPortDesc: '僅限 localhost。默認：3456。',
    localApiStopped: '關閉',
    taskEditorPresentation: '編輯器打開方式',
    taskEditorPresentationDesc: '選擇在桌面端編輯任務時的打開方式。',
    taskEditorPresentationInline: '側邊預覽',
    taskEditorPresentationInlineDesc: '在當前視圖內打開編輯器，適合快速編輯。',
    taskEditorPresentationModal: '彈窗',
    taskEditorPresentationModalDesc: '在居中的彈窗中打開編輯器，適合專注編輯。',
    backup: '備份',
    backupDesc: '導出完整備份，或從備份文件恢復或合併本地數據。',
    importData: '導入數據',
    importDataDesc: '導入 Todoist、TickTick、DGT GTD、OmniFocus 與 Mindwtr CSV 導出文件。',
    exportBackupDesc: '將當前本地數據保存為 JSON 備份文件。',
    restoreBackup: '恢復備份',
    restoreBackupDesc: '從 Mindwtr 備份 JSON 文件替換本地數據。',
    importTodoist: '從 Todoist 導入',
    importTodoistDesc: '將 Todoist 的 CSV 或 ZIP 導出導入為 Mindwtr 專案。',
    importTickTick: '從 TickTick 導入',
    importTickTickDesc: '將 TickTick 的 CSV 或 ZIP 備份導入為 Mindwtr 的領域、專案和任務。',
    importDgt: '從 DGT GTD 導入',
    importDgtDesc: '將 DGT GTD 的 JSON 或 ZIP 導出導入為 Mindwtr 的領域、專案和任務。',
    importOmniFocus: '從 OmniFocus 導入',
    importOmniFocusDesc: '將 OmniFocus 的 CSV、JSON 或 ZIP 導出導入為 Mindwtr 專案和收集箱任務。',
    backgroundSync: '後台同步',
    backgroundSyncDesc: '桌面端會在啟動時、應用重新獲得焦點時、Mindwtr 運行時每 15 分鐘一次，以及任務/專案變更後短暫延遲同步。關閉到托盤可保持運行；開機自動啟動可在登錄後啟動。退出應用會停止桌面後台同步。',
    attachmentsCleanupPendingDeletes: '待處理遠程刪除',
    attachmentsCleanupPendingDeletesClear: '清除待處理刪除',
    calendarChooseLocalFile: '選擇本地 .ics 文件',
    obsidianVault: 'Obsidian 資料庫導入',
    obsidianVaultDesc: '從本地 Obsidian 資料庫導入任務。Obsidian 保留筆記與捕獲來源，Mindwtr 管理原生承諾事項。',
} as const;

describe('settings label registry', () => {
    it('resolves every settings label key to a translated core i18n string', () => {
        const missing = SETTINGS_LABEL_KEYS.filter((key) => !getEnglishI18nValue(i18nKeyFor(key)));
        expect(missing).toEqual([]);
    });

    it('uses Traditional Chinese text for the originally reported desktop settings labels', async () => {
        const zhHant = await buildLabels('zh-Hant');
        for (const [key, expected] of Object.entries(reportedZhHantLabels)) {
            expect(zhHant[key as keyof SettingsLabels], key).toBe(expected);
        }
    });

    it('keeps Simplified Chinese fallbacks unchanged for zh', async () => {
        const zh = await buildLabels('zh');
        expect(zh.searchPlaceholder).toBe('搜索设置…');
    });
});
