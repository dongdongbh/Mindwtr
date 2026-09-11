import {
    PROJECTS_SIDEBAR_COLLAPSED_WIDTH,
    PROJECTS_SIDEBAR_COMPACT_MAX_WIDTH,
    PROJECTS_SIDEBAR_DEFAULT_WIDTH,
    PROJECTS_SIDEBAR_MAX_WIDTH,
    PROJECTS_SIDEBAR_MIN_WIDTH,
    PROJECTS_SIDEBAR_WIDE_BREAKPOINT,
    PROJECTS_SIDEBAR_WIDE_WIDTH_RATIO,
    PROJECTS_SIDEBAR_WIDTH_STORAGE_KEY,
    PROJECTS_WORKSPACE_MIN_WIDTH,
} from '../../../constants/layout';
import { getWorkspaceCache } from '../../../lib/workspace-cache';

export {
    PROJECTS_SIDEBAR_COLLAPSED_WIDTH,
    PROJECTS_SIDEBAR_COMPACT_MAX_WIDTH,
    PROJECTS_SIDEBAR_DEFAULT_WIDTH,
    PROJECTS_SIDEBAR_MAX_WIDTH,
    PROJECTS_SIDEBAR_MIN_WIDTH,
    PROJECTS_WORKSPACE_MIN_WIDTH,
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function resolveStorage(storage?: StorageLike | null): StorageLike | null {
    if (storage !== undefined) return storage ?? null;
    return getWorkspaceCache();
}

export function getProjectsSidebarMaxWidth(containerWidth?: number) {
    if (typeof containerWidth !== 'number' || !Number.isFinite(containerWidth)) {
        return PROJECTS_SIDEBAR_MAX_WIDTH;
    }

    const resolvedContainerWidth = Math.floor(containerWidth);
    const workspaceLimitedWidth = resolvedContainerWidth - PROJECTS_WORKSPACE_MIN_WIDTH;
    const adaptiveMaxWidth = resolvedContainerWidth >= PROJECTS_SIDEBAR_WIDE_BREAKPOINT
        ? Math.max(
            PROJECTS_SIDEBAR_COMPACT_MAX_WIDTH,
            Math.floor(resolvedContainerWidth * PROJECTS_SIDEBAR_WIDE_WIDTH_RATIO),
        )
        : PROJECTS_SIDEBAR_COMPACT_MAX_WIDTH;

    return Math.max(
        PROJECTS_SIDEBAR_MIN_WIDTH,
        Math.min(PROJECTS_SIDEBAR_MAX_WIDTH, adaptiveMaxWidth, workspaceLimitedWidth),
    );
}

export function clampProjectsSidebarWidth(width: number, containerWidth?: number) {
    const maxWidth = getProjectsSidebarMaxWidth(containerWidth);
    const fallbackWidth = Math.min(PROJECTS_SIDEBAR_DEFAULT_WIDTH, maxWidth);

    if (!Number.isFinite(width)) return fallbackWidth;

    return Math.min(
        Math.max(Math.round(width), PROJECTS_SIDEBAR_MIN_WIDTH),
        maxWidth,
    );
}

export function loadProjectsSidebarWidth(storage?: StorageLike | null) {
    const target = resolveStorage(storage);
    if (!target) return PROJECTS_SIDEBAR_DEFAULT_WIDTH;

    try {
        const raw = target.getItem(PROJECTS_SIDEBAR_WIDTH_STORAGE_KEY);
        if (!raw) return PROJECTS_SIDEBAR_DEFAULT_WIDTH;
        return clampProjectsSidebarWidth(Number.parseFloat(raw));
    } catch {
        return PROJECTS_SIDEBAR_DEFAULT_WIDTH;
    }
}

export function saveProjectsSidebarWidth(width: number, storage?: StorageLike | null) {
    const target = resolveStorage(storage);
    if (!target) return;

    try {
        target.setItem(
            PROJECTS_SIDEBAR_WIDTH_STORAGE_KEY,
            String(clampProjectsSidebarWidth(width)),
        );
    } catch {
        // storage unavailable — fall back to in-memory only
    }
}
