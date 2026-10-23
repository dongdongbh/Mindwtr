import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * One-at-a-time scheduler for the app's startup prompts (first-run onboarding,
 * maintainer announcement, donation ask, update reminder, and the dev/test
 * preview path). Shared by desktop and mobile; each app supplies its own gate
 * and its own descriptors.
 *
 * Design: this module owns *when* a prompt may open — the shared eligibility
 * gate, precedence between competing prompts, the per-prompt startup delay, and
 * session dismissal memory — but knows nothing about the store, the platform's
 * storage, or the prompt content. Each caller supplies a
 * {@link StartupPromptDescriptor} whose `isEligible`/`present`/dismissal side
 * effects close over the app's own state, so the queue stays a pure,
 * unit-testable scheduler with no app imports.
 *
 * Selection is strictly by descending `priority`: the highest-priority eligible
 * descriptor is scheduled; if it declines to open (`present()` resolves falsy,
 * e.g. no update is actually available) it is retired for the session and the
 * next-highest is tried. Only one descriptor is ever pending or open at a time.
 *
 * Because `onSelect` runs only once a descriptor has actually won selection, a
 * persistent side effect recorded there (e.g. "an update check happened today")
 * can never be burned by a prompt that never got its turn.
 */
export interface StartupPromptDescriptor {
    /** Stable identifier; also the value returned as `openId` when this prompt opens. */
    id: string;
    /** Higher wins when several descriptors are eligible at once. */
    priority: number;
    /** Delay in ms between selection and `present()` being invoked. */
    delayMs: number;
    /**
     * Pure predicate deciding whether this prompt currently wants to open. May
     * read storage snapshots supplied via the caller's closure.
     * If it throws it is treated as ineligible AND retired for the session
     * (matching the pre-extraction behavior where a failed state read set the
     * dismissed-in-session flag).
     */
    isEligible: () => boolean;
    /**
     * Synchronous side effect run once, immediately when this descriptor is
     * selected and before `delayMs` elapses (e.g. recording an update check).
     * A throw retires the descriptor for the session.
     */
    onSelect?: () => void;
    /**
     * Invoked after `delayMs`. Resolve truthy to actually open the prompt, falsy
     * to decline (the descriptor is then retired and the next candidate tried).
     * May be async. A throw retires the descriptor for the session. The signal is
     * aborted when the presentation times out or the selection is cancelled;
     * implementations must check it before committing late side effects.
     */
    present: (signal: AbortSignal) => boolean | void | Promise<boolean | void>;
    /**
     * Optional ceiling on how long an async `present()` may run before it is
     * treated as a decline. Prevents a hung `present()` (e.g. a network call with
     * no timeout) from holding the single slot for the session and starving
     * lower-priority prompts. Omit for no timeout (the default).
     */
    presentTimeoutMs?: number;
    /** Called on any thrown error, for logging. The queue handles retirement itself. */
    onError?: (error: unknown, phase: 'eligible' | 'select' | 'present') => void;
}

export interface StartupPromptQueue {
    /** Id of the prompt currently open, or null. */
    openId: string | null;
    /** Close a prompt and retire it for the remainder of the session. */
    dismiss: (id: string) => void;
    /** Force a prompt open regardless of gate/eligibility (dev/test preview path). */
    forceOpen: (id: string) => void;
    /** Close whatever is open without retiring anything (dev/test reset). */
    closeAll: () => void;
}

export interface UseStartupPromptQueueOptions {
    /** When false the queue never schedules anything (e.g. under test env). */
    enabled: boolean;
    /** The shared eligibility gate, evaluated once by the caller. */
    gateOpen: boolean;
    /** Prompt descriptors in any order; precedence comes from `priority`. */
    descriptors: StartupPromptDescriptor[];
    /**
     * Extra reactive values that affect eligibility (e.g. resolved install
     * source). Changing any of them re-runs selection, mirroring the dependency
     * arrays of the effects this hook replaces.
     */
    signals?: unknown[];
    /** Optional logger for thrown descriptor errors. */
    onLog?: (error: unknown, context: { id: string; phase: string }) => void;
}

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
 * The queue run once to its end, for a host whose inputs are all known when it starts (the native apps, after the validated
 * boot): the same selection, `onSelect`, delay, timeout and retirement as {@link useStartupPromptQueue}, resolving to the id
 * of the prompt that opened, or null when none did.
 */
