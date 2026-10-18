export type DesktopVisibilitySyncAction = 'focus' | 'blur' | null;

/** Only the low-frequency heartbeat/lifecycle receipts bypass the Diagnostics toggle. */
export function logDesktopAutoSyncTrace(
    message: string,
    extra: Record<string, string> | undefined,
    visibility: DocumentVisibilityState,
    writeLog: (message: string, context: { scope: string; force?: boolean; extra?: Record<string, string> }) => unknown,
): void {
    let fields: string[] | undefined;
    if (message === 'Desktop auto sync lifecycle') {
        fields = ['phase', 'runtimeActive'];
    } else if (message === 'Auto sync periodic scheduled') {
        fields = ['delayMs'];
    } else if (message === 'Auto sync periodic fired') {
        fields = ['delayMs', 'latenessMs', 'runtimeActive', 'editorPause', 'outcome'];
    } else if (extra?.source === 'periodic') {
        if (message === 'Auto sync run start') fields = ['source', 'minIntervalMs'];
        if (message === 'Auto sync run complete') fields = ['source', 'success'];
        if (message === 'Auto sync run skipped') fields = ['source', 'reason'];
        if (message === 'Auto sync throttled') fields = ['source', 'waitMs', 'minIntervalMs'];
        if (message === 'Auto sync skipped during failure cooldown') fields = ['source', 'waitMs'];
    }
    if (!fields) {
        void writeLog(message, { scope: 'sync', extra });
        return;
    }
    // Keep the existing opt-in failure detail; the forced receipt never carries it.
    if (message === 'Auto sync run complete' && extra?.error) {
        void writeLog(message, { scope: 'sync', extra });
    }
    const receipt: Record<string, string> = {
        releaseCheck: 'v1.3.7/windowless-sync',
        documentVisibility: visibility,
    };
    for (const field of fields) {
        if (extra?.[field] !== undefined) receipt[field] = extra[field];
    }
    void writeLog(message, { scope: 'sync', force: true, extra: receipt });
}

export function isDesktopSyncRuntimeActive(isAppActive: boolean): boolean {
    return isAppActive;
}

export function resolveVisibilitySyncAction(
    visibilityState: DocumentVisibilityState
): DesktopVisibilitySyncAction {
    if (visibilityState === 'visible') return 'focus';
    if (visibilityState === 'hidden') return 'blur';
    return null;
}

export function shouldHandleDesktopManualSyncShortcut({
    isEditableTarget,
    isShortcut,
}: {
    isEditableTarget: boolean;
    isShortcut: boolean;
}): boolean {
    return isShortcut && !isEditableTarget;
}
