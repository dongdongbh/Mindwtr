import * as chrono from 'chrono-node';
import { format, isValid, set } from 'date-fns';
import type { Area, Project, Task, TaskStatus } from './types';
import { normalizeTaskStatus } from './task-status';

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

export interface QuickAddDateCommandsResult {
    title: string;
    props: Pick<Partial<Task>, 'startTime' | 'dueDate' | 'reviewAt'>;
    invalidDateCommands?: string[];
}

const STATUS_TOKENS: Record<string, TaskStatus> = {
    inbox: 'inbox',
    next: 'next',
    waiting: 'waiting',
    someday: 'someday',
    reference: 'reference',
    done: 'done',
};

const ESCAPE_SENTINEL = '__MW_ESC__';
const QUICK_ADD_ESCAPE_CHARS = new Set(['@', '#', '+', '/', '!']);
const QUICK_ADD_COMMAND_BOUNDARY = String.raw`(?=\s\/(?:note:|start:|due:|review:|project:|area:|inbox\b|next\b|in-progress\b|waiting\b|someday\b|done\b|archived\b)|$)`;
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

type ParsedNaturalDate = {
    date: Date;
    hasExplicitTime: boolean;
};

function buildDefaultDate(now: Date, defaultTimeMode: DateDefaultTimeMode): Date {
    const fallbackHour = defaultTimeMode === 'startOfDay' ? 0 : now.getHours();
    const fallbackMinute = defaultTimeMode === 'startOfDay' ? 0 : now.getMinutes();
    return set(new Date(now), { hours: fallbackHour, minutes: fallbackMinute, seconds: 0, milliseconds: 0 });
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

function parseNaturalDate(raw: string, now: Date, defaultTimeMode: DateDefaultTimeMode = 'now'): ParsedNaturalDate | null {
    const text = raw.trim();
    if (!text) return { date: buildDefaultDate(now, defaultTimeMode), hasExplicitTime: defaultTimeMode === 'now' };

    const results = chrono.parse(text, { instant: now }, { forwardDate: true });
    const result = results[0];
    if (!result) return null;

    const matchedEnd = result.index + result.text.length;
    if (result.index !== 0 || matchedEnd !== text.length) return null;

    return resolveChronoDate(result, now, defaultTimeMode);
}

function formatDueDateValue(parsed: ParsedNaturalDate): string {
    return parsed.hasExplicitTime ? parsed.date.toISOString() : format(parsed.date, 'yyyy-MM-dd');
}

function detectTrailingDate(title: string, now: Date): QuickAddDetectedDate | undefined {
    const trimmed = title.trim();
    if (!trimmed) return undefined;

    const results = chrono.parse(trimmed, { instant: now }, { forwardDate: true });
    for (let index = results.length - 1; index >= 0; index -= 1) {
        const result = results[index];
        const matchedText = result.text.trim();
        const suffix = trimmed.slice(result.index + result.text.length);
        if (!matchedText || !TRAILING_DATE_SUFFIX_RE.test(suffix)) continue;
        if (PURE_TIME_ONLY_RE.test(matchedText) || BARE_MONTH_RE.test(matchedText)) continue;

        const titleWithoutDate = trimmed.slice(0, result.index).replace(TRAILING_DATE_SEPARATOR_RE, '').trim();
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

function stripToken(source: string, token: string): string {
    return source.replace(token, '').replace(/\s{2,}/g, ' ').trim();
}

function parseDateCommand(
    command: 'start' | 'due' | 'review',
    working: string,
    now: Date,
): { value?: string; working: string; invalidCommand?: string } {
    const match = working.match(new RegExp(`\\/${command}:([\\s\\S]+?)${QUICK_ADD_COMMAND_BOUNDARY}`, 'i'));
    if (!match) return { working };

    const dateText = match[1].trim();
    const defaultTimeMode: DateDefaultTimeMode = command === 'due' ? 'now' : 'startOfDay';
    const parsed = parseNaturalDate(dateText, now, defaultTimeMode);
    if (!parsed) {
        return {
            working,
            invalidCommand: `/${command}:${dateText}`,
        };
    }
    const nextWorking = stripToken(working, match[0]);
    return {
        value: command === 'due' ? formatDueDateValue(parsed) : parsed.date.toISOString(),
        working: nextWorking,
    };
}

function parseDateCommandsFromWorking(
    working: string,
    now: Date,
): {
    working: string;
    startTime?: string;
    dueDate?: string;
    reviewAt?: string;
    invalidDateCommands?: string[];
} {
    const invalidDateCommands: string[] = [];

    const startResult = parseDateCommand('start', working, now);
    const startTime = startResult.value;
    if (startResult.invalidCommand) invalidDateCommands.push(startResult.invalidCommand);
    working = startResult.working;

    const dueResult = parseDateCommand('due', working, now);
    const dueDate = dueResult.value;
    if (dueResult.invalidCommand) invalidDateCommands.push(dueResult.invalidCommand);
    working = dueResult.working;

    const reviewResult = parseDateCommand('review', working, now);
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

export function parseQuickAddDateCommands(input: string, now: Date = new Date()): QuickAddDateCommandsResult {
    const protectedInput = protectEscapes(input.trim());
    const {
        working,
        startTime,
        dueDate,
        reviewAt,
        invalidDateCommands,
    } = parseDateCommandsFromWorking(protectedInput, now);

    return {
        title: restoreEscapes(working.replace(/\s{2,}/g, ' ').trim()),
        props: {
            ...(startTime ? { startTime } : {}),
            ...(dueDate ? { dueDate } : {}),
            ...(reviewAt ? { reviewAt } : {}),
        },
        invalidDateCommands,
    };
}

export function parseQuickAdd(input: string, projects?: Project[], now: Date = new Date(), areas?: Area[]): QuickAddResult {
    let working = protectEscapes(input.trim());
    const hadExplicitDueCommand = /(?:^|\s)\/due:/i.test(working);

    const contexts = new Set<string>();
    const tags = new Set<string>();

    const contextMatches = working.match(/@[\p{L}\p{N}_-]+/gu) || [];
    contextMatches.forEach((ctx) => contexts.add(ctx));
    contextMatches.forEach((ctx) => (working = stripToken(working, ctx)));

    const tagMatches = working.match(/#[\p{L}\p{N}_-]+/gu) || [];
    tagMatches.forEach((tag) => tags.add(tag));
    tagMatches.forEach((tag) => (working = stripToken(working, tag)));

    // Area: /area:<id|name> or !Area Name
    let areaId: string | undefined;
    const areaIdMatch = working.match(/\/area:([^\s/]+)/i);
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
        const areaMatch = working.match(/(?:^|\s)!([^\s/]+(?:\s+(?![@#+/!])[^/\s]+)*)/);
        if (areaMatch) {
            const rawArea = restoreEscapes((areaMatch[1] || '').replace(/\s+/g, ' ').trim());
            if (rawArea) {
                if (areas && areas.length > 0) {
                    const found = areas.find((area) => area.name.toLowerCase() === rawArea.toLowerCase());
                    if (found) areaId = found.id;
                } else if (/^[0-9a-f-]{8,}$/i.test(rawArea)) {
                    areaId = rawArea;
                }
            }
            working = stripToken(working, areaMatch[0]);
        }
    }

    // Note: /note:...
    let description: string | undefined;
    const noteMatch = working.match(new RegExp(`\\/note:([\\s\\S]+?)${QUICK_ADD_COMMAND_BOUNDARY}`, 'i'));
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
    } = parseDateCommandsFromWorking(working, now);
    working = workingWithoutDates;

    // Status tokens like /next, /waiting, etc.
    let status: TaskStatus | undefined;
    const statusMatch = working.match(/\/(inbox|next|in-progress|waiting|someday|done|archived)\b/i);
    if (statusMatch) {
        const token = statusMatch[1].toLowerCase();
        status = STATUS_TOKENS[token] ?? normalizeTaskStatus(token);
        working = stripToken(working, statusMatch[0]);
    }

    // Project: +ProjectName or /project:<id>
    let projectId: string | undefined;
    let projectTitle: string | undefined;
    const projectIdMatch = working.match(/\/project:([^\s/]+)/i);
    if (projectIdMatch) {
        const token = projectIdMatch[1];
        if (token) {
            projectId = token;
        }
        working = stripToken(working, projectIdMatch[0]);
    } else {
        const plusMatch = working.match(/(?:^|\s)\+([^\s/]+(?:\s+(?![@#+/])[^/\s]+)*)/);
        if (plusMatch) {
            const rawProject = restoreEscapes((plusMatch[1] || '').replace(/\s+/g, ' ').trim());
            if (!rawProject) {
                working = stripToken(working, plusMatch[0]);
                const title = restoreEscapes(working.replace(/\s{2,}/g, ' ').trim());
                return { title, props: {} };
            }
            if (projects && projects.length > 0) {
                const found = projects.find((p) => p.title.toLowerCase() === rawProject.toLowerCase());
                if (found) projectId = found.id;
            } else if (/^[0-9a-f-]{8,}$/i.test(rawProject)) {
                projectId = rawProject;
            }
            if (!projectId) {
                projectTitle = rawProject;
            }
            working = stripToken(working, plusMatch[0]);
        }
    }

    const title = restoreEscapes(working.replace(/\s{2,}/g, ' ').trim());
    const detectedDate = !dueDate && !hadExplicitDueCommand ? detectTrailingDate(title, now) : undefined;

    const props: Partial<Task> = {};
    if (status) props.status = status;
    if (startTime) props.startTime = startTime;
    if (dueDate) props.dueDate = dueDate;
    if (reviewAt) props.reviewAt = reviewAt;
    if (description) props.description = description;
    if (contexts.size > 0) props.contexts = Array.from(contexts);
    if (tags.size > 0) props.tags = Array.from(tags);
    if (projectId) props.projectId = projectId;
    if (areaId) props.areaId = areaId;

    return {
        title,
        props,
        projectTitle,
        invalidDateCommands,
        detectedDate,
    };
}
