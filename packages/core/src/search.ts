import { addDays, addMonths, addWeeks, addYears, endOfDay, isAfter, isBefore, isEqual, parseISO, startOfDay } from 'date-fns';
import { safeParseDate } from './date';
import { matchesHierarchicalToken, normalizePrefixedToken } from './hierarchy-utils';
import { normalizeTaskStatus } from './task-status';
import type { Project, Task, TaskStatus } from './types';

export type SearchComparator = '<' | '<=' | '>' | '>=' | '=';

export interface SearchTerm {
    field: string | null;
    comparator: SearchComparator | null;
    value: string;
    negated: boolean;
}

export interface SearchClause {
    terms: SearchTerm[];
}

export interface SearchQuery {
    clauses: SearchClause[];
}

const STATUS_SET: Set<TaskStatus> = new Set([
    'inbox',
    'next',
    'waiting',
    'someday',
    'done',
    'archived',
]);

const DATE_FIELDS = new Set(['due', 'start', 'review', 'created']);

function tokenize(query: string): string[] {
    const tokens = query.match(/"[^"]+"|\S+/g) || [];
    return tokens.map((t) => t.trim()).filter(Boolean);
}

function parseComparator(value: string): { comparator: SearchComparator | null; rest: string } {
    const match = value.match(/^(<=|>=|<|>|=)\s*(.+)$/);
    if (!match) return { comparator: null, rest: value.trim() };
    return { comparator: match[1] as SearchComparator, rest: match[2].trim() };
}

function parseRelativeDate(expr: string, now: Date): Date | null {
    const raw = expr.trim().toLowerCase();
    if (raw === 'today') return startOfDay(now);
    if (raw === 'tomorrow') return startOfDay(addDays(now, 1));

    const relMatch = raw.match(/^(\d+)\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)$/);
    if (relMatch) {
        const amount = Number(relMatch[1]);
        const unit = relMatch[2];
        if (unit.startsWith('d')) return addDays(now, amount);
        if (unit.startsWith('w')) return addWeeks(now, amount);
        if (unit.startsWith('m')) return addMonths(now, amount);
        if (unit.startsWith('y')) return addYears(now, amount);
    }

    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
        const parsed = parseISO(raw);
        return parsed.toString() !== 'Invalid Date' ? parsed : null;
    }

    return null;
}

function compareDates(date: Date, comparator: SearchComparator, target: Date): boolean {
    switch (comparator) {
        case '<':
            return isBefore(date, target);
        case '<=':
            return isBefore(date, target) || isEqual(date, target);
        case '>':
            return isAfter(date, target);
        case '>=':
            return isAfter(date, target) || isEqual(date, target);
        case '=':
        default:
            return isEqual(date, target);
    }
}

export function parseSearchQuery(query: string): SearchQuery {
    const tokens = tokenize(query);
    const clauses: SearchClause[] = [];
    let currentTerms: SearchTerm[] = [];

    const pushClause = () => {
        if (currentTerms.length > 0) {
            clauses.push({ terms: currentTerms });
            currentTerms = [];
        }
    };

    for (const rawToken of tokens) {
        const tokenUpper = rawToken.toUpperCase();
        if (tokenUpper === 'OR' || rawToken === '|' || rawToken === '||') {
            pushClause();
            continue;
        }

        let negated = false;
        let token = rawToken;
        if (token.startsWith('-')) {
            negated = true;
            token = token.slice(1);
        }

        token = token.replace(/^"|"$/g, '');

        const colonIndex = token.indexOf(':');
        if (colonIndex > 0) {
            const field = token.slice(0, colonIndex).toLowerCase();
            const valueRaw = token.slice(colonIndex + 1);
            const { comparator, rest } = parseComparator(valueRaw);
            currentTerms.push({
                field,
                comparator,
                value: rest.replace(/^"|"$/g, ''),
                negated,
            });
        } else {
            currentTerms.push({
                field: null,
                comparator: null,
                value: token,
                negated,
            });
        }
    }

    pushClause();

    return { clauses };
}

function matchesText(haystack: string | undefined, needle: string): boolean {
    if (!haystack) return false;
    return haystack.toLowerCase().includes(needle.toLowerCase());
}

function normalizeTag(value: string): string {
    return normalizePrefixedToken(value, '#');
}

function normalizeContext(value: string): string {
    return normalizePrefixedToken(value, '@');
}

