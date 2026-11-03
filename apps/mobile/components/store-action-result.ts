


export function isActionFailure(result: unknown): boolean {
    if (!result || typeof result !== 'object') return false;
    return (result as { success?: unknown }).success === false;
}


export function getActionFailureMessage(result: unknown): string | undefined {
    if (!result || typeof result !== 'object') return undefined;
    const { error } = result as { error?: unknown };
    return typeof error === 'string' && error.trim().length > 0 ? error.trim() : undefined;
}


export function getUnknownErrorMessage(error: unknown): string | undefined {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string' && error.trim().length > 0) return error.trim();
    return undefined;
}

export type StoreActionOutcome<T> =
    | { ok: true; result: T }
    | { ok: false; message?: string; cause?: unknown };


export async function settleStoreAction<T>(
    action: () => T | Promise<T>,
): Promise<StoreActionOutcome<T>> {
    try {
        const result = await action();
        if (isActionFailure(result)) {
            return { ok: false, message: getActionFailureMessage(result) };
        }
        return { ok: true, result };
    } catch (cause) {
        return { ok: false, message: getUnknownErrorMessage(cause), cause };
    }
}
