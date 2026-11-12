import { I18N_TEMPLATE_SLOT_PATTERN } from './index';

export const allowedEnglishMirrorTerms = [
    'Mindwtr',
    'Apple',
    'WebDAV',
    'CalDAV',
    'Flatpak',
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


    'Syncthing',
    'Send & Receive',
    'Watch for Changes',
    'DGT',
    'Vim',
    'Emacs',
    'Nord',
    'Catppuccin',
    'Macchiato',
    'Dracula',
    'Gruvbox Light',
    'Gruvbox Dark',
    'MCP',
    'Codex',
    'OLED',
    'Material 3',
    'Android',
    'DAVx5',
    'Outlook',
    'Mindwtr Cloud',
    'VPN',
    'Expo Go',
    'llama.cpp',
    'Ollama',
    'LM Studio',
    'GLM',
    'vLLM',
    'Whisper',
    'GPT-5',
    'Copilot',
    'macOS',
    'iOS',

    'Windows Hello',
    'Touch ID',
    'Mac',
    'Apple Calendar',
    'Linux',
    'Evolution Data Server',
    'iCloud Drive',
    'Google Drive',
    'OneDrive',
    'Microsoft Store',
    'Arch',
    'AUR',
    'Google Play',
    'App Store',
    'FOSS',
    'LLM',
    'Google',
    'OAuth',
    'MDM',
    'GPU',
    'Parakeet',
    'ASR',
    'PWA',
    'Dataview',
    'IMAP',
    'Gmail',
    'iCloud Mail',
    'Fastmail',
] as const;

const allowedEnglishTermsLongestFirst = [...allowedEnglishMirrorTerms].sort((a, b) => b.length - a.length);

