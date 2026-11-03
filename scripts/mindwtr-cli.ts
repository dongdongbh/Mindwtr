#!/usr/bin/env bun
import { type LogPayload, sanitizeForLog, sanitizeLogContext, setLogger, type Task } from '@mindwtr/core';

import { asTaskStatus, createMindwtrAutomationService } from './mindwtr-automation-core';


setLogger((event: LogPayload) => {
    const context = sanitizeLogContext({
        ...event.context,
        ...(event.error !== undefined ? { error: event.error } : {}),
    });
    process.stderr.write(
        `${JSON.stringify({
            ts: new Date().toISOString(),
            level: event.level,
            scope: sanitizeForLog(event.scope ?? 'core'),
            ...(event.category ? { category: sanitizeForLog(event.category) } : {}),
            message: sanitizeForLog(event.message),
            ...(context ? { context } : {}),
        })}\n`,
    );
});

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
        '  bun run scripts/mindwtr-cli.ts -- list [--all] [--deleted] [--status <status>] [--query "<q>"]',
        '  bun run scripts/mindwtr-cli.ts -- get <taskId>',
        '  bun run scripts/mindwtr-cli.ts -- update <taskId> "<json-patch>"',
        '  bun run scripts/mindwtr-cli.ts -- complete <taskId>',
        '  bun run scripts/mindwtr-cli.ts -- archive <taskId>',
        '  bun run scripts/mindwtr-cli.ts -- delete <taskId>',
        '  bun run scripts/mindwtr-cli.ts -- restore <taskId>',
        '  bun run scripts/mindwtr-cli.ts -- search "<q>"',
        '  bun run scripts/mindwtr-cli.ts -- projects',
        '',
        'Options:',
        '  --data <path>  Override data.json location',
        '  --db <path>    Override mindwtr.db location',
        '',
        'Environment:',
        '  MINDWTR_DATA     Override data.json location (if --data is omitted)',
        '  MINDWTR_DB_PATH  Override mindwtr.db location (if --db is omitted)',
    ];
    console.log(lines.join('\n'));
    process.exit(exitCode);
}

function formatTaskLine(task: Task): string {
    const parts = [
        task.id,
        `[${task.deletedAt ? 'deleted' : task.status}]`,
        task.title,
        task.dueDate ? `(due ${task.dueDate.slice(0, 10)})` : '',
    ].filter(Boolean);
    return parts.join(' ');
}

function requireTaskId(value: string | undefined): string {
    const taskId = value?.trim();
    if (!taskId) {
        console.error('Missing taskId.');
        usage(1);
    }
    return taskId;
}

function parseTaskPatch(raw: string | undefined): Partial<Task> {
    if (!raw) {
        console.error('Missing JSON patch.');
        usage(1);
    }

    try {
        const parsed = JSON.parse(raw) as Partial<Task>;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Patch must be a JSON object.');
        }
        return parsed;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Invalid JSON patch: ${message}`);
        process.exit(1);
    }
}

async function main() {
    const { flags, positional } = parseArgs(process.argv.slice(2));

    if (flags.help || positional.length === 0) usage(0);

    const service = await createMindwtrAutomationService({
        dataPath: flags.data as string | undefined,
        dbPath: flags.db as string | undefined,
    });

    const cmd = positional[0];
    if (!cmd) usage(1);

    if (cmd === 'add') {
        const input = positional.slice(1).join(' ').trim();
        if (!input) {
            console.error('Missing task text.');
            usage(1);
        }
        const task = await service.createTask({ input });
        console.log(task.id);
        return;
    }

    if (cmd === 'list') {
        const statusFilter = asTaskStatus(flags.status);
        if (flags.status && !statusFilter) {
            console.error(`Invalid status: ${String(flags.status)}`);
            process.exit(1);
        }

        const tasks = await service.listTasks({
            includeAll: Boolean(flags.all),
            includeDeleted: Boolean(flags.deleted),
            status: statusFilter,
            query: typeof flags.query === 'string' ? String(flags.query) : '',
        });

        tasks.forEach((task) => console.log(formatTaskLine(task)));
        return;
    }

    if (cmd === 'get') {
        const task = await service.getTask(requireTaskId(positional[1]));
        console.log(JSON.stringify(task, null, 2));
        return;
    }

    if (cmd === 'update') {
        const task = await service.updateTask(requireTaskId(positional[1]), parseTaskPatch(positional[2]));
        console.log(JSON.stringify(task, null, 2));
        return;
    }

    if (cmd === 'complete') {
        await service.completeTask(requireTaskId(positional[1]));
        console.log('ok');
        return;
    }

    if (cmd === 'archive') {
        await service.archiveTask(requireTaskId(positional[1]));
        console.log('ok');
        return;
    }

    if (cmd === 'delete') {
        await service.deleteTask(requireTaskId(positional[1]));
        console.log('ok');
        return;
    }

    if (cmd === 'restore') {
        await service.restoreTask(requireTaskId(positional[1]));
        console.log('ok');
        return;
    }

    if (cmd === 'search') {
        const query = positional.slice(1).join(' ').trim();
        if (!query) {
            console.error('Missing search query.');
            usage(1);
        }
        const results = await service.search(query);

        if (results.projects.length) {
            console.log('Projects:');
            results.projects.forEach((project) => console.log(`${project.id} ${project.title}`));
            console.log('');
        }
        if (results.tasks.length) {
            console.log('Tasks:');
            results.tasks.forEach((task) => console.log(`${task.id} [${task.status}] ${task.title}`));
        }
        return;
    }

    if (cmd === 'projects') {
        const projects = await service.listProjects();
        projects.forEach((project) => console.log(`${project.id} [${project.status}] ${project.title}`));
        return;
    }

    console.error(`Unknown command: ${cmd}`);
    usage(1);
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
});
