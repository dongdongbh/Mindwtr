export const allowedEnglishMirrorTerms = [
    'Mindwtr',
    'Apple',
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
    'ZIP',
    'Markdown',
    'TaskNotes',
    'Todoist',
    'TickTick',
    'OmniFocus',
    'Obsidian',
    'DGT',
    'Vim',
    'Emacs',
    'Nord',
    'Catppuccin',
    'Macchiato',
    'Dracula',
] as const;

export const allowedEnglishMirrorKeysByLocale: Record<string, readonly string[]> = {
    de: [
        // German shares these labels with English identically: loanwords and
        // internationalisms already standard in German UI copy ("Status", "Details",
        // "Version", "System", "Port", "Standard", "Optional", "Parallel", "Routine",
        // "Pause", "Passphrase", "Backend"), color names spelled the same, the "Name"
        // field label, and brand/technology terms kept in Latin ("E-Ink", "Sepia",
        // "Screenshot", "Agenda").
        'keybindings.style.standard',
        'bulk.organizeStatus',
        'common.pause',
        'context.energy.routine',
        'list.details',
        'projects.colorCyan',
        'projects.colorIndigo',
        'projects.colorOrange',
        'projects.colorPink',
        'projects.parallel',
        'projects.statusLabel',
        'quickAdd.pastedImageTitle',
        'settings.calendarMobile.optional',
        'settings.calendarName',
        'settings.dropboxStatus',
        'settings.eink',
        'settings.emailCapturePort',
        'settings.externalCalendarName',
        'settings.gtdMobile.standard',
        'settings.localApiPort',
        'settings.projectFlowParallel',
        'settings.sepia',
        'settings.syncEncryptionPassphrase',
        'settings.syncHistoryBackend',
        'settings.syncHistoryDetails',
        'settings.system',
        'settings.version',
        'tab.agenda',
        'taskEdit.details',
        'taskEdit.statusLabel',
    ],
    it: [
        'keybindings.style.standard',
    ],
    ko: [
        // Korean UI writes the e-ink theme in Latin.
        'settings.eink',
    ],
    fa: [
        // Persian tech writing keeps "E-Ink" in Latin (it's a display-technology
        // brand name), and "Apple Reminders" is the Apple product's proper name.
        'settings.eink',
        'settings.appleRemindersImport.appleReminders',
    ],
    sv: [
        // Swedish shares these words with English identically (loanwords or
        // Latin-derived cognates spelled the same way in both languages), or the
        // term is a proper noun/brand kept in Latin per the add-swedish handoff.
        'keybindings.style.standard',
        'settings.gtdMobile.standard',
        'taskEdit.start',
        'calendar.start',
        'taskEdit.statusLabel',
        'projects.statusLabel',
        'bulk.organizeStatus',
        'settings.dropboxStatus',
        'taskEdit.relativeStartMinutesShort',
        'taskEdit.repeatReminderMinutesShort',
        'settings.system',
        'settings.eink',
        'settings.sepia',
        'settings.version',
        'settings.data',
        'settings.captureDefaultText',
        'settings.syncHistoryBackend',
        'settings.rendering',
        'settings.localApiPort',
        'settings.emailCapturePort',
        'settings.appleRemindersImport.appleReminders',
    ],
    fr: [
        'calendar.date',
        'keybindings.style.standard',
        'common.pause',
        'context.energy.routine',
        'list.compact',
        'list.densityCompact',
        'projects.sectionsLabel',
        'recurrence.occurrenceUnit',
        'review.description',
        'settings.aiMobile.suggestions',
        'settings.densityCompact',
        'settings.documentation',
        'settings.feedbackMessage',
        'settings.feedbackWhereNotifications',
        'settings.gtdMobile.simple',
        'settings.gtdMobile.standard',
        'settings.notifications',
        'settings.speechFieldDescription',
        'settings.syncHistoryBackend',
        'settings.syncHistoryType',
        'settings.version',
        'tab.menu',
        'tags.title',
        'task.aria.tags',
        'taskEdit.descriptionLabel',
        'taskEdit.tagsLabel',
        'taskEdit.timeSpentPlaceholder',
    ],
};

const translatableEnglishPattern = /[A-Za-z]{3,}/;

export function isAllowedEnglishMirrorKey(locale: string, key: string): boolean {
    return allowedEnglishMirrorKeysByLocale[locale]?.includes(key) ?? false;
}

export function stripAllowedEnglishTerms(value: string): string {
    let next = value
        .replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S*/g, '')
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
