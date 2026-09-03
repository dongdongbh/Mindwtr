let sleepBypass: (() => boolean) | null = null;

/** Install a predicate that makes `sleep` resolve at once. React Native on
 *  Android pauses JavaScript timers while the app is in the background, so a
 *  retry back-off there would never wake up; with no UI to pace, waiting adds
 *  nothing. */
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
