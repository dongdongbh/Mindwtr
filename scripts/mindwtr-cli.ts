#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

import {
    applyTaskUpdates,
    generateUUID,
    parseQuickAdd,
    searchAll,
    type AppData,
    type Task,
    type TaskStatus,
} from '@mindwtr/core';

import { resolveMindwtrDataPath } from './mindwtr-paths';

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]) {
    const flags: Flags = {};
    const positional: string[] = [];

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg) continue;
        if (arg.startsWith('--')) {
            const key = arg.slice(2);
            const next = argv[i + 1];
            if (next && !next.startsWith('--')) {
                flags[key] = next;
                i += 1;
            } else {
                flags[key] = true;
            }
        } else {
            positional.push(arg);
        }
    }

    return { flags, positional };
}

function usage(exitCode: number) {
    const lines = [
        'mindwtr-cli',
        '',
        'Usage:',
        '  bun run scripts/mindwtr-cli.ts -- add "<text>"',
        '  bun run scripts/mindwtr-cli.ts -- list [--all] [--status <status>] [--query "<q>"]',
        '  bun run scripts/mindwtr-cli.ts -- complete <taskId>',
        '  bun run scripts/mindwtr-cli.ts -- search "<q>"',
        '',
        'Options:',
        '  --data <path>  Override data.json location',
        '',
        'Environment:',
        '  MINDWTR_DATA  Override data.json location (if --data is omitted)',
    ];
    console.log(lines.join('\n'));
    process.exit(exitCode);
}

function loadAppData(path: string): AppData {
    try {
        const raw = readFileSync(path, 'utf8');
        const parsed = JSON.parse(raw) as Partial<AppData>;
        return {
            tasks: Array.isArray(parsed.tasks) ? (parsed.tasks as any) : [],
            projects: Array.isArray(parsed.projects) ? (parsed.projects as any) : [],
            areas: Array.isArray((parsed as AppData).areas) ? ((parsed as AppData).areas as any) : [],
            settings: typeof parsed.settings === 'object' && parsed.settings ? (parsed.settings as any) : {},
        };
    } catch {
        return { tasks: [], projects: [], areas: [], settings: {} };
    }
}

function saveAppData(path: string, data: AppData) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2));
}

function asStatus(value: string | undefined): TaskStatus | null {
    if (!value) return null;
    const allowed: TaskStatus[] = ['inbox', 'todo', 'next', 'in-progress', 'waiting', 'someday', 'done', 'archived'];
    return allowed.includes(value as TaskStatus) ? (value as TaskStatus) : null;
}

function formatTaskLine(task: Task): string {
    const parts = [
        task.id,
        `[${task.status}]`,
        task.title,
        task.dueDate ? `(due ${task.dueDate.slice(0, 10)})` : '',
    ].filter(Boolean);
    return parts.join(' ');
}

async function main() {
    const { flags, positional } = parseArgs(process.argv.slice(2));

    if (flags.help || positional.length === 0) usage(0);

    const filePath = resolveMindwtrDataPath(flags.data as string | undefined);
    const data = loadAppData(filePath);

    const cmd = positional[0];
    if (!cmd) usage(1);

    if (cmd === 'add') {
        const input = positional.slice(1).join(' ').trim();
        if (!input) {
            console.error('Missing task text.');
            usage(1);
        }

        const now = new Date().toISOString();
        const { title, props } = parseQuickAdd(input, data.projects);
        const finalTitle = (title || input).trim();
        const status = asStatus(props.status) || 'inbox';
        const tags = Array.isArray(props.tags) ? props.tags : [];
        const contexts = Array.isArray(props.contexts) ? props.contexts : [];
        const {
            id: _id,
            title: _title,
            createdAt: _createdAt,
            updatedAt: _updatedAt,
            status: _status,
            tags: _tags,
            contexts: _contexts,
            ...restProps
        } = props as any;

        const task: Task = {
            id: generateUUID(),
            title: finalTitle,
            ...restProps,
            status,
            tags,
            contexts,
            createdAt: now,
            updatedAt: now,
        } as Task;

        data.tasks.push(task);
        saveAppData(filePath, data);
        console.log(task.id);
        return;
    }

    if (cmd === 'list') {
        const includeAll = Boolean(flags.all);
        const statusFilter = asStatus(flags.status as string | undefined);
        const query = typeof flags.query === 'string' ? String(flags.query) : '';

        let tasks = data.tasks.filter((t) => !t.deletedAt);
        if (!includeAll) {
            tasks = tasks.filter((t) => t.status !== 'done' && t.status !== 'archived');
        }
        if (statusFilter) {
            tasks = tasks.filter((t) => t.status === statusFilter);
        }
        if (query.trim()) {
            tasks = searchAll(tasks, data.projects.filter((p) => !p.deletedAt), query).tasks;
        }

        tasks.forEach((t) => console.log(formatTaskLine(t)));
        return;
    }

    if (cmd === 'search') {
        const query = positional.slice(1).join(' ').trim();
        if (!query) {
            console.error('Missing search query.');
            usage(1);
        }
        const tasks = data.tasks.filter((t) => !t.deletedAt);
        const projects = data.projects.filter((p) => !p.deletedAt);
        const results = searchAll(tasks, projects, query);

        if (results.projects.length) {
            console.log('Projects:');
            results.projects.forEach((p) => console.log(`${p.id} ${p.title}`));
            console.log('');
        }
        if (results.tasks.length) {
            console.log('Tasks:');
            results.tasks.forEach((t) => console.log(formatTaskLine(t)));
        }
        return;
    }

    if (cmd === 'complete') {
        const taskId = positional[1];
        if (!taskId) {
            console.error('Missing taskId.');
            usage(1);
        }

        const idx = data.tasks.findIndex((t) => t.id === taskId);
        if (idx < 0) {
            console.error(`Task not found: ${taskId}`);
            process.exit(2);
        }

        const now = new Date().toISOString();
        const existing = data.tasks[idx];
        const { updatedTask, nextRecurringTask } = applyTaskUpdates(existing, { status: 'done' }, now);
        data.tasks[idx] = updatedTask;
        if (nextRecurringTask) data.tasks.push(nextRecurringTask);

        saveAppData(filePath, data);
        console.log('ok');
        return;
    }

    console.error(`Unknown command: ${cmd}`);
    usage(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
