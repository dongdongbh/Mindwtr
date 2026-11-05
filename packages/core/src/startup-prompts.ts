import { useCallback, useEffect, useRef, useState } from 'react';

import { scheduleStartupPrompt, selectStartupPrompt } from './startup-prompt-run';


export interface StartupPromptDescriptor {

    id: string;

    priority: number;

    delayMs: number;


    isEligible: () => boolean;


    onSelect?: () => void;


    present: (signal: AbortSignal) => boolean | void | Promise<boolean | void>;


    presentTimeoutMs?: number;

    onError?: (error: unknown, phase: 'eligible' | 'select' | 'present') => void;
}

export interface StartupPromptQueue {

    openId: string | null;

    dismiss: (id: string) => void;

    forceOpen: (id: string) => void;

    closeAll: () => void;
}

export interface UseStartupPromptQueueOptions {

    enabled: boolean;

    gateOpen: boolean;

    descriptors: StartupPromptDescriptor[];


    signals?: unknown[];

    onLog?: (error: unknown, context: { id: string; phase: string }) => void;
}

export function useStartupPromptQueue(options: UseStartupPromptQueueOptions): StartupPromptQueue {
    const { enabled, gateOpen, descriptors, signals, onLog } = options;

    const [openId, setOpenId] = useState<string | null>(null);
    const [revision, setRevision] = useState(0);


    const descriptorsRef = useRef(descriptors);
    descriptorsRef.current = descriptors;

    const onLogRef = useRef(onLog);
    onLogRef.current = onLog;


    const retiredRef = useRef<Set<string>>(new Set());

    const pendingRef = useRef<string | null>(null);

    const bumpRevision = useCallback(() => setRevision((value) => value + 1), []);

    const retire = useCallback((descriptor: StartupPromptDescriptor, error: unknown, phase: 'eligible' | 'select' | 'present') => {
        retiredRef.current.add(descriptor.id);
        pendingRef.current = null;
        try {
            onLogRef.current?.(error, { id: descriptor.id, phase });
            descriptor.onError?.(error, phase);
        } catch {

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
