import * as chrono from 'chrono-node';
import { format, isValid, set } from 'date-fns';
import type { Area, Attachment, Person, Project, Task, TaskEnergyLevel, TaskStatus } from './types';
import { generateUUID } from './uuid';
import { normalizeTaskStatus } from './task-status';
import { normalizeLinkAttachmentInput } from './attachment-link-utils';
import { getActiveLanguage, getMonthNamesForLanguage, isActiveDateFormatDayFirst, normalizeClockTimeInput } from './date';
import type { Language } from './i18n/i18n-types';
import { getUsedTaskTokens } from './task-token-usage';
import { getPersonOptionNames } from './people';

// The live capture preview rides this module's barrel line
// (`export * from './quick-add'`) rather than its own: Metro collapses subpath
// imports, so anything the mobile app imports has to reach it through the core
// index, and index.ts is not this feature's to edit. The logic itself stays in
// its own file — nothing here parses or formats for display.
export {
    buildQuickAddPreviewEntries,
    type QuickAddPreviewEntry,
    type QuickAddPreviewEntryKind,
    type QuickAddPreviewOptions,
    type QuickAddPreviewOverrides,
} from './quick-add-preview';

export interface QuickAddDetectedDate {
    date: string;
    matchedText: string;
    titleWithoutDate: string;
}

export interface QuickAddResult {
    title: string;
    props: Partial<Task>;
    projectTitle?: string;
    invalidDateCommands?: string[];
    detectedDate?: QuickAddDetectedDate;
}

export interface QuickAddParseOptions {
    knownContexts?: readonly string[];
    knownTags?: readonly string[];
    knownPeople?: readonly string[];
    defaultScheduleTime?: string | null;
    // When true, keep the user's text exactly as entered: recognized metadata
    // (dates, tags, contexts, ...) is still detected and applied, but never
    // stripped out of the title. Default strips recognized tokens. See #742.
    preserveText?: boolean;
    // When false, skip detection of BARE natural-language dates ("next week")
    // in the title entirely — the phrase stays as literal title text, never
    // applied as a date. Explicit syntax (/due:, /start:, /review:, including
    // natural-language values like "/due:next week") always keeps parsing
    // regardless of this option. Default true = current detection behavior.
    // See #742 (2026-07-16 comment).
    naturalLanguageDates?: boolean;
}

// Single source of truth for the default-on semantics: only an explicit
// `false` disables bare natural-language date detection; unset keeps it on.
export function isNaturalLanguageDatesEnabled(
    settings?: { gtd?: { naturalLanguageDates?: boolean } } | null,
): boolean {
    return settings?.gtd?.naturalLanguageDates !== false;
}

/** The settings a capture surface reads to configure quick-add parsing. */
export interface QuickAddParseSettings {
    quickAddAutoClean?: boolean;
    gtd?: {
        defaultScheduleTime?: string | null;
        naturalLanguageDates?: boolean;
    };
}

/** Everything the bag is derived from; `useTaskStore.getState()` satisfies it. */
export interface QuickAddParseSource {
    tasks?: Task[];
    people?: readonly Person[];
}

/**
 * Assemble the quick-add parse options — the one place capture surfaces get
 * them from. Hand-rolled bags drifted: every field is optional, so a surface
 * that forgot `knownPeople` still compiled and silently captured `%John Smith`
 * as `%John` while the surface next door resolved it to the known person.
 */
export function buildQuickAddParseOptions(
    settings?: QuickAddParseSettings | null,
    source: QuickAddParseSource = {},
): QuickAddParseOptions {
    const tasks = source.tasks ?? [];
    return {
        knownContexts: getUsedTaskTokens(tasks, (task) => task.contexts, { prefix: '@' }),
        knownTags: getUsedTaskTokens(tasks, (task) => task.tags, { prefix: '#' }),
        knownPeople: getPersonOptionNames(source.people, tasks),
        defaultScheduleTime: normalizeClockTimeInput(settings?.gtd?.defaultScheduleTime) || undefined,
        preserveText: settings?.quickAddAutoClean !== true,
        naturalLanguageDates: isNaturalLanguageDatesEnabled(settings),
    };
}

export function getQuickAddProjectInitialProps(
    props: Partial<Task>,
    fallbackAreaId?: string | null
): Pick<Project, 'areaId'> | undefined {
    const parsedAreaId = typeof props.areaId === 'string' ? props.areaId.trim() : '';
    const fallback = typeof fallbackAreaId === 'string' ? fallbackAreaId.trim() : '';
    const areaId = parsedAreaId || fallback;
    return areaId ? { areaId } : undefined;
}

export interface ProjectNextActionParseContext {
    projectId: string;
    sectionId?: string | null;
    projects?: Project[];
    areas?: Area[];
    now?: Date;
    parseOptions?: QuickAddParseOptions;
}

/**
 * Parse the "What's the next action?" prompt input with the quick-add
 * grammar, so tokens like `/waiting`, `@context`, or `/due:` work there the
 * same way they do in the quick-add box (#859).
 *
 * The prompt is scoped to one project: parsed tokens win over the prompt's
 * defaults, an existing `+project` token may retarget (dropping the prompt's
 * section), but unknown project names never create projects from here — the
 * token is kept as title text instead.
 */
export function parseProjectNextActionInput(
    input: string,
    context: ProjectNextActionParseContext,
): { title: string; props: Partial<Task>; invalidDateCommands?: string[] } {
    const { projectId, sectionId, projects, areas, now = new Date(), parseOptions } = context;
    const parsed = parseQuickAdd(input, projects, now, areas, parseOptions);
    const props: Partial<Task> = { ...parsed.props };
    let title = parsed.title;
    // Not applied — the prompt never creates projects — so the token goes back
    // into the title as the text it now is.
    if (parsed.projectTitle) {
        const token = /\s/.test(parsed.projectTitle) ? `+"${parsed.projectTitle}"` : `+${parsed.projectTitle}`;
        title = `${title} ${token}`.trim();
    }
    if (typeof props.projectId !== 'string' || !props.projectId.trim()) {
        props.projectId = projectId;
    }
    if (props.projectId === projectId && typeof sectionId === 'string' && sectionId) {
        props.sectionId = sectionId;
    }
    if (!props.status) {
        props.status = 'next';
    }
    return { title: title || input.trim(), props, invalidDateCommands: parsed.invalidDateCommands };
}

