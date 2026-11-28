import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { fixture } from '../../../scripts/performance/fixture.mjs';
import { searchMarkdownReferences } from './markdown';
import type { Project, Task } from './types';

const corpusFile = join(dirname(fileURLToPath(import.meta.url)), 'markdown-reference-search-corpus.json');
const updating = process.env.UPDATE_MARKDOWN_REFERENCE_SEARCH_CORPUS === '1';
const frozen: Record<string, string> = updating ? {} : JSON.parse(readFileSync(corpusFile, 'utf8'));
const recorded: Record<string, string> = {};

const random = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const FRAGMENTS = ['Pack', 'pack', 'PACK', 'packing', 'Paint', 'the', 'hall', 'Café', 'cafe', 'café', 'café', 'CAFÉ',
    '東京', '東京タワー', '北京', 'タスク', 'Ärger', 'arger', 'Straße', 'STRASSE', 'İstanbul', 'istanbul', 'ǅemal', 'Ωmega',
    'a', 'b', 'pa', 'ap', 'task', 'Task', '42', '-', '🙂', 'z'];
const TIMES = ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-03-05T10:00:00.000Z', '2026-03-05T10:00:00.001Z',
    '2025-12-31T23:59:59.999Z', '2026-03-05T10:00:00Z'];
const TASK_STATUSES = ['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'];
const PROJECT_STATUSES = ['active', 'someday', 'waiting', 'archived'];

const titleFrom = (next: () => number): string => {
    const roll = next();
    if (roll < 0.04) return '';
    if (roll < 0.08) return '   ';
    const words = Array.from({ length: 1 + Math.floor(next() * 3) }, () => FRAGMENTS[Math.floor(next() * FRAGMENTS.length)]);
    const title = words.join(next() < 0.85 ? ' ' : '');
    const pad = next();
    return pad < 0.1 ? `  ${title}` : pad < 0.2 ? `${title} \t` : title;
};

const corpus = (seed: number, taskCount: number, projectCount: number): { tasks: Task[]; projects: Project[] } => {
    const next = random(seed);
    const pick = <T,>(values: T[]) => values[Math.floor(next() * values.length)];
    const tasks = Array.from({ length: taskCount }, (_, i) => ({
        id: `t${seed}-${i}`, title: titleFrom(next), status: pick(TASK_STATUSES), tags: [], contexts: [],
        createdAt: TIMES[0], updatedAt: pick(TIMES), ...(next() < 0.12 ? { deletedAt: pick(TIMES) } : {}),
    })) as Task[];
    const projects = Array.from({ length: projectCount }, (_, i) => ({
        id: `p${seed}-${i}`, title: titleFrom(next), status: pick(PROJECT_STATUSES), color: '#123456', order: i, tagIds: [],
        createdAt: TIMES[0], updatedAt: pick(TIMES), ...(next() < 0.12 ? { deletedAt: pick(TIMES) } : {}),
    })) as Project[];
    return { tasks, projects };
};

const QUERIES = ['', ' ', 'p', 'P', 'pa', 'PA', ' pack ', 'pack', 'packing', 'paint the', 'the hall', 'café', 'cafe', 'café',
    'CAFÉ', '東', '東京', 'タ', 'ä', 'Ä', 'ss', 'straße', 'i̇', 'istanbul', 'ǆ', 'ω', 'a', 'task', 'task ', '42', '-', '🙂', 'zzz', 'z'];

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

type Exclusions = { excludeTaskIds?: string[]; excludeProjectIds?: string[] };

const pin = (name: string, tasks: Task[], projects: Project[], query: string, limits: Array<number | undefined>, exclusions: Exclusions[]) => {
    const shape = limits.flatMap((limit) => exclusions.map((options) => searchMarkdownReferences(tasks, projects, query, limit, options)
        .map((item) => Object.entries(item))));
    recorded[name] = digest(shape);
    if (!updating) expect(recorded[name], name).toBe(frozen[name]);
};

afterAll(() => {
    if (updating) writeFileSync(corpusFile, `${JSON.stringify(recorded, null, 1)}\n`);
});

describe('searchMarkdownReferences frozen order', () => {
    for (const [seed, taskCount, projectCount] of [[1, 40, 6], [2, 300, 20], [3, 1200, 40]] as const) {
        it(`keeps every result and its order on mixed corpus ${seed} (${taskCount} tasks, ${projectCount} projects)`, () => {
            const { tasks, projects } = corpus(seed, taskCount, projectCount);
            const excludeTaskIds = tasks.filter((_, i) => i % 7 === 0).map((task) => task.id);
            const excludeProjectIds = projects.filter((_, i) => i % 3 === 0).map((project) => project.id);
            for (const query of QUERIES) {
                pin(`${seed}|${JSON.stringify(query)}`, tasks, projects, query,
                    [undefined, 0, 1, 2, 6, 8, 50, 2.5, Number.POSITIVE_INFINITY, Number.NaN], [{}, { excludeTaskIds, excludeProjectIds }]);
            }
        });
    }

    it('keeps the order on the 5,000-task performance fixture', () => {
        const { tasks, projects } = fixture(5000).data as unknown as { tasks: Task[]; projects: Project[] };
        for (const query of ['', 's', 'syn', 'Synthetic', 'synthetic task 1', 'task 49', 'project', 'project 1', 'zzz']) {
            pin(`fixture|${JSON.stringify(query)}`, tasks, projects, query, [6, 8], [{ excludeTaskIds: ['perf-task-10'] }]);
        }
    });

    it('compares each of 5,000 matching tasks with the kept few instead of sorting them all', () => {
        const { tasks, projects } = fixture(5000).data as unknown as { tasks: Task[]; projects: Project[] };
        const compare = vi.spyOn(String.prototype, 'localeCompare');
        try {
            expect(searchMarkdownReferences(tasks, projects, 'synthetic', 6)).toHaveLength(6);
            expect(compare.mock.calls.length).toBeLessThan(2.1 * (tasks.length + projects.length));
        } finally {
            compare.mockRestore();
        }
    });

    it('keeps the input order for results that tie on every sort key', () => {
        const at = '2026-01-01T00:00:00.000Z';
        const tasks = ['b', 'a', 'c', 'd'].map((id) => ({ id, title: 'Same', status: 'next', tags: [], contexts: [], createdAt: at, updatedAt: at })) as Task[];
        const projects = ['y', 'x'].map((id) => ({ id, title: 'Same', status: 'active', color: '#000', order: 0, tagIds: [], createdAt: at, updatedAt: at })) as Project[];
        expect(searchMarkdownReferences(tasks, projects, 'sam', 3).map((item) => `${item.entityType}:${item.id}`))
            .toEqual(['project:y', 'project:x', 'task:b']);
        expect(searchMarkdownReferences(tasks, projects, '', 8).map((item) => `${item.entityType}:${item.id}`))
            .toEqual(['project:y', 'project:x', 'task:b', 'task:a', 'task:c', 'task:d']);
    });
});
