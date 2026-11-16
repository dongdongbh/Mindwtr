import type { AppData, Task, Project, TaskStatus } from './types';

export type TaskQueryOptions = {
    status?: TaskStatus | 'all';
    projectId?: string;
    excludeStatuses?: TaskStatus[];
    includeArchived?: boolean;
    includeDeleted?: boolean;
    isFocusedToday?: boolean;
};

export type SearchTaskResult = Pick<
    Task,
    'id' | 'title' | 'status' | 'cancelledAt' | 'startTime' | 'dueDate' | 'projectId' | 'areaId' | 'tags' | 'contexts' | 'location'
>;

export type SearchProjectResult = Pick<Project, 'id' | 'title' | 'status' | 'cancelledAt' | 'areaId'>;

export const SEARCH_RESULT_LIMIT = 200;

export class StorageConflictError extends Error {
    constructor() { super('Stored data changed before the write'); }
}

export const withWebStorageLock = async <T>(operation: () => T | Promise<T>, options: { required?: boolean } = {}): Promise<T> => {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (typeof locks?.request === 'function') return locks.request('mindwtr-data:write', operation);
    if (options.required) throw new Error('Atomic browser storage is unavailable');
    return operation();
};

export type SearchResults = {
    tasks: SearchTaskResult[];
    projects: SearchProjectResult[];
    limited?: boolean;
    limit?: number;
};

export interface StorageAdapter {

    getData(options?: { rawTasks?: true }): Promise<AppData>;

    acknowledgeDataLoad?: (data: AppData) => void;

    saveData(data: AppData): Promise<AppData | void>;
    saveDataIfUnchanged?: (data: AppData, expectedData: AppData) => Promise<AppData | void>;
    saveTask?: (task: Task, snapshot?: AppData) => Promise<void>;
    queryTasks?: (options: TaskQueryOptions) => Promise<Task[]>;
    searchAll?: (query: string) => Promise<SearchResults>;
}


export const noopStorage: StorageAdapter = {
    getData: async () => ({ tasks: [], projects: [], sections: [], areas: [], people: [], settings: {} }),
    saveData: async () => { },
};