export interface ProcessInboxTitleParseContext {
    projects?: Project[];
    areas?: Area[];
    now?: Date;
    parseOptions?: QuickAddParseOptions;
}

/**
 * Parse an Inbox-processing title with the quick-add grammar, so `@context`,
 * `#tag`, `!Area`, `+Project`, `%Person`, `/energy:` and the date commands work
 * while clarifying exactly as they do at capture (#1088). Processing used to
 * run `parseQuickAddDateCommands` alone, which made it the one editable task
 * title in the app with its own smaller grammar.
 *
 * Two rules keep the clarify workflow in charge of the decision it exists to
 * make:
 * - A status token (`/waiting`, `/done`, ...) is consumed and dropped. The
 *   destination the user picks owns the status, so a stale token typed at
 *   capture cannot silently overrule the button they just pressed.
 * - An unknown `+Name` never creates a project. Processing has its own picker
 *   and a "turn this into a project" step, so the token goes back into the
 *   title as the text it now is — same rule as the next-action prompt.
 */
export function parseProcessInboxTitleInput(
    input: string,
    context: ProcessInboxTitleParseContext = {},
): { title: string; props: Partial<Task>; invalidDateCommands?: string[] } {
    const { projects, areas, now = new Date(), parseOptions } = context;
    const parsed = parseQuickAdd(input, projects, now, areas, parseOptions);
    let title = parsed.title;
    if (parsed.projectTitle) {
        const token = /\s/.test(parsed.projectTitle) ? `+"${parsed.projectTitle}"` : `+${parsed.projectTitle}`;
        title = `${title} ${token}`.trim();
    }
    const props: Partial<Task> = { ...parsed.props };
    delete props.status;
    return { title, props, invalidDateCommands: parsed.invalidDateCommands };
}

export interface QuickAddDateCommandsResult {
    title: string;
    props: Pick<Partial<Task>, 'startTime' | 'dueDate' | 'reviewAt'>;
    invalidDateCommands?: string[];
}

export function splitQuickAddBulkLines(input: string): string[] {
    const normalized = String(input || '').replace(/\r\n?/g, '\n');
    const lines = normalized
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    return lines.length > 0 && /\n[ \t]*\n/.test(normalized) ? [lines.join(' ')] : lines;
}

const STATUS_TOKENS: Record<string, TaskStatus> = {
    inbox: 'inbox',
    next: 'next',
    waiting: 'waiting',
    someday: 'someday',
    reference: 'reference',
    done: 'done',
};

const ENERGY_TOKENS: Record<string, TaskEnergyLevel> = {
    low: 'low',
    medium: 'medium',
    high: 'high',
};

const ESCAPE_SENTINEL = '__MW_ESC__';
const QUICK_ADD_ESCAPE_CHARS = new Set(['@', '#', '+', '/', '!', '%']);
const QUICK_ADD_FOCUS_COMMAND_PATTERN = String.raw`\*(?:\s+focus\b)?`;
// A command only counts at the start of a word. Applied tokens are now cut
// from the title whatever `quickAddAutoClean` says, so a substring match
// would corrupt real text — `https://example.com/next-steps` is a link, not
// a status.
const QUICK_ADD_COMMAND_START = String.raw`(?:^|\s)`;
const QUICK_ADD_COMMAND_BOUNDARY = String.raw`(?=\s\/(?:${QUICK_ADD_FOCUS_COMMAND_PATTERN}|link:|note:|start:|due:|review:|project:|area:|energy:|inbox\b|next\b|in-progress\b|waiting\b|someday\b|done\b|archived\b)|$)`;
const QUICK_ADD_INLINE_CONTROL_BOUNDARY = String.raw`(?=\s(?:[@#+!%]|\/(?:${QUICK_ADD_FOCUS_COMMAND_PATTERN}|link:|note:|start:|due:|review:|project:|area:|energy:|inbox\b|next\b|in-progress\b|waiting\b|someday\b|done\b|archived\b))|$)`;
const SIMPLE_TASK_TOKEN_RE = /[@#][\p{L}\p{N}_-]+/gu;
const RICH_TASK_TOKEN_RE = new RegExp(
    String.raw`(?:^|\s)([@#](?![\s\p{L}\p{N}_-])[^@#+/!%]+?)${QUICK_ADD_INLINE_CONTROL_BOUNDARY}`,
    'gu',
);
const NATURAL_TIME_HINT_RE = /\b(?:\d{1,2}:\d{2}(?:\s*[ap]m)?|\d{1,2}\s*[ap]m|noon|midnight|morning|afternoon|evening|night|tonight)\b/i;
const PURE_TIME_ONLY_RE = /^(?:at\s+)?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midnight)$/i;
const BARE_MONTH_RE = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/i;
const TRAILING_DATE_SUFFIX_RE = /^[\s).,!?:;'"\]]*$/u;
const TRAILING_DATE_SEPARATOR_RE = /[\s,;:()[\]{}\-–—]+$/u;

function protectEscapes(input: string): string {
    let result = '';
    for (let i = 0; i < input.length; i += 1) {
        const ch = input[i];
        if (ch === '\\' && i + 1 < input.length) {
            const next = input[i + 1];
            if (QUICK_ADD_ESCAPE_CHARS.has(next)) {
                result += `${ESCAPE_SENTINEL}${next.charCodeAt(0)}__`;
                i += 1;
                continue;
            }
        }
        result += ch;
    }
    return result;
}

function restoreEscapes(input: string): string {
    return input.replace(new RegExp(`${ESCAPE_SENTINEL}(\\d+)__`, 'g'), (_, code) =>
        String.fromCharCode(Number(code)),
    );
}

