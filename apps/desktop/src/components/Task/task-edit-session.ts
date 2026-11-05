


const activeSessions = new Map<string, object>();
let activeExitRequest: ((action: () => void) => void) | null = null;

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
