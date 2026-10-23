import type { StartupPromptDescriptor } from './startup-prompts';

// The startup prompt queue's plain parts, without React: the hook (startup-prompts.ts) and the native apps' one-shot run
// share them, so a host bundle that runs the queue never pulls in React.

type RetireStartupPrompt = (descriptor: StartupPromptDescriptor, error: unknown, phase: 'eligible' | 'select' | 'present') => void;

/**
 * The highest-priority descriptor not yet [retired] whose `isEligible()` holds; one whose `isEligible()` throws is retired
 * through [retire] and skipped. Shared by the React queue and {@link runStartupPromptsOnce}.
 */
export function selectStartupPrompt(
    descriptors: StartupPromptDescriptor[],
    retired: Set<string>,
    retire: RetireStartupPrompt,
): StartupPromptDescriptor | null {
    const ordered = descriptors
        .filter((descriptor) => !retired.has(descriptor.id))
        .sort((a, b) => b.priority - a.priority);
    for (const descriptor of ordered) {
        let eligible = false;
        try {
            eligible = descriptor.isEligible();
        } catch (error) {
            retire(descriptor, error, 'eligible');
            continue;
        }
        if (eligible) return descriptor;
    }
    return null;
}

type StartupPromptOutcome = { opened: boolean | void } | { error: unknown };

/**
 * After the candidate's `delayMs`, runs its `present()` (raced against `presentTimeoutMs`, which aborts it) and reports the
 * outcome once to [settle]. The returned cancel aborts `present()` and clears both timers; [settle] still runs if a
 * `present()` already started, so the caller decides what a late outcome means.
 */
export function scheduleStartupPrompt(candidate: StartupPromptDescriptor, settle: (outcome: StartupPromptOutcome) => void): () => void {
    let presentTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const presentAbortController = new AbortController();
    const timer = setTimeout(() => {
        const presented = Promise.resolve().then(() => candidate.present(presentAbortController.signal));
        const raced = candidate.presentTimeoutMs === undefined
            ? presented
            : Promise.race<boolean | void>([
                presented,
                new Promise<false>((resolve) => {
                    presentTimeoutId = setTimeout(() => {
                        presentAbortController.abort();
                        resolve(false);
                    }, candidate.presentTimeoutMs);
                }),
            ]);
        raced
            .then((opened) => {
                if (presentTimeoutId !== undefined) clearTimeout(presentTimeoutId);
                settle({ opened });
            })
            .catch((error) => {
                if (presentTimeoutId !== undefined) clearTimeout(presentTimeoutId);
                settle({ error });
            });
    }, candidate.delayMs);
    return () => {
        presentAbortController.abort();
        clearTimeout(timer);
        if (presentTimeoutId !== undefined) clearTimeout(presentTimeoutId);
    };
}

/**
 * The queue run to the first prompt that opens, for a host whose inputs are all known when it starts (the native apps,
 * after the validated boot): the same selection, `onSelect`, delay, timeout and retirement as {@link useStartupPromptQueue}.
 * Resolves to the id that opened, or null when none did or [signal] aborted. [retired] is the session's set, kept by the
 * caller: this run adds every prompt it declines, fails or opens, so the next run (the hook goes on to the next prompt once
 * the open one is dismissed) never tries them again.
 */
export async function runStartupPromptsOnce(
    descriptors: StartupPromptDescriptor[],
    options: {
        onLog?: (error: unknown, context: { id: string; phase: string }) => void;
        retired?: Set<string>;
        signal?: AbortSignal;
    } = {},
): Promise<string | null> {
    const { onLog, signal } = options;
    const retired = options.retired ?? new Set<string>();
    const retire: RetireStartupPrompt = (descriptor, error, phase) => {
        retired.add(descriptor.id);
        try {
            onLog?.(error, { id: descriptor.id, phase });
            descriptor.onError?.(error, phase);
        } catch {
            // Never let error reporting break startup.
        }
    };
    while (!signal?.aborted) {
        const candidate = selectStartupPrompt(descriptors, retired, retire);
        if (!candidate) return null;
        try {
            candidate.onSelect?.();
        } catch (error) {
            retire(candidate, error, 'select');
            continue;
        }
        const outcome = await new Promise<StartupPromptOutcome | null>((resolve) => {
            const stop = () => { cancel(); resolve(null); };
            const cancel = scheduleStartupPrompt(candidate, (settled) => {
                signal?.removeEventListener('abort', stop);
                resolve(settled);
            });
            signal?.addEventListener('abort', stop, { once: true });
        });
        if (!outcome || signal?.aborted) return null;
        if ('error' in outcome) retire(candidate, outcome.error, 'present');
        else if (outcome.opened) {
            retired.add(candidate.id);
            return candidate.id;
        } else retired.add(candidate.id);
    }
    return null;
}
