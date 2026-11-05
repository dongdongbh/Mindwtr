import type { AppSearchDoc } from './app-search-projection';
import { buildAppSearchDelta, buildFullAppSearchIndex } from './app-search-projection';
import type { Area, Project, Task } from './types';


const REINDEX_DEBOUNCE_MS = 2_000;

type IndexedState = { tasks: Task[]; projects: Project[]; areas: Area[] };


export type AppSearchIndexingPorts = {

    isSupported(): boolean;
    readEnabled(): Promise<boolean>;
    readWipeOwed(): Promise<boolean>;

    markWipeOwed(): Promise<void>;
    clearWipeOwed(): Promise<void>;
    upsert(docs: AppSearchDoc[]): Promise<unknown>;
    remove(ids: string[]): Promise<unknown>;
    wipe(): Promise<unknown>;
    logInfo(message: string, extra: Record<string, string>): void;
    logWarn(message: string, extra: Record<string, string>): void;
    store: {
        getState(): IndexedState;
        subscribe(listener: (state: IndexedState, prevState: IndexedState) => void): () => void;
    };

    nameListener<L>(name: string, listener: L): L;

    scheme?: string;
};

export function createAppSearchIndexing(ports: AppSearchIndexingPorts) {
    let storeUnsubscribe: (() => void) | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let lastIndexedTasks: Task[] = [];
    let lastIndexedProjects: Project[] = [];
    let lastIndexedAreas: Area[] = [];
    const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

    const isArmed = (): boolean => storeUnsubscribe !== null;

    const applyDelta = async (prev: IndexedState, next: IndexedState): Promise<void> => {
        const delta = buildAppSearchDelta({
            prevTasks: prev.tasks,
            nextTasks: next.tasks,
            prevProjects: prev.projects,
            nextProjects: next.projects,
            prevAreas: prev.areas,
            nextAreas: next.areas,
            scheme: ports.scheme,
        });
        if (delta.upserts.length === 0 && delta.removeIds.length === 0) return;


        const [upsertResult, removeResult] = await Promise.allSettled([
            ports.upsert(delta.upserts),
            ports.remove(delta.removeIds),
        ]);
        for (const result of [upsertResult, removeResult]) {
            if (result.status !== 'rejected') continue;
            ports.logWarn('AppSearch index update failed; local data is unaffected', { error: errorText(result.reason) });
        }
    };


    const arm = (): void => {
        if (!ports.isSupported()) return;
        if (storeUnsubscribe) return;

        const seed = ports.store.getState();
        lastIndexedTasks = seed.tasks;
        lastIndexedProjects = seed.projects;
        lastIndexedAreas = seed.areas;

        storeUnsubscribe = ports.store.subscribe(ports.nameListener('app-search-reindex', (state: IndexedState, prevState: IndexedState) => {
            if (state.tasks === prevState.tasks && state.projects === prevState.projects && state.areas === prevState.areas) {
                return;
            }
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                debounceTimer = null;
                const next = { tasks: state.tasks, projects: state.projects, areas: state.areas };
                const prev = { tasks: lastIndexedTasks, projects: lastIndexedProjects, areas: lastIndexedAreas };
                lastIndexedTasks = next.tasks;
                lastIndexedProjects = next.projects;
                lastIndexedAreas = next.areas;
                void applyDelta(prev, next);
            }, REINDEX_DEBOUNCE_MS);
        }));
    };


    const disarm = (): void => {
        storeUnsubscribe?.();
        storeUnsubscribe = null;
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
    };


    let rebuilding = 0;
    const runFullReindex = async (): Promise<void> => {
        if (!ports.isSupported()) return;
        const state = ports.store.getState();
        const docs = buildFullAppSearchIndex({ tasks: state.tasks, projects: state.projects, areas: state.areas, scheme: ports.scheme });
        rebuilding += 1;
        try {

            await ports.wipe();
            await ports.upsert(docs);
        } catch (error) {
            ports.logWarn('AppSearch full reindex failed; local data is unaffected', { error: errorText(error) });
        } finally {
            rebuilding -= 1;
        }
    };


    const enable = async (): Promise<void> => {
        if (!ports.isSupported()) return;
        await runFullReindex();
        if (await ports.readEnabled()) {
            arm();
            return;
        }

        await ports.markWipeOwed().catch(() => undefined);
        try {
            await ports.wipe();
            await ports.clearWipeOwed();
        } catch (error) {
            ports.logWarn('AppSearch post-toggle-off wipe failed', { error: errorText(error) });
        }
    };


    const wipe = async (): Promise<void> => {
        disarm();
        if (!ports.isSupported()) return;
        try {
            await ports.wipe();
            if (rebuilding === 0) await ports.clearWipeOwed();
        } catch (error) {
            ports.logWarn('AppSearch wipe failed', { error: errorText(error) });
        }
    };


    const syncWithPreference = async (): Promise<void> => {
        if (!ports.isSupported()) return;
        const enabled = await ports.readEnabled();
        if (!enabled) {

            if (!(await ports.readWipeOwed())) return;
            let outcome = 'wiped';
            try {
                await ports.wipe();
                await ports.clearWipeOwed();
            } catch {
                outcome = 'failed';
            }
            ports.logInfo('AppSearch owed wipe finished at start', { releaseCheck: 'v1.3.7/app-search-owed-wipe', outcome });
            return;
        }
        if (isArmed()) return;

        await enable();
    };

    return { isArmed, arm, disarm, runFullReindex, enable, wipe, syncWithPreference };
}
