import { isTauriRuntime } from './runtime';
import { invokeNative } from './tauri-invoke';


export { DEFAULT_WORKSPACE_ID, getActiveWorkspaceId } from './workspace-storage-scope';

export type WorkspaceInfo = {
    id: string;

    name: string;
    color: string | null;
    isDefault: boolean;

    dataDir: string;
};

export type WorkspaceList = {
    activeId: string;

    available: boolean;

    unreadable: boolean;
    workspaces: WorkspaceInfo[];
};

export function workspaceDisplayName(workspace: WorkspaceInfo, defaultLabel: string): string {
    return workspace.name.trim() || defaultLabel;
}

export async function listWorkspaces(): Promise<WorkspaceList | null> {
    if (!isTauriRuntime()) return null;
    return await invokeNative<WorkspaceList>('list_workspaces');
}


export const WORKSPACES_CHANGED_EVENT = 'mindwtr:workspaces-changed';

const announceChange = () => {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(WORKSPACES_CHANGED_EVENT));
};

export async function createWorkspace(name: string, color: string | null): Promise<WorkspaceInfo> {
    const created = await invokeNative<WorkspaceInfo>('create_workspace', { name, color });
    announceChange();
    return created;
}

export async function updateWorkspace(id: string, name: string, color: string | null): Promise<void> {
    await invokeNative('update_workspace', { id, name, color });
    announceChange();
}

export async function deleteWorkspace(id: string): Promise<void> {
    try {
        await invokeNative('delete_workspace', { id });
    } finally {

        announceChange();
    }
}

export class WorkspaceSaveError extends Error {
    constructor() {
        super('Pending changes could not be saved');
        this.name = 'WorkspaceSaveError';
    }
}

const SWITCH_FLUSH_TIMEOUT_MS = 10_000;


export async function switchWorkspace(
    id: string,
    flush: () => Promise<void>,
    timeoutMs = SWITCH_FLUSH_TIMEOUT_MS,
): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const saved = await Promise.race([
        flush().then(() => true, () => false),
        new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
        }),
    ]);
    clearTimeout(timer);
    if (!saved) throw new WorkspaceSaveError();
    await invokeNative('switch_workspace', { id });
}
