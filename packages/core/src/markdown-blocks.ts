import { parseInlineMarkdown, parseMarkdownReferenceHref } from './markdown';
import { isSafeMarkdownExternalHref } from './markdown-links';
import type { Project, Task } from './types';


const TASK_LIST_RE = /^(\s*)(?:[-*+]\s+)?\[( |x|X)\]\s+(.+)$/;
const BULLET_LIST_RE = /^(\s*)[-*+]\s+(.+)$/;
const ORDERED_LIST_RE = /^(\s*)(\d+)([.)])\s+(.+)$/;
const HEADING_RE = /^(#{1,3})\s+(.+)$/;
const HORIZONTAL_RULE_RE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const FENCED_CODE_RE = /^```.*$/;
const BULLET_MARKERS = ['•', '◦', '▪'];

export type MarkdownListItem = { depth: number; marker: string; text: string };
export type MarkdownTaskListItem = { depth: number; checked: boolean; text: string };

export type MarkdownBlock = { start: number; end: number } & (
    | { type: 'blank' }
    | { type: 'heading'; level: 1 | 2 | 3; text: string }
    | { type: 'rule' }
    | { type: 'code'; text: string }

    | { type: 'taskList'; items: MarkdownTaskListItem[] }

    | { type: 'bulletList'; items: MarkdownListItem[] }

    | { type: 'orderedList'; items: MarkdownListItem[] }
    | { type: 'paragraph'; text: string }
);

function isBlockBoundary(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;
    return trimmed.startsWith('```')
        || HEADING_RE.test(trimmed)
        || HORIZONTAL_RULE_RE.test(trimmed)
        || TASK_LIST_RE.test(line)
        || BULLET_LIST_RE.test(line)
        || ORDERED_LIST_RE.test(line);
}


const getListIndentDepth = (indent: string): number => Math.max(0, Math.floor(indent.replace(/\t/g, '    ').length / 2));


export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
    const lines = (markdown || '').replace(/\r\n/g, '\n').split('\n');
    const blocks: MarkdownBlock[] = [];

    const collect = <T,>(start: number, re: RegExp, read: (match: RegExpExecArray) => T): { items: T[]; end: number } => {
        const items: T[] = [];
        let i = start;
        for (let match = re.exec(lines[i] ?? ''); i < lines.length && match; match = re.exec(lines[i] ?? '')) {
            items.push(read(match));
            i += 1;
        }
        return { items, end: i };
    };
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const start = i;
        const trimmed = line.trim();
        if (!trimmed) {
            blocks.push({ type: 'blank', start, end: i + 1 });
            i += 1;
            continue;
        }
        const heading = HEADING_RE.exec(trimmed);
        if (heading) {
            blocks.push({ type: 'heading', start, end: i + 1, level: heading[1].length as 1 | 2 | 3, text: heading[2] });
            i += 1;
            continue;
        }
        if (HORIZONTAL_RULE_RE.test(trimmed)) {
            blocks.push({ type: 'rule', start, end: i + 1 });
            i += 1;
            continue;
        }
        if (FENCED_CODE_RE.test(trimmed)) {
            const code: string[] = [];
            i += 1;
            while (i < lines.length && !FENCED_CODE_RE.test(lines[i].trim())) {
                code.push(lines[i]);
                i += 1;
            }

            if (i < lines.length) i += 1;
            blocks.push({ type: 'code', start, end: i, text: code.join('\n') });
            continue;
        }
        if (TASK_LIST_RE.test(line)) {
            const { items, end } = collect(i, TASK_LIST_RE, (m) => ({ checked: m[2].toLowerCase() === 'x', depth: getListIndentDepth(m[1]), text: m[3] }));
            blocks.push({ type: 'taskList', start, end, items });
            i = end;
            continue;
        }
        if (BULLET_LIST_RE.test(line)) {
            const { items, end } = collect(i, BULLET_LIST_RE, (m) => {
                const depth = getListIndentDepth(m[1]);
                return { depth, marker: BULLET_MARKERS[Math.min(depth, 2)], text: m[2] };
            });
            blocks.push({ type: 'bulletList', start, end, items });
            i = end;
            continue;
        }
        if (ORDERED_LIST_RE.test(line)) {
            const { items, end } = collect(i, ORDERED_LIST_RE, (m) => ({ depth: getListIndentDepth(m[1]), marker: `${m[2]}${m[3]}`, text: m[4] }));
            blocks.push({ type: 'orderedList', start, end, items });
            i = end;
            continue;
        }
        const paragraph: string[] = [];
        while (i < lines.length && lines[i].trim() && !isBlockBoundary(lines[i])) {
            paragraph.push(lines[i]);
            i += 1;
        }
        blocks.push({ type: 'paragraph', start, end: i, text: paragraph.join('\n').trim() });
    }
    return blocks;
}