export const allowedEnglishMirrorKeysByLocale: Record<string, readonly string[]> = {
    de: [

        'sandbox.label',


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
    es: [


        'projects.color',
        'settings.general',
        'settings.eink',
        'settings.sepia',
        'settings.captureDefaultAudio',
        'common.error',
        'someday.ideas',
        'settings.syncMobile.error',
        'settings.speechProviderParakeet',
    ],
    it: [
        'sandbox.label',
        'keybindings.style.standard',
    ],
    nl: [
        'sandbox.label',

        'list.countProjectSingular',
    ],
    ko: [

        'settings.eink',
    ],
    fa: [


        'settings.eink',
        'settings.appleRemindersImport.appleReminders',
    ],
    sv: [


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
    da: [


        'nav.reference',
        'keybindings.style.standard',
        'tab.menu',
        'list.reference',
        'status.reference',
        'priority.medium',
        'taskEdit.start',
        'taskEdit.statusLabel',
        'taskEdit.tagsLabel',
        'taskEdit.relativeStartMinutesShort',
        'taskEdit.repeatReminderMinutesShort',
        'task.aria.tags',
        'calendar.start',
        'calendar.deadline',
        'projects.statusLabel',
        'projects.colorOrange',
        'projects.colorCyan',
        'projects.colorIndigo',
        'projects.parallel',
        'projects.projectTypeLabel',
        'dailyReview.start',
        'review.deadline',
        'process.reference',
        'settings.system',
        'settings.eink',
        'settings.sepia',
        'settings.platform',
        'settings.data',
        'settings.aiModel',
        'settings.aiEffortMedium',
        'settings.aiThinkingMedium',
        'settings.projectFlowParallel',
        'tags.title',
        'common.pause',
        'common.offline',
        'common.start',
        'bulk.organizeStatus',
        'settings.dropboxStatus',
        'settings.syncHistoryBackend',
        'settings.syncHistoryType',
        'settings.calendarMobile.test',
        'settings.gtdMobile.standard',
        'settings.localApiPort',
        'settings.emailCapturePort',
        'mindSweep.launchButton',
        'mindSweep.title',
        'shareCard.styleMinimal',
    ],
    fr: [
        'calendar.date',
        'task.dates',
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
    hu: [


        'settings.eink',
        'settings.platform',
        'common.offline',
        'settings.appleRemindersImport.appleReminders',
        'settings.localApiPort',
        'settings.emailCapturePort',
        'settings.localApiToken',
        'settings.networkProxyUrl',
    ],
};

const translatableEnglishPattern = /[A-Za-z]{3,}/;

export function isAllowedEnglishMirrorKey(locale: string, key: string): boolean {
    return allowedEnglishMirrorKeysByLocale[locale]?.includes(key) ?? false;
}

export function stripAllowedEnglishTerms(value: string): string {
    let next = value
        .replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S*/g, '')


        .replace(I18N_TEMPLATE_SLOT_PATTERN, '')
        .replace(/\/[A-Za-z][A-Za-z0-9:_-]*/g, '')


        .replace(/<[A-Za-z][A-Za-z0-9_-]*>/g, '')
        .replace(/[+#@!][A-Za-z][A-Za-z0-9:_-]*/g, '');

    for (const term of allowedEnglishTermsLongestFirst) {
        next = next.replace(new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), '');
    }
    return next;
}

export function hasTranslatableEnglishText(value: string): boolean {
    return translatableEnglishPattern.test(stripAllowedEnglishTerms(value));
}


const technicalTermsByKey: Record<string, readonly string[]> = {
    'quickAdd.help': ['/* focus', '%Person', '%"Full Name"', '/remind-due:1d', '/remind-start:30m'],
    'quickAdd.bulkImportTextFile': ['.txt'],
    'keybindings.helpSubtitle': ['Esc'],
    'settings.webdavHint': ['data.json'],
    'settings.invalidUrlHttp': ['http/https'],
    'settings.backupMobile.mindwtrCsvAreasWillBeCreated': ['Area'],
    'settings.backupMobile.mindwtrCsvSectionsWillBeCreated': ['Section'],
    'settings.aiExtraBodyParamsHint': ['model', 'messages', 'response_format', '"thinking"', '"type"', '"disabled"'],
    'settings.naturalLanguageDatesDesc': ['tomorrow', 'next week'],
    'obsidian.taskNotesDetectedHint': ['status', 'tags', 'task', 'due', 'scheduled', 'contexts', 'projects', 'timeEstimate', 'recurrence', 'completedDate'],
    'search.helpOperators': ['status:', 'context:', 'tag:', 'project:', 'due:<=7d'],
    'settings.linuxUpdateHint': ['yay -S mindwtr', 'paru -S mindwtr'],
    'settings.aboutMobile.googlePlayUpdateAvailableWithVersions': ['Play'],
    'settings.calendarMobile.chooseLocalIcsFile': ['.ics'],
    'settings.calendarMobile.localIcsFileAdded': ['.ics'],
    'settings.calendarMobile.localIcsFilesAreReadOnly': ['.ics'],
    'settings.syncMobile.oauthWithDropboxAppFolderAccessMindwtrSyncsAppsMindwtr': ['/Apps/Mindwtr/data.json', '/Apps/Mindwtr/attachments/*'],
    'settings.syncMobile.pleaseEnterAValidSelfHostedUrlHttpHttps': ['http/https'],
    'settings.syncMobile.pleaseEnterAValidWebdavUrlHttpHttps': ['http/https'],
    'settings.localApiToken': ['Bearer'],
    'settings.localApiTokenDesc': ['Authorization'],
    'settings.networkProxyInvalid': ['http(s)'],
    'settings.calendarChooseLocalFile': ['.ics'],
    'settings.cloudRememberTokenHint': ['localStorage'],
    'settings.obsidianDataviewMetadataHint': ['project::', 'context::', 'due::', 'scheduled::', 'priority::', 'estimate::'],
    'settings.obsidianMissingMarker': ['.obsidian'],
    'workspaces.cliHint': ['MCP', 'mindwtr.db', '--db'],
    'workspaces.unreadable': ['workspaces.toml'],
};

export function hasMixedEnglishText(locale: string, key: string, value: string, english: string): boolean {
    if (value === english && isAllowedEnglishMirrorKey(locale, key)) return false;
    for (const term of technicalTermsByKey[key] ?? []) {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        value = value.replace(new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'g'), '');
    }
    return hasTranslatableEnglishText(value);
}


export const ENGLISH_FUNCTION_WORDS: ReadonlySet<string> = new Set(`
the this that these those an any all each every some no both other another such
you your yours my me we our us they them their it its he she his her who whom whose
what which someone something anything nothing everything
is are was were be been being am do does did done have has had
will would can could shall should may might must cannot
of in on at to for from with without by about into onto over under between among
during before after until while since through against
and or but if then than because so as when where why how
not only also just still yet already again always never here there now
up down out off back more most less least very too own same next last first new old
`.trim().split(/\s+/));


export const nativeEnglishHomographsByLocale: Record<string, readonly string[]> = {


    vi: ['to', 'an', 'in', 'no', 'can', 'do', 'so', 'my', 'at', 'on', 'am', 'be', 'me', 'it'],
    es: ['has', 'no', 'me'],
    pt: ['as', 'no', 'do', 'me'],
    it: ['in', 'no', 'me', 'so', 'do'],

    fr: ['an', 'on', 'or', 'me', 'but', 'as'],

    de: ['in', 'an', 'so', 'will', 'am', 'was', 'her', 'all'],

    nl: ['in', 'is', 'of', 'we', 'had', 'over', 'was', 'me'],

    pl: ['to', 'on', 'do', 'by', 'no', 'we'],
    cs: ['do', 'to', 'on', 'by', 'no', 'my'],

    tr: ['on', 'an', 'at', 'in', 'her', 'as'],

    sv: ['in', 'under', 'all', 'is', 'just', 'be', 'for'],

    da: ['at', 'for', 'over', 'under', 'her'],


    hu: ['is', 'be'],
};


export const allowedEnglishResidueKeysByLocale: Record<string, readonly string[]> = {};

const WORD_PATTERN = /\p{L}[\p{L}\p{N}_'’-]*/gu;

function contentWords(value: string): string[] {
    return (stripAllowedEnglishTerms(value).match(WORD_PATTERN) ?? []).map((word) => word.toLowerCase());
}


export function englishResidueWords(locale: string, translated: string, english: string): string[] {
    const native = new Set(nativeEnglishHomographsByLocale[locale] ?? []);
    const sourceWords = new Set(contentWords(english));
    const residue = new Set<string>();
    for (const word of contentWords(translated)) {
        if (word.length < 2) continue;
        if (!ENGLISH_FUNCTION_WORDS.has(word)) continue;
        if (native.has(word)) continue;
        if (!sourceWords.has(word)) continue;
        residue.add(word);
    }
    return [...residue].sort();
}

export function isAllowedEnglishResidueKey(locale: string, key: string): boolean {
    return allowedEnglishResidueKeysByLocale[locale]?.includes(key) ?? false;
}


const SLASH_COMMAND_TOKEN_PATTERN = /(?<![\p{L}\p{N}/.:])\/(?:\*|[a-z][a-z0-9]*:?)/gu;

export function slashCommandTokens(value: string): string[] {
    return [...new Set(value.match(SLASH_COMMAND_TOKEN_PATTERN) ?? [])];
}


export function missingSlashCommandTokens(translated: string, english: string): string[] {
    const present = new Set(slashCommandTokens(translated));
    return slashCommandTokens(english).filter((token) => !present.has(token));
}


const QUOTED_LABEL_PATTERN = /["“«„「]([^"”»“」]{5,60})["”»“」]/g;
const QUOTED_LABEL_MAX_LENGTH = 40;


export function quotedEnglishLabels(
    key: string,
    translated: string,
    english: Record<string, string>,
    translations: Record<string, string>,
): string[] {
    const found: string[] = [];
    for (const match of translated.matchAll(QUOTED_LABEL_PATTERN)) {
        const label = match[1].trim();
        if (label.length > QUOTED_LABEL_MAX_LENGTH || !/[A-Za-z]/.test(label) || /[{}]/.test(label)) continue;
        const labelKeys = Object.keys(english).filter((other) => other !== key && english[other] === label);
        if (labelKeys.length === 0) continue;


        const stillShown = labelKeys.some((other) => translations[other] === undefined || translations[other] === label);
        if (!stillShown) found.push(label);
    }
    return found;
}
