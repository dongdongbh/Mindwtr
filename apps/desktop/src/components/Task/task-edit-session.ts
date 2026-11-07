


const activeSessions = new Map<string, object>();
let activeExitRequest: ((action: () => void) => void) | null = null;
let activeFlush: (() => Promise<unknown>) | null = null;

export function registerTaskEditExitRequest(request: (action: () => void) => void): () => void {
    activeExitRequest = request;
    return () => {
        if (activeExitRequest === request) activeExitRequest = null;
    };
}

export function runAfterTaskEditExit(action: () => void): void {
    if (activeExitRequest) activeExitRequest(action);
    else action();
}

export function registerTaskEditFlush(flush: () => Promise<unknown>): () => void {
    activeFlush = flush;
    return () => {
        if (activeFlush === flush) activeFlush = null;
    };
}

export const TASK_EDIT_CLOSE_FLUSH_TIMEOUT_MS = 3000;

export async function flushForClose(flushStore: () => Promise<void>, onError?: (error: unknown) => void): Promise<void> {
    const flush = activeFlush;
    if (flush) {
        const editorFlush = Promise.resolve().then(flush).then(() => undefined, (error: unknown) => { onError?.(error); });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = await Promise.race([
            editorFlush.then(() => false),
            new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), TASK_EDIT_CLOSE_FLUSH_TIMEOUT_MS); }),
        ]);
        clearTimeout(timer);
        if (timedOut) {
            await flushStore();
            await editorFlush;
        }
    }
    await flushStore();
}

export function tryClaimTaskEditSession(taskId: string, owner: object): boolean {
    const current = activeSessions.get(taskId);
    if (current && current !== owner) return false;
    activeSessions.set(taskId, owner);
    return true;
}

export function releaseTaskEditSession(taskId: string, owner: object): void {
    if (activeSessions.get(taskId) === owner) {
        activeSessions.delete(taskId);
    }
}