export async function runStartupPromptsOnce(
    descriptors: StartupPromptDescriptor[],
    onLog?: (error: unknown, context: { id: string; phase: string }) => void,
): Promise<string | null> {
    const retired = new Set<string>();
    const retire: RetireStartupPrompt = (descriptor, error, phase) => {
        retired.add(descriptor.id);
        try {
            onLog?.(error, { id: descriptor.id, phase });
            descriptor.onError?.(error, phase);
        } catch {
            // Never let error reporting break startup.
        }
    };
    for (;;) {
        const candidate = selectStartupPrompt(descriptors, retired, retire);
        if (!candidate) return null;
        try {
            candidate.onSelect?.();
        } catch (error) {
            retire(candidate, error, 'select');
            continue;
        }
        const outcome = await new Promise<StartupPromptOutcome>((resolve) => { scheduleStartupPrompt(candidate, resolve); });
        if ('error' in outcome) retire(candidate, outcome.error, 'present');
        else if (outcome.opened) return candidate.id;
        else retired.add(candidate.id);
    }
}

export function useStartupPromptQueue(options: UseStartupPromptQueueOptions): StartupPromptQueue {
    const { enabled, gateOpen, descriptors, signals, onLog } = options;

    const [openId, setOpenId] = useState<string | null>(null);
    const [revision, setRevision] = useState(0);

    // Latest descriptors without making them an effect dependency: they are
    // recreated every render (fresh closures) but selection should only re-run
    // when the gate or an explicit signal changes, matching the old effects.
    const descriptorsRef = useRef(descriptors);
    descriptorsRef.current = descriptors;

    const onLogRef = useRef(onLog);
    onLogRef.current = onLog;

    // Descriptors retired for this session (dismissed, declined, or errored).
    const retiredRef = useRef<Set<string>>(new Set());
    // Id currently scheduled (timer pending) or resolving `present()`.
    const pendingRef = useRef<string | null>(null);

    const bumpRevision = useCallback(() => setRevision((value) => value + 1), []);

    const retire = useCallback((descriptor: StartupPromptDescriptor, error: unknown, phase: 'eligible' | 'select' | 'present') => {
        retiredRef.current.add(descriptor.id);
        pendingRef.current = null;
        try {
            onLogRef.current?.(error, { id: descriptor.id, phase });
            descriptor.onError?.(error, phase);
        } catch {
            // Never let error reporting break startup.
        }
    }, []);

    const selectCandidate = useCallback(
        (): StartupPromptDescriptor | null => selectStartupPrompt(descriptorsRef.current, retiredRef.current, retire),
        [retire],
    );

    useEffect(() => {
        if (!enabled || !gateOpen || openId || pendingRef.current) return;

        const candidate = selectCandidate();
        if (!candidate) return;

        try {
            candidate.onSelect?.();
        } catch (error) {
            retire(candidate, error, 'select');
            bumpRevision();
            return;
        }

        pendingRef.current = candidate.id;
        let cancelled = false;
        const cancel = scheduleStartupPrompt(candidate, (outcome) => {
            pendingRef.current = null;
            if (cancelled) return;
            if ('error' in outcome) {
                retire(candidate, outcome.error, 'present');
                bumpRevision();
            } else if (outcome.opened) {
                setOpenId(candidate.id);
            } else {
                retiredRef.current.add(candidate.id);
                bumpRevision();
            }
        });

        return () => {
            cancelled = true;
            cancel();
            pendingRef.current = null;
        };
    }, [enabled, gateOpen, openId, revision, selectCandidate, retire, bumpRevision, ...(signals ?? [])]);

    const dismiss = useCallback((id: string) => {
        retiredRef.current.add(id);
        pendingRef.current = null;
        setOpenId((current) => (current === id ? null : current));
    }, []);

    const forceOpen = useCallback((id: string) => {
        pendingRef.current = null;
        setOpenId(id);
    }, []);

    const closeAll = useCallback(() => {
        pendingRef.current = null;
        setOpenId(null);
        bumpRevision();
    }, [bumpRevision]);

    return { openId, dismiss, forceOpen, closeAll };
}
