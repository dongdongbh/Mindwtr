import {
    buildSettingsSearchResults,
    formatSettingsSearchPath,
    matchSettingsSearchResults,
    type SettingsSearchPageId,
    type SettingsSearchResult,
} from '@mindwtr/core';

export type { SettingsSearchResult };
export { formatSettingsSearchPath, matchSettingsSearchResults };


export const SETTINGS_PAGE_SYNONYMS: Record<SettingsSearchPageId, readonly string[]> = {
    main: ['theme', 'font size', 'text size', 'dark mode', 'light mode'],
    gtd: ['auto-archive', 'priorities', 'time estimates', 'pomodoro', 'capture', 'inbox processing', '2-minute rule', 'task editor'],
    manage: ['areas', 'contexts', 'tags', 'rename', 'delete', 'reorder'],
    notifications: ['review reminders', 'weekly review', 'daily digest', 'morning', 'evening'],
    sync: ['file sync', 'WebDAV', 'cloud', 'sync now', 'sync history', 'recovery snapshots', 'dropbox', 'self-hosted', 'iCloud', 'settings sync'],
    data: ['backup', 'restore', 'import', 'Todoist', 'DGT GTD', 'OmniFocus', 'CSV', 'Mindwtr CSV', 'attachments', 'cleanup', 'archive retention', 'permanent archive removal', 'diagnostics', 'logging', 'workspaces', 'profiles'],
    integrations: ['obsidian', 'vault', 'calendar', 'ICS', 'apple calendar', 'integration'],
    ai: ['OpenAI', 'Gemini', 'Anthropic', 'API key', 'speech', 'whisper', 'copilot', 'model', 'timeout'],
    advanced: ['automation', 'local api', 'localhost', 'port', 'mcp', 'Claude', 'LLM', 'launch at startup', 'autostart', 'login item'],
    about: ['version', 'update', 'license', 'sponsor'],
};

export function buildDesktopSettingsSearchResults(
    translate: (key: string) => string,
): SettingsSearchResult[] {
    return buildSettingsSearchResults(translate, SETTINGS_PAGE_SYNONYMS);
}


export const SETTINGS_ROW_ATTR = 'data-settings-key';
export const SETTINGS_SECTION_ATTR = 'data-settings-section';
export const SETTINGS_HIGHLIGHT_ATTR = 'data-settings-highlight';

const SETTINGS_SECTION_ANCESTORS: Partial<Record<string, string>> = {
    aiRequestTimeout: 'aiEnable',
};

export function findSettingsRow(key: string): HTMLElement | null {
    if (typeof document === 'undefined') return null;
    return document.querySelector<HTMLElement>(`[${SETTINGS_ROW_ATTR}="${key}"]`);
}


export function expandSettingsSection(section: string | undefined): boolean {
    if (!section || typeof document === 'undefined') return false;
    let toggle = document.querySelector<HTMLElement>(
        `[${SETTINGS_SECTION_ATTR}="${section}"][aria-expanded="false"]`,
    );
    if (!toggle) {
        const ancestor = SETTINGS_SECTION_ANCESTORS[section];
        if (ancestor) {
            toggle = document.querySelector<HTMLElement>(
                `[${SETTINGS_SECTION_ATTR}="${ancestor}"][aria-expanded="false"]`,
            );
        }
    }
    if (!toggle) return false;
    toggle.click();
    return true;
}


export function highlightSettingsRow(element: HTMLElement): void {
    element.setAttribute(SETTINGS_HIGHLIGHT_ATTR, 'true');
    if (typeof element.scrollIntoView === 'function') {
        element.scrollIntoView({ block: 'center' });
    }
}

export function clearSettingsRowHighlight(element: HTMLElement): void {
    element.removeAttribute(SETTINGS_HIGHLIGHT_ATTR);
}
