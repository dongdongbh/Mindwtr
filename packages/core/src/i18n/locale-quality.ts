export const allowedEnglishMirrorTerms = [
    'Mindwtr',
    'WebDAV',
    'CalDAV',
    'Dropbox',
    'iCloud',
    'CloudKit',
    'GitHub',
    'OpenAI',
    'Gemini',
    'Anthropic',
    'Claude',
    'Pomodoro',
    'GTD',
    'ICS',
    'URL',
    'URI',
    'API',
    'AI',
    'OK',
    'HTTP',
    'HTTPS',
    'JSON',
    'CSV',
    'PDF',
    'Markdown',
    'TaskNotes',
    'Todoist',
    'OmniFocus',
    'DGT',
    'Vim',
    'Emacs',
    'Nord',
] as const;

export const allowedEnglishMirrorKeysByLocale: Record<string, readonly string[]> = {
    fr: [
        'tab.menu',
        'list.compact',
        'list.densityCompact',
        'priority.urgent',
        'taskEdit.descriptionLabel',
        'taskEdit.textDirection.auto',
        'recurrence.occurrenceUnit',
        'recurrence.strategyStrict',
        'calendar.date',
        'projects.sectionsLabel',
        'review.aiAction.archive',
        'review.description',
        'settings.version',
        'settings.notifications',
        'settings.speechFieldDescription',
        'common.pause',
        'context.energy.routine',
        'settings.densityCompact',
        'settings.syncHistoryBackend',
        'settings.syncHistoryType',
        'settings.syncHistoryDetails',
        'settings.documentation',
        'settings.feedbackMessage',
        'settings.feedbackWhereFocus',
        'settings.feedbackWhereNotifications',
        'settings.aiMobile.suggestions',
        'settings.gtdMobile.simple',
        'settings.gtdMobile.standard',
    ],
};

const translatableEnglishPattern = /[A-Za-z]{3,}/;

export function isAllowedEnglishMirrorKey(locale: string, key: string): boolean {
    return allowedEnglishMirrorKeysByLocale[locale]?.includes(key) ?? false;
}

export function stripAllowedEnglishTerms(value: string): string {
    let next = value
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g, '')
        .replace(/\/[A-Za-z][A-Za-z0-9:_-]*/g, '')
        .replace(/[+#@!][A-Za-z][A-Za-z0-9:_-]*/g, '');

    for (const term of allowedEnglishMirrorTerms) {
        next = next.replace(new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), '');
    }
    return next;
}

export function hasTranslatableEnglishText(value: string): boolean {
    return translatableEnglishPattern.test(stripAllowedEnglishTerms(value));
}
