import { I18N_TEMPLATE_SLOT_PATTERN } from './index';

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
    // Third-party UI labels quoted verbatim in our copy. A translated sentence that tells
    // the reader which Syncthing buttons to press has to name them exactly as Syncthing
    // does, or the instruction stops working.
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
    es: [
        // Spanish writes these exactly as English: words that are the same in both
        // languages (Color, General, Audio, Error, Ideas, Sepia) or proper/product
        // names kept in Latin (E-Ink, the Parakeet speech provider label).
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
        // Both brace styles, via the pattern that actually fills them. This used to strip only
        // `{{name}}`, so a bare `{count}` — equally a real slot to formatI18nTemplate — left the
        // word "count" behind and read as untranslated English to the check below.
        .replace(I18N_TEMPLATE_SLOT_PATTERN, '')
        .replace(/\/[A-Za-z][A-Za-z0-9:_-]*/g, '')
        // Quick-add syntax placeholders: `/start:<when>`, `/note:<text>`. The angle-bracketed
        // name is part of the command the user types, identical in every locale, so it is not
        // English prose left behind.
        .replace(/<[A-Za-z][A-Za-z0-9_-]*>/g, '')
        .replace(/[+#@!][A-Za-z][A-Za-z0-9:_-]*/g, '');

    for (const term of allowedEnglishMirrorTerms) {
        next = next.replace(new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), '');
    }
    return next;
}

export function hasTranslatableEnglishText(value: string): boolean {
    return translatableEnglishPattern.test(stripAllowedEnglishTerms(value));
}

// ---------------------------------------------------------------------------
// English residue in Latin-script locales
// ---------------------------------------------------------------------------
//
// hasTranslatableEnglishText above only works for a non-Latin locale, where ANY Latin
// word is suspicious. It is useless for es/de/nl/pl/tr/pt, whose own alphabet is Latin,
// so nothing checked those files at all -- and they turned out to hold ~86 values that
// are English sentences with individual words swapped for the target language by a
// script: es 'Are you sure you want to Eliminar this section?', nl 'You are using the
// laTest version!', de 'Aufgaben and Projekte suchen ...'. Each reads as a translated
// string to every other check here: the key is present, the value differs from en.ts,
// and the value is not a verbatim English mirror.
//
// THE SIGNAL. Those values are the English source with words replaced in place, so the
// English function words survive. A real translation of the same string shares no
// function words with its source, because they have no reason to appear.
//
// So: flag a value that still contains an English function word which ALSO appears in
// its own English source string. Requiring the word to be in the source is what makes
// this safe -- it is evidence of a word that survived substitution, not merely of a
// word that resembles English.
//
// Three further filters, each added because it removed a measured false positive:
//   - per-locale homographs below (Polish 'to', German 'will', Dutch 'is');
//   - words of one letter, which collide across every language ('Sortera A-O');
//   - <angle> placeholders and quoted third-party UI labels, stripped above.
//
// MEASURED. Over the 11 Latin-script locales this flags 86 values, every one inspected
// and genuine. The four locales with careful human translations -- vi, fr, cs, sv --
// come out at exactly 0, which is the real evidence: the check finds substituted
// English, not merely "text that has English-looking words in it".
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

// Words above that are ordinary words of the target language, where finding one proves
// nothing. Kept deliberately tight: every entry blinds the check to that word in that
// locale, so an over-broad list is a silent false negative, not a harmless precaution.
export const nativeEnglishHomographsByLocale: Record<string, readonly string[]> = {
    // Unaccented Vietnamese syllables are words: to (big), an (eat), in (print),
    // can (need), do (because), so (compare), my (America), at, on, am (sound), be (calf).
    vi: ['to', 'an', 'in', 'no', 'can', 'do', 'so', 'my', 'at', 'on', 'am', 'be', 'me', 'it'],
    es: ['has', 'no', 'me'],
    pt: ['as', 'no', 'do', 'me'],
    it: ['in', 'no', 'me', 'so', 'do'],
    // French: an (year), on (one), or (gold/now), but (goal), as (tu as).
    fr: ['an', 'on', 'or', 'me', 'but', 'as'],
    // German: will (wants), was (what), an, am, so, her, in, all.
    de: ['in', 'an', 'so', 'will', 'am', 'was', 'her', 'all'],
    // Dutch: of (or), we, had, over, was, is, in, me.
    nl: ['in', 'is', 'of', 'we', 'had', 'over', 'was', 'me'],
    // Polish: to (this), on (he), do (to), by, no (colloquial), we (in).
    pl: ['to', 'on', 'do', 'by', 'no', 'we'],
    cs: ['do', 'to', 'on', 'by', 'no', 'my'],
    // Turkish: on (ten), an (moment), at (horse), in (den), her (every), as (hang).
    tr: ['on', 'an', 'at', 'in', 'her', 'as'],
    // Swedish: i/in, under (during), all, is (ice), just, be (ask), for (fared).
    sv: ['in', 'under', 'all', 'is', 'just', 'be', 'for'],
};

/**
 * Keys where an English fragment in a Latin-script locale is deliberate.
 *
 * Empty, and that is the finding rather than an oversight: every value this check flagged
 * was a real defect and was retranslated instead. Third-party UI labels quoted in our copy
 * ("Send & Receive", "Watch for Changes") are handled as terms above, which is the better
 * home for them because it applies in every locale at once. Add a key here only when the
 * English genuinely cannot be translated and is not a term.
 */
export const allowedEnglishResidueKeysByLocale: Record<string, readonly string[]> = {};

const WORD_PATTERN = /\p{L}[\p{L}\p{N}_'’-]*/gu;

function contentWords(value: string): string[] {
    return (stripAllowedEnglishTerms(value).match(WORD_PATTERN) ?? []).map((word) => word.toLowerCase());
}

/** English function words still present in `translated` that also occur in its English source. */
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

// ---------------------------------------------------------------------------
// Quick-add and search command tokens
// ---------------------------------------------------------------------------
//
// `/due:`, `/next`, `/* focus`, `/area:` are parser syntax, identical in every locale, and
// the help copy is where a user learns them. When English gains a token (`/* focus` landed
// in en.ts and ten locales kept listing the old set) or a translation paraphrases one away
// (fr rewrote "/v1/data" as "/api/v1" in the self-hosted hint), the sentence still reads as
// a fluent translation to every other check here. So: every slash token in the English
// source must appear verbatim in the translation. Paths count too (`/v1/data`), because a
// wrong path is the same class of defect for the user who types it.
const SLASH_COMMAND_TOKEN_PATTERN = /(?<![\p{L}\p{N}/.:])\/(?:\*|[a-z][a-z0-9]*:?)/gu;

export function slashCommandTokens(value: string): string[] {
    return [...new Set(value.match(SLASH_COMMAND_TOKEN_PATTERN) ?? [])];
}

/** Slash tokens the English source lists that the translation no longer contains. */
export function missingSlashCommandTokens(translated: string, english: string): string[] {
    const present = new Set(slashCommandTokens(translated));
    return slashCommandTokens(english).filter((token) => !present.has(token));
}

// ---------------------------------------------------------------------------
// Quoted UI labels
// ---------------------------------------------------------------------------
//
// Help text tells the user which button to press by quoting its label: `tap "Export Backup"`.
// A translation that keeps the English label in the quotes while the button itself is
// translated under its own key ("Exportar copia de seguridad") sends the user looking for a
// button that does not exist. es shipped three such strings with every gate green. The
// signal: a quoted fragment that equals the English value of another key which this locale
// translates to something else. A key the locale leaves untranslated still shows the
// English label on screen, so quoting it in English is correct and is not flagged.
//
// Labels of four characters or fewer are skipped: "Auto", "Sync", "Done" also match an
// ordinary word inside a sentence, and the measured hit on de was exactly that.
const QUOTED_LABEL_PATTERN = /["“«„「]([^"”»“」]{5,60})["”»“」]/g;
const QUOTED_LABEL_MAX_LENGTH = 40;

/** Quoted English labels in `translated` whose own key this locale translates differently. */
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
        // Correct as long as ANY key with that label still shows it: kept verbatim, or
        // untranslated and therefore rendered as the English fallback.
        const stillShown = labelKeys.some((other) => translations[other] === undefined || translations[other] === label);
        if (!stillShown) found.push(label);
    }
    return found;
}
