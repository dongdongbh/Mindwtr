import type { StartupPromptDescriptor } from './startup-prompts';


type RetireStartupPrompt = (descriptor: StartupPromptDescriptor, error: unknown, phase: 'eligible' | 'select' | 'present') => void;


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
