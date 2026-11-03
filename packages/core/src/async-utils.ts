let sleepBypass: (() => boolean) | null = null;


export const setSleepBypass = (predicate: (() => boolean) | null): void => {
    sleepBypass = predicate;
};

export const sleep = (ms: number): Promise<void> => (
    sleepBypass?.()
        ? Promise.resolve()
        : new Promise<void>((resolve) => setTimeout(resolve, ms))
);

export const decodeUriSafe = (value: string): string => {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
};
