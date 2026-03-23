export const getBulkActionFailureMessage = (error: unknown, fallback: string): string => {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const trimmed = message.trim();
    return trimmed || fallback;
};