function matchDateField(dateStr: string | undefined, comparator: SearchComparator | null, value: string, now: Date): boolean {
    if (!dateStr) return false;
    const date = safeParseDate(dateStr);
    if (!date) return false;

    const { comparator: cmp, rest } = parseComparator(value);
    const effectiveComparator = comparator || cmp || '=';
    const target = parseRelativeDate(rest, now);
    if (!target) return false;

    if (effectiveComparator === '=') {
        // Compare on day granularity.
        const start = startOfDay(target);
        const end = endOfDay(target);
        return (isAfter(date, start) || isEqual(date, start)) && (isBefore(date, end) || isEqual(date, end));
    }

    return compareDates(date, effectiveComparator, target);
}

export function matchesTask(term: SearchTerm, task: Task, projectById: Map<string, Project>, now: Date): boolean {
    if (task.deletedAt) return false;

    const field = term.field;
    const value = term.value;

    let result = false;

    if (!field) {
        result = matchesText(task.title, value) || matchesText(task.description, value);
    } else if (field === 'status') {
        const normalized = normalizeTaskStatus(value);
        result = STATUS_SET.has(normalized) ? task.status === normalized : false;
    } else if (field === 'context' || field === 'contexts') {
        const ctx = normalizeContext(value);
        result = (task.contexts || []).some((existing) => matchesHierarchicalToken(ctx, existing));
    } else if (field === 'tag' || field === 'tags') {
        const tag = normalizeTag(value);
        result = (task.tags || []).some((existing) => matchesHierarchicalToken(tag, existing));
    } else if (field === 'project') {
        if (!task.projectId) result = false;
        else {
            const project = projectById.get(task.projectId);
            result = task.projectId === value || (project ? matchesText(project.title, value) : false);
        }
    } else if (DATE_FIELDS.has(field)) {
        if (field === 'due') result = matchDateField(task.dueDate, term.comparator, value, now);
        else if (field === 'start') result = matchDateField(task.startTime, term.comparator, value, now);
        else if (field === 'review') result = matchDateField(task.reviewAt, term.comparator, value, now);
        else if (field === 'created') result = matchDateField(task.createdAt, term.comparator, value, now);
    } else {
        // Unknown field: treat as text search against title/description.
        result = matchesText(task.title, `${field}:${value}`) || matchesText(task.description, `${field}:${value}`);
    }

    return term.negated ? !result : result;
}

export function matchesProject(term: SearchTerm, project: Project, now: Date): boolean {
    if (project.deletedAt) return false;

    const field = term.field;
    const value = term.value;
    let result = false;

    if (!field) {
        result = matchesText(project.title, value) || matchesText(project.supportNotes, value);
    } else if (field === 'status') {
        result = project.status === value;
    } else if (field === 'review') {
        result = matchDateField(project.reviewAt, term.comparator, value, now);
    } else if (field === 'created') {
        result = matchDateField(project.createdAt, term.comparator, value, now);
    } else {
        result = matchesText(project.title, `${field}:${value}`) || matchesText(project.supportNotes, `${field}:${value}`);
    }

    return term.negated ? !result : result;
}

export function filterTasksBySearch(tasks: Task[], projects: Project[], query: string, now: Date = new Date()): Task[] {
    if (!query.trim()) {
        return tasks.filter((task) => !task.deletedAt);
    }
    const ast = parseSearchQuery(query);
    if (ast.clauses.length === 0) {
        return tasks.filter((task) => !task.deletedAt);
    }
    const projectById = new Map(projects.map((project) => [project.id, project]));

    return tasks.filter((task) => {
        if (task.deletedAt) return false;
        return ast.clauses.some((clause) => clause.terms.every((term) => matchesTask(term, task, projectById, now)));
    });
}

export function filterProjectsBySearch(projects: Project[], query: string, now: Date = new Date()): Project[] {
    if (!query.trim()) {
        return projects.filter((project) => !project.deletedAt);
    }
    const ast = parseSearchQuery(query);
    if (ast.clauses.length === 0) {
        return projects.filter((project) => !project.deletedAt);
    }

    return projects.filter((project) => {
        if (project.deletedAt) return false;
        return ast.clauses.some((clause) => clause.terms.every((term) => matchesProject(term, project, now)));
    });
}

export function searchAll(tasks: Task[], projects: Project[], query: string, now: Date = new Date()) {
    return {
        tasks: filterTasksBySearch(tasks, projects, query, now),
        projects: filterProjectsBySearch(projects, query, now),
    };
}
