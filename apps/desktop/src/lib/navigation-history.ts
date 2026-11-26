import {
    getSavedTaxonomyTokens,
    getUsedTaskTokens,
    projectMatchesAreaFilterSelection,
    resolveAreaFilterSelection,
    resolveFeatureFlags,
    useTaskStore,
} from '@mindwtr/core';
import { useUiStore } from '../store/ui-store';
import { NO_CONTEXT_TOKEN, readContextsViewState, type ContextsViewSelection } from './contexts-view-state';
import { useObsidianStore } from '../store/obsidian-store';

export type NavigationDirection = -1 | 1;
export type NavigationInput = 'keyboard' | 'mouse' | 'gtk-mouse';

type Destination =
    | { kind: 'view'; view: string }
    | { kind: 'project'; view: 'projects'; projectId: string | null }
    | { kind: 'contexts'; view: 'contexts'; selection: ContextsViewSelection };

const HISTORY_LIMIT = 100;

export function readDestination(view: string): Destination {
    if (view === 'projects') {
        return { kind: 'project', view, projectId: useUiStore.getState().projectView.selectedProjectId };
    }
    if (view === 'contexts') {
        const { selectedContexts, matchMode } = readContextsViewState();
        return { kind: 'contexts', view, selection: { selectedContexts, matchMode } };
    }
    return { kind: 'view', view };
}

function sameDestination(left: Destination, right: Destination): boolean {
    if (left.kind === 'project' && right.kind === 'project') return left.projectId === right.projectId;
    if (left.kind === 'contexts' && right.kind === 'contexts') {
        const a = left.selection;
        const b = right.selection;
        return a.matchMode === b.matchMode
            && a.selectedContexts.length === b.selectedContexts.length
            && a.selectedContexts.every((token, index) => token === b.selectedContexts[index]);
    }
    return left.view === right.view;
}

export class DesktopNavigationHistory {
    private entries: Destination[];
    private index = 0;

    constructor(initial: Destination) {
        this.entries = [initial];
    }

    get current() {
        return this.entries[this.index];
    }

    record(destination: Destination) {
        if (sameDestination(this.current, destination)) return;
        this.entries.splice(this.index + 1);
        this.entries.push(destination);
        if (this.entries.length > HISTORY_LIMIT) this.entries.shift();
        this.index = this.entries.length - 1;
    }

    move(direction: NavigationDirection): Destination | undefined {
        const { projects, tasks, settings, areas } = useTaskStore.getState();
        let contextTokens: Set<string> | undefined;
        const exists = (destination: Destination): boolean => {
            if (destination.kind === 'project' && destination.projectId) {
                const project = projects.find(({ id }) => id === destination.projectId);
                return !!project && !project.deletedAt && projectMatchesAreaFilterSelection(
                    project, resolveAreaFilterSelection(settings.filters, areas), new Map(areas.map((area) => [area.id, area])),
                );
            }
            if (destination.kind === 'contexts' && destination.selection.selectedContexts.length > 0) {
                if (!contextTokens) {
                    contextTokens = new Set([
                        NO_CONTEXT_TOKEN,
                        ...getUsedTaskTokens(tasks, (task) => [...(task.contexts ?? []), ...(task.tags ?? [])], { includeAncestors: true }),
                        ...getSavedTaxonomyTokens(settings, 'context'), ...getSavedTaxonomyTokens(settings, 'tag'),
                    ]);
                }
                return destination.selection.selectedContexts.every((token) => contextTokens?.has(token));
            }
            if (destination.view.startsWith('savedSearch:')) {
                return settings.savedSearches?.some(({ id }) => destination.view === `savedSearch:${id}`) ?? false;
            }
            if (destination.view === 'timeline') return resolveFeatureFlags(settings).timeline;
            if (destination.view === 'obsidian') return useObsidianStore.getState().config.enabled;
            return true;
        };
        for (let index = this.index + direction; index >= 0 && index < this.entries.length; index += direction) {
            const destination = this.entries[index];
            if (sameDestination(this.current, destination) || !exists(destination)) continue;
            this.index = index;
            return destination;
        }
    }
}