export type MarkdownLinkTarget =
    | { kind: 'project'; id: string }
    | { kind: 'task'; id: string; projectId: string | null }

    | { kind: 'external'; href: string };

export type MarkdownInline =
    | { type: 'text'; text: string }
    | { type: 'bold'; text: string }
    | { type: 'italic'; text: string }
    | { type: 'strike'; text: string }
    | { type: 'code'; text: string }
    | { type: 'link'; text: string; target: MarkdownLinkTarget }

    | { type: 'deletedReference'; text: string; entityType: 'task' | 'project' };


export type MarkdownLinkLookup = {
    task: (id: string) => Pick<Task, 'projectId'> | null;
    project: (id: string) => Pick<Project, 'id'> | null;
};

export function createMarkdownLinkLookup(tasks: readonly Task[], projects: readonly Project[]): MarkdownLinkLookup {
    const tasksById = new Map(tasks.filter((task) => !task.deletedAt && !task.purgedAt).map((task) => [task.id, task]));
    const projectsById = new Map(projects.filter((project) => !project.deletedAt && !project.purgedAt).map((project) => [project.id, project]));
    return {
        task: (id) => tasksById.get(id) ?? null,
        project: (id) => projectsById.get(id) ?? null,
    };
}


export function resolveMarkdownInline(text: string, lookup: MarkdownLinkLookup): MarkdownInline[] {
    return parseInlineMarkdown(text).map((token): MarkdownInline => {
        if (token.type !== 'link') return token;
        const reference = parseMarkdownReferenceHref(token.href);
        if (reference?.entityType === 'project') {
            return lookup.project(reference.id)
                ? { type: 'link', text: token.text, target: { kind: 'project', id: reference.id } }
                : { type: 'deletedReference', text: token.text, entityType: 'project' };
        }
        if (reference?.entityType === 'task') {
            const task = lookup.task(reference.id);
            return task
                ? { type: 'link', text: token.text, target: { kind: 'task', id: reference.id, projectId: task.projectId ?? null } }
                : { type: 'deletedReference', text: token.text, entityType: 'task' };
        }
        if (isSafeMarkdownExternalHref(token.href)) return { type: 'link', text: token.text, target: { kind: 'external', href: token.href } };
        return { type: 'text', text: token.text };
    });
}

type ResolvedText<T> = Omit<T, 'text'> & { inline: MarkdownInline[] };
export type ResolvedMarkdownBlock =
    | Extract<MarkdownBlock, { type: 'blank' | 'rule' | 'code' }>
    | ResolvedText<Extract<MarkdownBlock, { type: 'heading' | 'paragraph' }>>
    | (Omit<Extract<MarkdownBlock, { type: 'taskList' }>, 'items'> & { items: ResolvedText<MarkdownTaskListItem>[] })
    | (Omit<Extract<MarkdownBlock, { type: 'bulletList' | 'orderedList' }>, 'items'> & { items: ResolvedText<MarkdownListItem>[] });


export function resolveMarkdownBlocks(markdown: string, lookup: MarkdownLinkLookup): ResolvedMarkdownBlock[] {
    const resolve = <T extends { text: string }>({ text, ...rest }: T) => ({ ...rest, inline: resolveMarkdownInline(text, lookup) });
    return parseMarkdownBlocks(markdown).map((block): ResolvedMarkdownBlock => {
        switch (block.type) {
            case 'heading':
            case 'paragraph':
                return resolve(block);
            case 'taskList':
                return { ...block, items: block.items.map(resolve) };
            case 'bulletList':
            case 'orderedList':
                return { ...block, items: block.items.map(resolve) };
            default:
                return block;
        }
    });
}
