import {
    buildSettingsSearchResults,
    formatSettingsSearchPath,
    matchSettingsSearchResults,
    type SettingsSearchPageId,
    type SettingsSearchResult,
} from '@mindwtr/core';

export type { SettingsSearchResult };
export { formatSettingsSearchPath, matchSettingsSearchResults };

// Hand-curated terms that lead to a page without appearing in any of its
// setting names. They supplement the localized labels in
// packages/core/src/settings-search-keys.ts (the actual index) and only ever
// match the page row itself.
export const SETTINGS_PAGE_SYNONYMS: Record<SettingsSearchPageId, readonly string[]> = {
    main: ['theme', 'font size', 'text size', 'dark mode', 'light mode', 'launch at startup', 'autostart', 'login item'],
    gtd: ['auto-archive', 'priorities', 'time estimates', 'pomodoro', 'capture', 'inbox processing', '2-minute rule', 'task editor'],
    manage: ['areas', 'contexts', 'tags', 'rename', 'delete', 'reorder'],
    notifications: ['review reminders', 'weekly review', 'daily digest', 'morning', 'evening'],
    sync: ['file sync', 'WebDAV', 'cloud', 'sync now', 'sync history', 'recovery snapshots', 'dropbox', 'self-hosted', 'iCloud', 'settings sync'],
    data: ['backup', 'restore', 'import', 'Todoist', 'DGT GTD', 'OmniFocus', 'CSV', 'Mindwtr CSV', 'attachments', 'cleanup', 'diagnostics', 'logging'],
    integrations: ['obsidian', 'vault', 'calendar', 'ICS', 'apple calendar', 'integration'],
    ai: ['OpenAI', 'Gemini', 'Anthropic', 'API key', 'speech', 'whisper', 'copilot', 'model', 'timeout'],
    advanced: ['automation', 'local api', 'localhost', 'port', 'mcp', 'Claude', 'LLM'],
    about: ['version', 'update', 'license', 'sponsor'],
};

export function buildDesktopSettingsSearchResults(
    translate: (key: string) => string,
): SettingsSearchResult[] {
    return buildSettingsSearchResults(translate, SETTINGS_PAGE_SYNONYMS);
}

// Settings rows carry their label key so a search result can find, expand and
// scroll to the exact row; disclosure toggles carry the section key of what
// they contain. Reading the DOM (rather than threading a "reveal this key"
// prop through ten page components) keeps the pages unaware of search.
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

// Opens the disclosure containing `section` if it is currently collapsed.
// Returns true when it clicked something, i.e. the caller should look for the
// row again after React re-renders.
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

// Same treatment a highlighted task row gets (see TaskItem/AgendaView): scroll
// it into the middle of the viewport and mark it until the caller clears it.
export function highlightSettingsRow(element: HTMLElement): void {
    element.setAttribute(SETTINGS_HIGHLIGHT_ATTR, 'true');
    if (typeof element.scrollIntoView === 'function') {
        element.scrollIntoView({ block: 'center' });
    }
}

export function clearSettingsRowHighlight(element: HTMLElement): void {
    element.removeAttribute(SETTINGS_HIGHLIGHT_ATTR);
}
