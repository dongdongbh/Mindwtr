import type { AppData, Task, Project, TaskStatus } from './types';

export type TaskQueryOptions = {
    status?: TaskStatus | 'all';
    projectId?: string;
    excludeStatuses?: TaskStatus[];
    includeArchived?: boolean;
    includeDeleted?: boolean;
};

export type SearchTaskResult = Pick<
    Task,
    'id' | 'title' | 'status' | 'startTime' | 'dueDate' | 'projectId' | 'areaId' | 'tags' | 'contexts'
>;

export type SearchProjectResult = Pick<Project, 'id' | 'title' | 'status' | 'areaId'>;

export const SEARCH_RESULT_LIMIT = 200;

export type SearchResults = {
    tasks: SearchTaskResult[];
    projects: SearchProjectResult[];
    limited?: boolean;
    limit?: number;
};

export interface StorageAdapter {
    getData(): Promise<AppData>;
    saveData(data: AppData): Promise<void>;
    queryTasks?: (options: TaskQueryOptions) => Promise<Task[]>;
    searchAll?: (query: string) => Promise<SearchResults>;
}

// Default dummy adapter
export const noopStorage: StorageAdapter = {
    getData: async () => ({ tasks: [], projects: [], sections: [], areas: [], settings: {} }),
    saveData: async () => { },
};
