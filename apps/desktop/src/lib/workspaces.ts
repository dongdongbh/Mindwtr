import { isTauriRuntime } from './runtime';
import { invokeNative } from './tauri-invoke';

// Isolated desktop workspaces (#1473). The native side owns the list and the
// active id; switching restarts the app, so nothing here holds per-workspace
// state beyond what the current process opened with.

export { DEFAULT_WORKSPACE_ID, getActiveWorkspaceId } from './workspace-storage-scope';

export type WorkspaceInfo = {
    id: string;
    /** Empty for the default workspace until the user names it. */
    name: string;
    color: string | null;
    isDefault: boolean;
    /** The workspace's data folder, shown so a user can pass it to the MCP server or CLI. */
    dataDir: string;
};

export type WorkspaceList = {
    activeId: string;
    /** False when the profile folder could not be migrated this run. */
    available: boolean;
    /** workspaces.toml exists but could not be read; the default workspace opened. */
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

/** Fired on window after a workspace is added, renamed or deleted. */
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
        // A delete that removed the entry but not every file still changed the list.
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

/**
 * Saves pending local changes, then asks the native side to record the new
 * workspace and restart. No sync runs first: an unreachable server must never
 * block opening another workspace. A failed or hung save cancels the switch,
 * because the restart would drop the unsaved change.
 */
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