type DateDefaultTimeMode = 'now' | 'startOfDay';

// European dot dates are inherently day-first, so they carry none of the
// mm/dd vs dd/mm ambiguity of slash dates. Requiring the convention's trailing
// dot ("26.06.") or a four-digit year ("26.06.2026") keeps version strings
// like "python 3.12" from parsing as dates; a bare "26.06" stays literal text.
// (No lookbehind — the boundary check runs in extract() — because older
// WKWebView builds lack lookbehind support.)
const dotDateParser: chrono.Parser = {
    pattern: () => /(\d{1,2})\.(\d{1,2})\.(\d{4})?(?=[\s,;:!?)\]]|$)/,
    extract: (context, match) => {
        const index = match.index ?? 0;
        const before = index > 0 ? context.text[index - 1] : '';
        if (before && !/[\s(,[]/.test(before)) return null;
        const day = Number.parseInt(match[1] ?? '', 10);
        const month = Number.parseInt(match[2] ?? '', 10);
        if (day < 1 || day > 31 || month < 1 || month > 12) return null;
        const components: { day: number; month: number; year?: number } = { day, month };
        if (match[3]) components.year = Number.parseInt(match[3], 10);
        return components;
    },
};

const quickAddChrono = chrono.casual.clone();
quickAddChrono.parsers.push(dotDateParser);

// chrono.en.GB is the casual configuration in little-endian mode, so ambiguous
// slash dates ("10/8") read day-first. Selected per parse from the active date
// format so `/due:10/8` means August 10 under a d/m/y setting (#1006).
const quickAddChronoDayFirst = chrono.en.GB.clone();
quickAddChronoDayFirst.parsers.push(dotDateParser);

const getQuickAddChrono = (): chrono.Chrono => (
    isActiveDateFormatDayFirst() ? quickAddChronoDayFirst : quickAddChrono
);

// chrono-node locale parsers for the app languages it natively supports
// (#1059). Every other app language (en, and any without a chrono locale)
// keeps today's English-only behavior via the fallback in parseNaturalDate /
// detectTrailingDate below.
type LocaleChronoLanguage = 'de' | 'es' | 'fr' | 'it' | 'ja' | 'nl' | 'pt' | 'ru' | 'sv' | 'zh' | 'zh-Hant';
const LOCALE_CHRONO_FACTORY: Record<LocaleChronoLanguage, () => chrono.Chrono> = {
    de: () => chrono.de.casual.clone(),
    es: () => chrono.es.casual.clone(),
    fr: () => chrono.fr.casual.clone(),
    it: () => chrono.it.casual.clone(),
    ja: () => chrono.ja.casual.clone(),
    nl: () => chrono.nl.casual.clone(),
    pt: () => chrono.pt.casual.clone(),
    ru: () => chrono.ru.casual.clone(),
    sv: () => chrono.sv.casual.clone(),
    zh: () => chrono.zh.hans.casual.clone(),
    'zh-Hant': () => chrono.zh.hant.casual.clone(),
};
const localeChronoCache = new Map<LocaleChronoLanguage, chrono.Chrono>();

function isLocaleChronoLanguage(language: Language): language is LocaleChronoLanguage {
    // Own-property check: `in` would also admit prototype keys like
    // 'constructor' if a corrupted settings value slipped through upstream.
    return Object.prototype.hasOwnProperty.call(LOCALE_CHRONO_FACTORY, language);
}

/** The active language's chrono instance, or null when it has no locale parser (falls back to English). */
function getLocaleQuickAddChrono(): chrono.Chrono | null {
    const language = getActiveLanguage();
    if (!isLocaleChronoLanguage(language)) return null;
    let instance = localeChronoCache.get(language);
    if (!instance) {
        instance = LOCALE_CHRONO_FACTORY[language]();
        instance.parsers.push(dotDateParser);
        localeChronoCache.set(language, instance);
    }
    return instance;
}

// The es/fr/pt/it chrono parsers leave the words that introduce a date out of
// the match ("el próximo viernes" matches "próximo viernes"), so a cleaned
// title would keep a dangling "el". Only these four need the list: de/nl/ru/sv
// take the preposition into the match themselves.
const TRAILING_DATE_INTRO_WORDS: Partial<Record<Language, ReadonlySet<string>>> = {
    es: new Set(['el', 'la', 'los', 'las', 'al', 'del', 'de', 'para', 'próximo', 'próxima']),
    fr: new Set(['le', 'la', 'les', 'du', 'au', 'aux', 'pour', 'prochain', 'prochaine']),
    pt: new Set(['na', 'no', 'da', 'do', 'em', 'de', 'dia', 'para', 'próxima', 'próximo']),
    it: new Set(['il', 'lo', 'la', 'al', 'per', 'di', 'prossimo', 'prossima']),
};

/**
 * Drop the date-introducing words the locale parser excluded from its match.
 * Only words standing directly ahead of the matched date go — a title that
 * merely contains one keeps it ("Comprar leche del super mañana") — and the
 * first word never goes, so the title can't be emptied out from here.
 */
function stripTrailingDateIntroWords(title: string, language: Language): string {
    const words = TRAILING_DATE_INTRO_WORDS[language];
    if (!words) return title;
    let result = title;
    for (let space = result.lastIndexOf(' '); space > 0; space = result.lastIndexOf(' ')) {
        if (!words.has(result.slice(space + 1).toLowerCase())) break;
        result = result.slice(0, space).replace(TRAILING_DATE_SEPARATOR_RE, '');
    }
    return result;
}

const localizedMonthNamesCache = new Map<Language, Set<string>>();

function normalizeMonthToken(value: string): string {
    return value.trim().toLowerCase().replace(/\.$/, '');
}

/** Whether matchedText is a bare month name in the given language — English uses the static regex, others the date-fns locale table. */
function isBareMonthName(matchedText: string, language: Language): boolean {
    if (language === 'en') return BARE_MONTH_RE.test(matchedText);
    let names = localizedMonthNamesCache.get(language);
    if (!names) {
        names = new Set(getMonthNamesForLanguage(language).map(normalizeMonthToken));
        localizedMonthNamesCache.set(language, names);
    }
    return names.has(normalizeMonthToken(matchedText));
}

type DateCommandParseOptions = {
    defaultScheduleTime?: string | null;
};

type ParsedNaturalDate = {
    date: Date;
    hasExplicitTime: boolean;
};

function buildDefaultDate(now: Date, defaultTimeMode: DateDefaultTimeMode): Date {
    const fallbackHour = defaultTimeMode === 'startOfDay' ? 0 : now.getHours();
    const fallbackMinute = defaultTimeMode === 'startOfDay' ? 0 : now.getMinutes();
    return set(new Date(now), { hours: fallbackHour, minutes: fallbackMinute, seconds: 0, milliseconds: 0 });
}

function parseDefaultScheduleTime(value?: string | null): { hours: number; minutes: number } | null {
    const normalized = normalizeClockTimeInput(value);
    if (!normalized) return null;
    const [hours, minutes] = normalized.split(':').map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    return { hours, minutes };
}

function applyDefaultScheduleTime(
    parsed: ParsedNaturalDate,
    defaultScheduleTime?: string | null,
): ParsedNaturalDate {
    if (parsed.hasExplicitTime) return parsed;
    const clock = parseDefaultScheduleTime(defaultScheduleTime);
    if (!clock) return parsed;
    return {
        // The applied default is a real clock time; without this the value
        // below would store date-only and drop the configured time.
        hasExplicitTime: true,
        date: set(parsed.date, { hours: clock.hours, minutes: clock.minutes, seconds: 0, milliseconds: 0 }),
    };
}

function hasNaturalTimeHint(text: string): boolean {
    return NATURAL_TIME_HINT_RE.test(text);
}

function resolveChronoDate(
    result: chrono.ParsedResult,
    now: Date,
    defaultTimeMode: DateDefaultTimeMode,
): ParsedNaturalDate | null {
    let parsed = result.start.date();
    if (!isValid(parsed)) return null;
    const hasExplicitTime = result.start.isCertain('hour') || hasNaturalTimeHint(result.text);

    if (!hasExplicitTime) {
        const fallbackHour = defaultTimeMode === 'startOfDay' ? 0 : now.getHours();
        const fallbackMinute = defaultTimeMode === 'startOfDay' ? 0 : now.getMinutes();
        parsed = set(parsed, { hours: fallbackHour, minutes: fallbackMinute, seconds: 0, milliseconds: 0 });
    } else {
        parsed = set(parsed, { seconds: 0, milliseconds: 0 });
    }

    return isValid(parsed) ? { date: parsed, hasExplicitTime } : null;
}

// chrono's locale bundles ship a single numeric order each (day-first for
// de/es/fr/pt, month-first for it/ja) and no way to flip it, while the English
// instances already follow the date-format setting (#1006). A letter-free
// value like "10/8" carries no locale signal, so those decide it; anything
// with words stays the locale parser's call.
const CONTAINS_LETTER_RE = /\p{L}/u;

function orderedChronoInstances(text: string): chrono.Chrono[] {
    const localeChrono = getLocaleQuickAddChrono();
    if (!localeChrono) return [getQuickAddChrono()];
    return CONTAINS_LETTER_RE.test(text)
        ? [localeChrono, getQuickAddChrono()]
        : [getQuickAddChrono(), localeChrono];
}

// A result only counts if it spans the whole input — used for both the
// locale attempt and the English fallback so the acceptance rule lives once.
function parseWholeTextResult(chronoInstance: chrono.Chrono, text: string, now: Date): chrono.ParsedResult | null {
    const results = chronoInstance.parse(text, { instant: now }, { forwardDate: true });
    const result = results[0];
    if (!result) return null;
    const matchedEnd = result.index + result.text.length;
    if (result.index !== 0 || matchedEnd !== text.length) return null;
    return result;
}

function parseNaturalDate(raw: string, now: Date, defaultTimeMode: DateDefaultTimeMode = 'now'): ParsedNaturalDate | null {
    const text = raw.trim();
    if (!text) return { date: buildDefaultDate(now, defaultTimeMode), hasExplicitTime: defaultTimeMode === 'now' };

    for (const instance of orderedChronoInstances(text)) {
        const result = parseWholeTextResult(instance, text, now);
        const parsed = result && resolveChronoDate(result, now, defaultTimeMode);
        if (parsed) return parsed;
    }
    return null;
}

function formatDueDateValue(parsed: ParsedNaturalDate): string {
    return parsed.hasExplicitTime ? parsed.date.toISOString() : format(parsed.date, 'yyyy-MM-dd');
}

// Reverse-scan acceptance loop shared by the locale pass and the English
// fallback pass; `language` picks which bare-month check the results were
// produced under (the active language for a locale pass, English otherwise).
function findTrailingDateInResults(
    results: chrono.ParsedResult[],
    trimmed: string,
    now: Date,
    language: Language,
): QuickAddDetectedDate | undefined {
    for (let index = results.length - 1; index >= 0; index -= 1) {
        const result = results[index];
        const matchedText = result.text.trim();
        const suffix = trimmed.slice(result.index + result.text.length);
        if (!matchedText || !TRAILING_DATE_SUFFIX_RE.test(suffix)) continue;
        if (PURE_TIME_ONLY_RE.test(matchedText) || isBareMonthName(matchedText, language)) continue;

        const beforeDate = trimmed.slice(0, result.index).replace(TRAILING_DATE_SEPARATOR_RE, '').trim();
        // Always the active language, never the pass's: an English-instance
        // match ("10/8") still sits in a Spanish title that ends in "el".
        const titleWithoutDate = stripTrailingDateIntroWords(beforeDate, getActiveLanguage());
        if (!titleWithoutDate) continue;

        const parsed = resolveChronoDate(result, now, 'now');
        if (!parsed) continue;

        return {
            date: formatDueDateValue(parsed),
            matchedText,
            titleWithoutDate,
        };
    }

    return undefined;
}

function detectTrailingDate(title: string, now: Date): QuickAddDetectedDate | undefined {
    const trimmed = title.trim();
    if (!trimmed) return undefined;

    const localeChrono = getLocaleQuickAddChrono();
    let localeDetected: QuickAddDetectedDate | undefined;
    if (localeChrono) {
        const localeResults = localeChrono.parse(trimmed, { instant: now }, { forwardDate: true });
        localeDetected = findTrailingDateInResults(localeResults, trimmed, now, getActiveLanguage());
        // Same rule as parseNaturalDate: a letter-free match is the English
        // instances' call because only they follow the date-format setting.
        if (localeDetected && CONTAINS_LETTER_RE.test(localeDetected.matchedText)) return localeDetected;
    }

    const results = getQuickAddChrono().parse(trimmed, { instant: now }, { forwardDate: true });
    return findTrailingDateInResults(results, trimmed, now, 'en') ?? localeDetected;
}

function stripToken(source: string, token: string): string {
    return source.replace(token, '').replace(/\s{2,}/g, ' ').trim();
}

type QuickAddTokenMatch = {
    token: string;
    raw: string;
    index: number;
    end: number;
};

function normalizeKnownQuickAddToken(token: string, prefix: '@' | '#'): string | null {
    const trimmed = restoreEscapes(String(token || '')).replace(/\s+/g, ' ').trim();
    if (!trimmed || trimmed === prefix) return null;
    return trimmed.startsWith(prefix) ? trimmed : `${prefix}${trimmed}`;
}

function isQuickAddTokenStartBoundary(working: string, index: number): boolean {
    return index === 0 || /\s/u.test(working[index - 1] ?? '');
}

function isQuickAddTokenEndBoundary(working: string, index: number): boolean {
    if (index >= working.length) return true;
    const ch = working[index] ?? '';
    return /\s/u.test(ch) || !/[\p{L}\p{N}_-]/u.test(ch);
}

function pushQuickAddQuotedTokenMatches(working: string, prefix: '@' | '#', matches: QuickAddTokenMatch[]) {
    // Same typographic-quote tolerance as matchQuickAddQuotedName (#849, #1094):
    // smart punctuation substitutes curly quotes as the user types — macOS even
    // picks the CLOSING glyph (”) right after @/#, since a symbol precedes it —
    // so any curly double works as the opener.
    const quotedRe = /(?:^|\s)([@#])(?:"((?:\\.|[^"\\])*)"|[“”„]([^"“”]*)["“”])/gu;
    for (const match of working.matchAll(quotedRe)) {
        if (match[1] !== prefix) continue;
        const rawOffset = match[0].indexOf(prefix);
        if (rawOffset < 0) continue;
        const index = (match.index ?? 0) + rawOffset;
        const raw = match[0].slice(rawOffset);
        const value = (match[2] ?? match[3] ?? '').replace(/\\(["\\])/g, '$1').replace(/\s+/g, ' ').trim();
        if (!value) continue;
        matches.push({
            token: `${prefix}${restoreEscapes(value)}`,
            raw,
            index,
            end: index + raw.length,
        });
    }
}

function pushQuickAddKnownTokenMatches(
    working: string,
    prefix: '@' | '#',
    knownTokens: readonly string[] | undefined,
    matches: QuickAddTokenMatch[],
) {
    if (!knownTokens?.length) return;
    const candidates = Array.from(
        new Set(
            knownTokens
                .map((token) => normalizeKnownQuickAddToken(token, prefix))
                .filter((token): token is string => Boolean(token))
        )
    ).sort((a, b) => b.length - a.length);
    if (candidates.length === 0) return;

    const lowerWorking = working.toLowerCase();
    for (let index = 0; index < working.length; index += 1) {
        if (working[index] !== prefix || !isQuickAddTokenStartBoundary(working, index)) continue;
        const candidate = candidates.find((token) => {
            if (lowerWorking.slice(index, index + token.length) !== token.toLowerCase()) return false;
            return isQuickAddTokenEndBoundary(working, index + token.length);
        });
        if (!candidate) continue;
        matches.push({
            token: candidate,
            raw: working.slice(index, index + candidate.length),
            index,
            end: index + candidate.length,
        });
    }
}

function getQuickAddTokenMatches(
    working: string,
    prefix: '@' | '#',
    knownTokens?: readonly string[],
): QuickAddTokenMatch[] {
    const matches: QuickAddTokenMatch[] = [];

    pushQuickAddQuotedTokenMatches(working, prefix, matches);
    pushQuickAddKnownTokenMatches(working, prefix, knownTokens, matches);

    for (const match of working.matchAll(SIMPLE_TASK_TOKEN_RE)) {
        const token = match[0];
        if (token.startsWith(prefix)) {
            const index = match.index ?? 0;
            // A marker only opens a token at a word start (#1087). Without this
            // the `@` inside `bob@example.com` became the context `@example` and
            // tore the address out of the title — and a `#fragment` in a pasted
            // URL became a tag. Every other matcher here (quoted, known, rich)
            // already requires this boundary; this one was the outlier.
            if (!isQuickAddTokenStartBoundary(working, index)) continue;
            matches.push({
                token: restoreEscapes(token),
                raw: token,
                index,
                end: index + token.length,
            });
        }
    }

    for (const match of working.matchAll(RICH_TASK_TOKEN_RE)) {
        const token = match[1]?.replace(/\s+/g, ' ').trim();
        if (token?.startsWith(prefix)) {
            const rawIndex = match.index ?? 0;
            const index = rawIndex + match[0].indexOf(match[1]);
            matches.push({
                token: restoreEscapes(token),
                raw: match[1] ?? token,
                index,
                end: index + (match[1]?.length ?? token.length),
            });
        }
    }

    let lastEnd = -1;
    return matches
        .sort((a, b) => (a.index - b.index) || (b.end - b.index) - (a.end - a.index))
        .filter((match) => {
            if (match.index < lastEnd) return false;
            lastEnd = match.end;
            return true;
        });
}

type QuickAddNamePrefixMatch = {
    consumedRaw: string;
    value: string;
};

function normalizeQuickAddName(name: string): string {
    return name.replace(/\s+/g, ' ').trim().toLowerCase();
}

// Given the raw text captured after a `+`/`!` marker (which greedily spans
// following words), find the longest known entity name that matches a
// whole-word prefix, so trailing title words are not swallowed into the token.
function matchKnownQuickAddNamePrefix(
    rawToken: string,
    knownNames: readonly string[],
): QuickAddNamePrefixMatch | null {
    if (knownNames.length === 0) return null;
    const normalizedKnown = new Set(knownNames.map(normalizeQuickAddName));
    const words = Array.from(rawToken.matchAll(/\S+/gu));
    for (let count = words.length; count >= 1; count -= 1) {
        const lastWord = words[count - 1];
        const end = (lastWord.index ?? 0) + lastWord[0].length;
        const consumedRaw = rawToken.slice(0, end);
        const value = restoreEscapes(consumedRaw).replace(/\s+/g, ' ').trim();
        if (normalizedKnown.has(normalizeQuickAddName(value))) {
            return { consumedRaw, value };
        }
    }
    return null;
}

function matchQuickAddQuotedName(working: string, marker: '+' | '!' | '%'): { raw: string; value: string } | null {
    const escapedMarker = marker === '+' ? String.raw`\+` : marker;
    // Mobile and desktop keyboards substitute typographic quotes as you type
    // (iOS smart punctuation, German layouts, autocorrect fixing only one of
    // the pair), so accept the common quote styles and mixed pairs — a name
    // that parses when pasted must also parse as typed (#849):
    //   "..."  straight doubles, with backslash escapes (canonical form)
    //   “...”  or mixed “..."  curly/straight doubles — macOS also produces a
    //          CLOSING glyph as the opener (”...”), since the marker character
    //          before the quote reads as "not a word start" to smart
    //          punctuation (#1094)
    //   „..."  German low-9 opening with any double-quote close
    //   '...'  straight singles
    //   ‘...’  or ’...’  smart singles
    const match = working.match(new RegExp(
        String.raw`(?:^|\s)${escapedMarker}(?:"((?:\\.|[^"\\])*)"|[“”]([^"”]*)["”]|„([^"“”]*)["“”]|'([^']*)'|[‘’]([^’]*)’)`,
        'u',
    ));
    if (!match) return null;
    const rawOffset = match[0].indexOf(marker);
    if (rawOffset < 0) return null;
    const value = restoreEscapes(
        (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '').replace(/\\(["\\])/g, '$1'),
    ).replace(/\s+/g, ' ').trim();
    if (!value) return null;
    return { raw: match[0].slice(rawOffset), value };
}

function parseDateCommand(
    command: 'start' | 'due' | 'review',
    working: string,
    now: Date,
    options: DateCommandParseOptions = {},
): { value?: string; working: string; invalidCommand?: string } {
    const match = working.match(new RegExp(`${QUICK_ADD_COMMAND_START}\\/${command}:([\\s\\S]+?)${QUICK_ADD_COMMAND_BOUNDARY}`, 'i'));
    if (!match) return { working };

    const dateText = match[1].trim();
    const defaultTimeMode: DateDefaultTimeMode = command === 'due' ? 'now' : 'startOfDay';
    const parsedNaturalDate = parseNaturalDate(dateText, now, defaultTimeMode);
    const parsed = parsedNaturalDate && command !== 'due'
        ? applyDefaultScheduleTime(parsedNaturalDate, options.defaultScheduleTime)
        : parsedNaturalDate;
    if (!parsed) {
        return {
            working,
            invalidCommand: `/${command}:${dateText}`,
        };
    }
    const nextWorking = stripToken(working, match[0]);
    return {
        // Timeless values stay date-only for every command — a blank default
        // schedule time must not stamp midnight on /start: or /review: (#797),
        // matching the GUI pickers (joinDateTime in date-draft.ts).
        value: formatDueDateValue(parsed),
        working: nextWorking,
    };
}

function parseDateCommandsFromWorking(
    working: string,
    now: Date,
    options: DateCommandParseOptions = {},
): {
    working: string;
    startTime?: string;
    dueDate?: string;
    reviewAt?: string;
    invalidDateCommands?: string[];
} {
    const invalidDateCommands: string[] = [];

    const startResult = parseDateCommand('start', working, now, options);
    const startTime = startResult.value;
    if (startResult.invalidCommand) invalidDateCommands.push(startResult.invalidCommand);
    working = startResult.working;

    const dueResult = parseDateCommand('due', working, now);
    const dueDate = dueResult.value;
    if (dueResult.invalidCommand) invalidDateCommands.push(dueResult.invalidCommand);
    working = dueResult.working;

    const reviewResult = parseDateCommand('review', working, now, options);
    const reviewAt = reviewResult.value;
    if (reviewResult.invalidCommand) invalidDateCommands.push(reviewResult.invalidCommand);
    working = reviewResult.working;

    return {
        working,
        startTime,
        dueDate,
        reviewAt,
        invalidDateCommands: invalidDateCommands.length > 0 ? invalidDateCommands : undefined,
    };
}

function buildQuickAddLinkAttachment(input: string, now: Date): Attachment | null {
    const normalized = normalizeLinkAttachmentInput(input);
    if (!normalized.uri.trim()) return null;
    const createdAt = now.toISOString();
    return {
        id: generateUUID(),
        kind: 'link',
        title: normalized.title,
        uri: normalized.uri,
        createdAt,
        updatedAt: createdAt,
    };
}

function parseLinkCommandsFromWorking(
    working: string,
    now: Date,
): { attachments?: Attachment[]; working: string } {
    const attachments: Attachment[] = [];
    const linkCommandRe = new RegExp(`${QUICK_ADD_COMMAND_START}\\/link:([\\s\\S]*?)${QUICK_ADD_COMMAND_BOUNDARY}`, 'i');

    let nextWorking = working;
    while (true) {
        const match = nextWorking.match(linkCommandRe);
        if (!match) break;

        const rawLink = restoreEscapes(match[1].trim());
        const attachment = rawLink ? buildQuickAddLinkAttachment(rawLink, now) : null;
        if (attachment) attachments.push(attachment);

        const stripped = stripToken(nextWorking, match[0]);
        if (stripped === nextWorking) break;
        nextWorking = stripped;
    }

    return {
        attachments: attachments.length > 0 ? attachments : undefined,
        working: nextWorking,
    };
}

export function parseQuickAddDateCommands(
    input: string,
    now: Date = new Date(),
    options: Pick<QuickAddParseOptions, 'preserveText' | 'defaultScheduleTime'> = {},
): QuickAddDateCommandsResult {
    const protectedInput = protectEscapes(input.trim());
    const {
        working,
        startTime,
        dueDate,
        reviewAt,
        invalidDateCommands,
    } = parseDateCommandsFromWorking(protectedInput, now, options);

    return {
        // /due:, /start: and /review: are explicit commands, so they leave the
        // title even with cleanup off (#feedback 884b0fe0).
        title: restoreEscapes(working.replace(/\s{2,}/g, ' ').trim()),
        props: {
            ...(startTime ? { startTime } : {}),
            ...(dueDate ? { dueDate } : {}),
            ...(reviewAt ? { reviewAt } : {}),
        },
        invalidDateCommands,
    };
}

export function parseQuickAdd(
    input: string,
    projects?: Project[],
    now: Date = new Date(),
    areas?: Area[],
    options: QuickAddParseOptions = {},
): QuickAddResult {
    let working = protectEscapes(input.trim());
    const preserveText = options.preserveText === true;
    const hadExplicitDueCommand = /(?:^|\s)\/due:/i.test(working);

    const contexts = new Set<string>();
    const tags = new Set<string>();

    const linkResult = parseLinkCommandsFromWorking(working, now);
    const attachments = linkResult.attachments;
    working = linkResult.working;

    const contextMatches = getQuickAddTokenMatches(working, '@', options.knownContexts);
    contextMatches.forEach((ctx) => contexts.add(ctx.token));
    contextMatches.forEach((ctx) => (working = stripToken(working, ctx.raw)));

    const tagMatches = getQuickAddTokenMatches(working, '#', options.knownTags);
    tagMatches.forEach((tag) => tags.add(tag.token));
    tagMatches.forEach((tag) => (working = stripToken(working, tag.raw)));

    // Person: %Name or %"Full Name" → assignedTo
    let assignedTo: string | undefined;
    const knownPeople = options.knownPeople ?? [];
    const canonicalPersonName = (value: string) =>
        knownPeople.find((name) => normalizeQuickAddName(name) === normalizeQuickAddName(value)) ?? value;
    const quotedPerson = matchQuickAddQuotedName(working, '%');
    if (quotedPerson) {
        assignedTo = canonicalPersonName(quotedPerson.value);
        working = stripToken(working, quotedPerson.raw);
    } else {
        const personMatch = working.match(/(?:^|\s)%([^\s/]+(?:\s+(?![@#+/!%])[^/\s]+)*)/);
        if (personMatch) {
            const rawFull = personMatch[1] || '';
            const prefixMatch = matchKnownQuickAddNamePrefix(rawFull, knownPeople);
            if (prefixMatch) {
                assignedTo = canonicalPersonName(prefixMatch.value);
                working = stripToken(working, `%${prefixMatch.consumedRaw}`);
            } else {
                // Unknown name: take only the first word so trailing title
                // words are not swallowed; multi-word new names use %"...".
                const firstWord = rawFull.match(/\S+/u)?.[0] ?? '';
                const restoredFirst = restoreEscapes(firstWord).trim();
                if (restoredFirst) {
                    assignedTo = restoredFirst;
                    working = stripToken(working, `%${firstWord}`);
                }
            }
        }
    }

    let energyLevel: TaskEnergyLevel | undefined;
    const energyMatch = working.match(/(?:^|\s)\/energy:([^\s/]+)/i);
    if (energyMatch) {
        const token = restoreEscapes(energyMatch[1] ?? '').trim().toLowerCase();
        energyLevel = ENERGY_TOKENS[token];
        if (energyLevel) {
            working = stripToken(working, energyMatch[0]);
        }
    }

    // Area: /area:<id|name> or !Area Name
    let areaId: string | undefined;
    const areaIdMatch = working.match(/(?:^|\s)\/area:([^\s/]+)/i);
    if (areaIdMatch) {
        const token = restoreEscapes(areaIdMatch[1] ?? '').trim();
        if (token) {
            const matched =
                areas?.find((area) => area.id === token)
                ?? areas?.find((area) => area.name.toLowerCase() === token.toLowerCase());
            if (matched) {
                areaId = matched.id;
            } else if (!areas || areas.length === 0) {
                if (/^[0-9a-f-]{8,}$/i.test(token)) {
                    areaId = token;
                }
            }
        }
        if (areaId) {
            working = stripToken(working, areaIdMatch[0]);
        }
    } else {
        const quotedArea = matchQuickAddQuotedName(working, '!');
        if (quotedArea) {
            const found = areas?.find((area) => normalizeQuickAddName(area.name) === normalizeQuickAddName(quotedArea.value));
            if (found) {
                areaId = found.id;
                working = stripToken(working, quotedArea.raw);
            }
        } else {
            const areaMatch = working.match(/(?:^|\s)!([^\s/]+(?:\s+(?![@#+/!%])[^/\s]+)*)/);
            if (areaMatch) {
                const rawFull = areaMatch[1] || '';
                if (areas && areas.length > 0) {
                    const prefixMatch = matchKnownQuickAddNamePrefix(rawFull, areas.map((area) => area.name));
                    if (prefixMatch) {
                        const found = areas.find((area) => normalizeQuickAddName(area.name) === normalizeQuickAddName(prefixMatch.value));
                        if (found) {
                            areaId = found.id;
                            working = stripToken(working, `!${prefixMatch.consumedRaw}`);
                        }
                    }
                    // No known area matches: leave the text untouched instead of
                    // silently swallowing the token and any words after it.
                } else {
                    const firstWord = rawFull.match(/\S+/u)?.[0] ?? '';
                    const restoredFirst = restoreEscapes(firstWord);
                    if (/^[0-9a-f-]{8,}$/i.test(restoredFirst)) {
                        areaId = restoredFirst;
                        working = stripToken(working, `!${firstWord}`);
                    }
                }
            }
        }
    }

    // Note: /note:...
    let description: string | undefined;
    const noteMatch = working.match(new RegExp(`${QUICK_ADD_COMMAND_START}\\/note:([\\s\\S]+?)${QUICK_ADD_COMMAND_BOUNDARY}`, 'i'));
    if (noteMatch) {
        description = restoreEscapes(noteMatch[1].trim());
        working = stripToken(working, noteMatch[0]);
    }

    // Date commands: /start:..., /due:..., /review:...
    const {
        working: workingWithoutDates,
        startTime,
        dueDate,
        reviewAt,
        invalidDateCommands,
    } = parseDateCommandsFromWorking(working, now, options);
    working = workingWithoutDates;

    // Status tokens like /next, /waiting, etc.
    let status: TaskStatus | undefined;
    // `\b` would also match inside `/someday-maybe`, which used to be harmless
    // when preserve mode handed the title back verbatim and is not now: the
    // token has to be the whole word.
    const statusMatch = working.match(/(?:^|\s)\/(inbox|next|in-progress|waiting|someday|done|archived)(?=\s|$)/i);
    if (statusMatch) {
        const token = statusMatch[1].toLowerCase();
        status = STATUS_TOKENS[token] ?? normalizeTaskStatus(token);
        working = stripToken(working, statusMatch[0]);
    }

    // Focus token: /* or /* focus. Bare focus implies Next; explicit status tokens still win.
    const focusMatch = working.match(/(?:^|\s)\/\*(?:\s+focus\b)?(?=\s|$)/i);
    const focusToday = Boolean(focusMatch);
    if (focusMatch) {
        working = stripToken(working, focusMatch[0]);
        if (!status) status = 'next';
    }

    // Project: +ProjectName or /project:<id>
    let projectId: string | undefined;
    let projectTitle: string | undefined;
    const projectIdMatch = working.match(/(?:^|\s)\/project:([^\s/]+)/i);
    if (projectIdMatch) {
        const token = projectIdMatch[1];
        if (token) {
            projectId = token;
        }
        working = stripToken(working, projectIdMatch[0]);
    } else {
        const quotedProject = matchQuickAddQuotedName(working, '+');
        if (quotedProject) {
            const found = projects?.find(
                (p) => p.status !== 'archived' && normalizeQuickAddName(p.title) === normalizeQuickAddName(quotedProject.value)
            );
            if (found) {
                projectId = found.id;
            } else {
                projectTitle = quotedProject.value;
            }
            working = stripToken(working, quotedProject.raw);
        } else {
            const plusMatch = working.match(/(?:^|\s)\+([^\s/]+(?:\s+(?![@#+/%])[^/\s]+)*)/);
            if (plusMatch) {
                const rawFull = plusMatch[1] || '';
                const activeProjects = (projects ?? []).filter((p) => p.status !== 'archived');
                const prefixMatch = matchKnownQuickAddNamePrefix(rawFull, activeProjects.map((p) => p.title));
                if (prefixMatch) {
                    const found = activeProjects.find(
                        (p) => normalizeQuickAddName(p.title) === normalizeQuickAddName(prefixMatch.value)
                    );
                    if (found) projectId = found.id;
                    working = stripToken(working, `+${prefixMatch.consumedRaw}`);
                } else {
                    const rawProject = restoreEscapes(rawFull.replace(/\s+/g, ' ').trim());
                    if (!rawProject) {
                        working = stripToken(working, plusMatch[0]);
                        const strippedTitle = restoreEscapes(working.replace(/\s{2,}/g, ' ').trim());
                        return { title: strippedTitle, props: {} };
                    }
                    if ((!projects || projects.length === 0) && /^[0-9a-f-]{8,}$/i.test(rawProject)) {
                        projectId = rawProject;
                    }
                    if (!projectId) {
                        projectTitle = rawProject;
                    }
                    working = stripToken(working, plusMatch[0]);
                }
            }
        }
    }

    // A token the parser recognised and applied has already left `working`, and
    // it stays gone: nobody wants a task called "Call mum /next" when the status
    // is on the task. `quickAddAutoClean` decides only the ambiguous half —
    // whether a date read out of ordinary prose is also cut from the title —
    // which is why preserve mode still hands back a titleWithoutDate that keeps
    // the prose intact.
    const title = restoreEscapes(working.replace(/\s{2,}/g, ' ').trim());
    const rawDetectedDate = dueDate || hadExplicitDueCommand || options.naturalLanguageDates === false
        ? undefined
        : detectTrailingDate(title, now);
    const detectedDate = rawDetectedDate && preserveText
        ? { ...rawDetectedDate, titleWithoutDate: title }
        : rawDetectedDate;

    const props: Partial<Task> = {};
    if (status) props.status = status;
    if (startTime) props.startTime = startTime;
    if (dueDate) props.dueDate = dueDate;
    if (reviewAt) props.reviewAt = reviewAt;
    if (description) props.description = description;
    if (contexts.size > 0) props.contexts = Array.from(contexts);
    if (tags.size > 0) props.tags = Array.from(tags);
    if (attachments && attachments.length > 0) props.attachments = attachments;
    if (projectId) props.projectId = projectId;
    if (areaId) props.areaId = areaId;
    if (energyLevel) props.energyLevel = energyLevel;
    if (assignedTo) props.assignedTo = assignedTo;
    if (focusToday) props.isFocusedToday = true;

    return {
        title,
        props,
        projectTitle,
        invalidDateCommands,
        detectedDate,
    };
}
