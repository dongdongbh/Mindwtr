import type { AppData, Task } from '../../../packages/core/src/types';
import { prepareSnapshot, resolveSnapshots, type Snapshot } from './model';

const NOW = '2026-09-17T16:00:00.000Z';
const NAMESPACE = 'synthetic-demo-namespace';

const task = (id: string, title: string, revBy: string): Task => ({
    id,
    title,
    status: 'inbox',
    createdAt: '2026-09-17T12:00:00.000Z',
    updatedAt: '2026-09-17T12:00:00.000Z',
    tags: [],
    contexts: [],
    rev: 1,
    revBy,
});

const emptyData = (): AppData => ({
    tasks: [],
    projects: [],
    sections: [],
    areas: [],
    settings: {},
});

const withTask = (base: AppData, nextTask: Task): AppData => ({
    ...structuredClone(base),
    tasks: [...base.tasks.map((item) => structuredClone(item)), nextTask],
});

const summarize = (label: string, snapshots: Snapshot[], upload: Snapshot | null): void => {
    const resolved = resolveSnapshots(snapshots, NAMESPACE, NOW);
    console.log(JSON.stringify({
        label,
        heads: resolved.heads,
        taskIds: resolved.data?.tasks.map((item) => item.id).sort() ?? [],
        upload: upload === null ? null : { id: upload.id, parents: upload.parents },
    }));
};

const runSmoke = (): void => {
    const root = prepareSnapshot(
        'root',
        NAMESPACE,
        withTask(emptyData(), task('seed', 'Seed task', 'device-root')),
        [],
        NOW,
    )!;
    summarize('root', [root], root);

    const left = prepareSnapshot(
        'left',
        NAMESPACE,
        withTask(root.data, task('left-task', 'Offline left edit', 'device-left')),
        [root],
        NOW,
    )!;
    const right = prepareSnapshot(
        'right',
        NAMESPACE,
        withTask(root.data, task('right-task', 'Offline right edit', 'device-right')),
        [root],
        NOW,
    )!;
    const fork = [root, right, left];
    summarize('fork', fork, null);

    const forkResolution = resolveSnapshots(fork, NAMESPACE, NOW);
    const join = prepareSnapshot('join', NAMESPACE, forkResolution.data!, fork, NOW)!;
    const joinedGraph = [...fork, join];
    summarize('join', joinedGraph, join);

    const steadyResolution = resolveSnapshots(joinedGraph, NAMESPACE, NOW);
    const noOp = prepareSnapshot('unused', NAMESPACE, steadyResolution.data!, joinedGraph, NOW);
    summarize('no-op', joinedGraph, noOp);
};

if (import.meta.main) {
    if (!process.argv.includes('--smoke')) {
        console.log('Usage: bun scripts/prototypes/google-drive-snapshots/demo.ts --smoke');
    } else {
        runSmoke();
    }
}
